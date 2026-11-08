package billing

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
	"github.com/softmato/hostelpalika/server/internal/platform/plans"
)

// Settler is everything a settlement reaches outside billing. Wired by the
// router; each hook may be nil in tests, and a hook's failure is logged and
// never fails the settlement (the money has already arrived).
type Settler struct {
	*Service
	// GoLive is settleHostelReferrals.
	GoLive func(ctx context.Context, hostelID bson.ObjectID) error
	// GrantOwnerAccess is grantHostelOwnerAccess: a public owner becomes the hostel's admin.
	GrantOwnerAccess func(ctx context.Context, hostelID bson.ObjectID, actorID string) error
	Now              func() time.Time
}

// SettleOptions is settlePayment's options.
type SettleOptions struct {
	ActorID string
	// ExpectedHostelID refuses a payment of another hostel: an owner-scoped
	// route authorised a hostel, not a payment id.
	ExpectedHostelID string
	GatewayReference string
}

type settlingPayment struct {
	ID         bson.ObjectID `bson:"_id"`
	Amount     int64         `bson:"amount"`
	HostelID   bson.ObjectID `bson:"hostelId"`
	InvoiceID  bson.ObjectID `bson:"invoiceId"`
	Status     string        `bson:"status"`
	IsMocked   bool          `bson:"isMocked"`
	Method     string        `bson:"method"`
	SoftmatoTx *string       `bson:"softmatoTransactionNo"`
}

func (s *Settler) now() time.Time { return s.Now().UTC().Truncate(time.Millisecond) }

func (s *Settler) logFailure(ctx context.Context, action string, hostelID bson.ObjectID, err error) {
	slog.ErrorContext(ctx, action, "category", "payments", "hostelId", hostelID.Hex(), "err", err)
}

// SettlePayment is settlePayment: claims a PENDING or IN_REVIEW row exactly once,
// then issues the receipt, moves the invoice, credits the agent, starts or
// extends the plan, publishes the hostel, and audits. A row already settled
// returns the state having done nothing, so duplicate deliveries are harmless.
func (s *Settler) SettlePayment(ctx context.Context, paymentID bson.ObjectID, o SettleOptions) (*State, error) {
	pays := s.DB.Collection("subscriptionpayments")
	var pay settlingPayment
	err := pays.FindOne(ctx, bson.D{{Key: "_id", Value: paymentID}}).Decode(&pay)
	if errors.Is(err, mongo.ErrNoDocuments) || (err == nil && o.ExpectedHostelID != "" && pay.HostelID.Hex() != o.ExpectedHostelID) {
		// The same words either way: a caller probing ids learns nothing.
		return nil, payErr(404, "PAYMENT_NOT_FOUND", "Payment not found.")
	}
	if err != nil {
		return nil, err
	}
	// The invoice is checked before anything is written (P8-8): a voided one used
	// to be found after the payment was already SETTLED, settled against nothing.
	var inv planInvoice
	if err := s.DB.Collection("subscriptioninvoices").FindOne(ctx, bson.D{{Key: "_id", Value: pay.InvoiceID}}).Decode(&inv); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, payErr(404, "INVOICE_NOT_FOUND", "Invoice not found.")
		}
		return nil, err
	}
	if inv.Status == "VOID" {
		return nil, payErr(409, "INVOICE_VOID", "That invoice was voided, so it cannot take a payment.")
	}
	if pay.Status != "PENDING" && pay.Status != "IN_REVIEW" {
		return s.State(ctx, pay.HostelID)
	}
	// Softmato issues the receipt for money that went through them. Read before
	// the transaction: an HTTP call does not belong inside one.
	var receipt *receiptRead
	if pay.SoftmatoTx != nil && *pay.SoftmatoTx != "" {
		receipt, err = s.readSettledReceipt(ctx, *pay.SoftmatoTx)
		if err != nil {
			// The money is confirmed already; a slow document endpoint must not
			// withhold the service. The billing screen fetches it live.
			slog.ErrorContext(ctx, "softmato_receipt_read_failed", "category", "payments", "transactionNo", *pay.SoftmatoTx, "err", err)
			receipt = nil
		}
	}

	// The payment, its receipt number and the invoice's status land together
	// (R28): a failure part way used to leave a SETTLED payment the invoice never
	// counted, and the retry returned early because the claim was already taken.
	now := s.now()
	var receiptNumber string
	var outstanding int64
	errClaimed := errors.New("already settled")
	err = appmongo.InTx(ctx, s.DB, func(ctx context.Context) error {
		claimed, err := pays.UpdateOne(ctx, bson.D{{Key: "_id", Value: pay.ID}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"PENDING", "IN_REVIEW"}}}}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "settledAt", Value: now}, {Key: "status", Value: "SETTLED"}, {Key: "updatedAt", Value: now}}}})
		if err != nil {
			return err
		}
		if claimed.ModifiedCount == 0 {
			return errClaimed
		}
		// Ours is allocated either way so our own sequence stays complete.
		if receiptNumber, err = s.allocateReceiptNumber(ctx, inv.HostelID, now); err != nil {
			return err
		}
		set := bson.D{}
		if o.GatewayReference != "" {
			set = append(set, bson.E{Key: "gatewayReference", Value: o.GatewayReference})
		}
		docURL := s.documentURL("receipt", receiptNumber)
		if receipt != nil {
			if receipt.ProviderRef != "" {
				set = append(set, bson.E{Key: "gatewayReference", Value: receipt.ProviderRef})
			}
			if receipt.Provider != "" {
				set = append(set, bson.E{Key: "softmatoProvider", Value: receipt.Provider})
			}
			docURL = receipt.DocumentURL
		}
		set = append(set, bson.E{Key: "receiptDocumentUrl", Value: docURL}, bson.E{Key: "receiptIssuedAt", Value: now}, bson.E{Key: "receiptNumber", Value: receiptNumber}, bson.E{Key: "updatedAt", Value: now})
		if _, err := pays.UpdateOne(ctx, bson.D{{Key: "_id", Value: pay.ID}}, bson.D{{Key: "$set", Value: set}}); err != nil {
			return err
		}
		// Only money Softmato never saw keeps the receipt this app prints.
		if receipt == nil && pay.Method != "SOFTMATO" && (pay.SoftmatoTx == nil || *pay.SoftmatoTx == "") {
			var row planPayment
			if err := pays.FindOne(ctx, bson.D{{Key: "_id", Value: pay.ID}}).Decode(&row); err != nil {
				return err
			}
			if _, err := s.localReceiptNumber(ctx, &row); err != nil {
				return err
			}
		}
		if outstanding, err = s.outstanding(ctx, &inv); err != nil {
			return err
		}
		status := "PARTIAL"
		if outstanding <= 0 {
			status = "PAID"
		}
		_, err = s.DB.Collection("subscriptioninvoices").UpdateOne(ctx, bson.D{{Key: "_id", Value: inv.ID}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: status}, {Key: "updatedAt", Value: now}}}})
		return err
	})
	if errors.Is(err, errClaimed) {
		return s.State(ctx, pay.HostelID)
	}
	if err != nil {
		return nil, err
	}
	if outstanding <= 0 {
		earns, err := s.earnsCommission(ctx, &inv)
		if err != nil {
			return nil, err
		}
		if earns {
			s.creditTeamCommission(ctx, &inv, now)
		}
	}
	dueBy, err := s.applySettlement(ctx, &inv, outstanding, o.ActorID, now)
	if err != nil {
		return nil, err
	}
	s.receiptEmail(ctx, &pay, &inv, outstanding, dueBy, receiptNumber)

	actor, actorType := bson.ObjectID{}, "SYSTEM"
	if o.ActorID != "" {
		if id, err := bson.ObjectIDFromHex(o.ActorID); err == nil {
			actor, actorType = id, "USER"
		}
	}
	if err := s.Audit.Write(ctx, audit.Entry{ActorID: actor, ActorType: actorType, Action: "SUBSCRIPTION_PAYMENT_SETTLED", EntityType: "SubscriptionPayment", EntityID: pay.ID.Hex(), HostelID: inv.HostelID,
		Metadata: bson.D{{Key: "amount", Value: pay.Amount}, {Key: "invoiceNumber", Value: inv.InvoiceNumber}, {Key: "method", Value: pay.Method}, {Key: "mocked", Value: pay.IsMocked},
			{Key: "outstandingAfter", Value: outstanding}, {Key: "receiptNumber", Value: receiptNumber}}}); err != nil {
		return nil, err
	}
	return s.State(ctx, inv.HostelID)
}

// allocateReceiptNumber is `SRC-0001-4F2A`: per hostel, lifetime.
func (s *Settler) allocateReceiptNumber(ctx context.Context, hostelID bson.ObjectID, now time.Time) (string, error) {
	var counter struct {
		Sequence int64 `bson:"sequence"`
	}
	err := s.DB.Collection("receiptcounters").FindOneAndUpdate(ctx,
		bson.D{{Key: "hostelId", Value: hostelID}, {Key: "kind", Value: "SUBSCRIPTION_RECEIPT"}, {Key: "period", Value: "LIFETIME"}},
		bson.D{{Key: "$inc", Value: bson.D{{Key: "sequence", Value: 1}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: now}}}, {Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&counter)
	if err != nil {
		return "", err
	}
	hex := hostelID.Hex()
	return fmt.Sprintf("SRC-%04d-%s", max(counter.Sequence, 1), strings.ToUpper(hex[len(hex)-4:])), nil
}

type receiptRead struct {
	DocumentURL, Provider, ProviderRef string
}

// readSettledReceipt is billing-gateway's: nil when Softmato has none yet.
func (s *Settler) readSettledReceipt(ctx context.Context, transactionNo string) (*receiptRead, error) {
	if s.Softmato == nil {
		return nil, nil
	}
	r, err := s.Softmato.GetReceipt(ctx, transactionNo)
	if err != nil || r == nil {
		return nil, err
	}
	out := &receiptRead{DocumentURL: s.documentURL("receipt", transactionNo), Provider: r.Provider}
	if r.ProviderRef != nil {
		out.ProviderRef = *r.ProviderRef
	}
	return out, nil
}

// earnsCommission: the setup fee does; a team hostel filed before the setup fee
// existed earns it on its first plan invoice instead.
func (s *Settler) earnsCommission(ctx context.Context, inv *planInvoice) (bool, error) {
	if inv.Kind == "SETUP_FEE" {
		return true, nil
	}
	if inv.Source != "TEAM" {
		return false, nil
	}
	n, err := s.DB.Collection("subscriptioninvoices").CountDocuments(ctx, bson.D{{Key: "kind", Value: "SETUP_FEE"}, {Key: "subscriptionId", Value: inv.SubscriptionID}}, options.Count().SetLimit(1))
	return n == 0, err
}

// creditTeamCommission: once per hostel (a partial unique index), never able to
// fail the settlement.
func (s *Settler) creditTeamCommission(ctx context.Context, inv *planInvoice, now time.Time) {
	var sub struct {
		AgentID *bson.ObjectID `bson:"agentId"`
		Source  string         `bson:"source"`
	}
	err := s.DB.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "_id", Value: inv.SubscriptionID}}, options.FindOne().SetProjection(bson.D{{Key: "agentId", Value: 1}, {Key: "source", Value: 1}})).Decode(&sub)
	if errors.Is(err, mongo.ErrNoDocuments) || (err == nil && (sub.AgentID == nil || sub.Source != "TEAM")) {
		return
	}
	if err == nil {
		rate := s.Config.OperationsTyped(ctx).TeamCommissionPercent
		amount := math.Floor(float64(inv.Amount)*rate+0.5) / 100
		if amount <= 0 {
			return
		}
		_, err = s.DB.Collection("teamwalletentries").InsertOne(ctx, bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "agentId", Value: *sub.AgentID}, {Key: "type", Value: "COMMISSION"},
			{Key: "amount", Value: amount}, {Key: "hostelId", Value: inv.HostelID}, {Key: "subscriptionId", Value: inv.SubscriptionID}, {Key: "invoiceId", Value: inv.ID},
			{Key: "base", Value: inv.Amount}, {Key: "ratePercent", Value: rate}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}})
		if mongo.IsDuplicateKeyError(err) {
			return // already credited for this hostel, which is the point
		}
	}
	if err != nil {
		slog.ErrorContext(ctx, "team_commission_credit_failed", "category", "payments", "subscriptionId", inv.SubscriptionID.Hex(), "err", err)
	}
}

type settlingSubscription struct {
	ID               bson.ObjectID `bson:"_id"`
	ActivatedAt      *time.Time    `bson:"activatedAt"`
	CurrentPeriodEnd *time.Time    `bson:"currentPeriodEnd"`
	Cycle            *string       `bson:"cycle"`
	CycleMonths      *int          `bson:"cycleMonths"`
	PlanID           *string       `bson:"planId"`
	Source           string        `bson:"source"`
}

// applySettlement moves the subscription and, where the rules allow, the
// hostel. A public hostel publishes when paid in full; a team-filed one is
// already published and carries a due while it owes.
func (s *Settler) applySettlement(ctx context.Context, inv *planInvoice, outstanding int64, actorID string, now time.Time) (*time.Time, error) {
	subs := s.DB.Collection("hostelsubscriptions")
	var sub settlingSubscription
	if err := subs.FindOne(ctx, bson.D{{Key: "_id", Value: inv.SubscriptionID}}).Decode(&sub); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil
		}
		return nil, err
	}
	// A setup fee buys no time on the plan and publishes nothing.
	if inv.Kind == "SETUP_FEE" {
		return nil, nil
	}
	if outstanding <= 0 && inv.Lifetime {
		if _, err := subs.UpdateOne(ctx, bson.D{{Key: "_id", Value: sub.ID}}, bson.D{{Key: "$set", Value: bson.D{
			{Key: "activatedAt", Value: now}, {Key: "currentPeriodEnd", Value: LifetimePeriodEnd}, {Key: "cycle", Value: inv.Cycle}, {Key: "cycleMonths", Value: inv.CycleMonths},
			{Key: "cycleTotal", Value: inv.Amount}, {Key: "dueBy", Value: nil}, {Key: "freeMonths", Value: 0}, {Key: "freeUntil", Value: nil}, {Key: "lifetime", Value: true},
			{Key: "lifetimeSince", Value: now}, {Key: "planId", Value: inv.PlanID}, {Key: "planName", Value: inv.PlanName}, {Key: "status", Value: "ACTIVE"}, {Key: "updatedAt", Value: now}}}}); err != nil {
			return nil, err
		}
		actor, actorType := actorOf(actorID)
		if err := s.Audit.Write(ctx, audit.Entry{ActorID: actor, ActorType: actorType, Action: "SUBSCRIPTION_LIFETIME_STARTED", EntityType: "HostelSubscription", EntityID: sub.ID.Hex(), HostelID: inv.HostelID,
			Metadata: bson.D{{Key: "amount", Value: inv.Amount}, {Key: "invoiceNumber", Value: inv.InvoiceNumber}, {Key: "planId", Value: inv.PlanID}}}); err != nil {
			return nil, err
		}
		return nil, s.goLive(ctx, inv.HostelID, sub.Source, actorID, now)
	}
	if outstanding <= 0 {
		// A renewal bought on another plan or cycle becomes the plan once paid.
		if (sub.PlanID == nil || inv.PlanID != *sub.PlanID || sub.Cycle == nil || inv.Cycle != *sub.Cycle) && s.invoicePlanWins(ctx, &sub, inv) {
			months := inv.CycleMonths
			if months == 0 {
				months = 1
			}
			if _, err := subs.UpdateOne(ctx, bson.D{{Key: "_id", Value: sub.ID}}, bson.D{{Key: "$set", Value: bson.D{
				{Key: "cycle", Value: inv.Cycle}, {Key: "cycleMonths", Value: inv.CycleMonths}, {Key: "cycleTotal", Value: inv.Amount},
				{Key: "monthlyRate", Value: int64(math.Floor(float64(inv.Amount)/float64(months) + 0.5))}, {Key: "planId", Value: inv.PlanID}, {Key: "planName", Value: inv.PlanName}, {Key: "updatedAt", Value: now}}}}); err != nil {
				return nil, err
			}
		}
		if err := s.StartPlanPeriod(ctx, inv.SubscriptionID, inv.CycleMonths, inv.PeriodEnd, now); err != nil {
			return nil, err
		}
		if _, err := subs.UpdateOne(ctx, bson.D{{Key: "_id", Value: sub.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "dueBy", Value: nil}, {Key: "status", Value: "ACTIVE"}, {Key: "updatedAt", Value: now}}}}); err != nil {
			return nil, err
		}
		return nil, s.goLive(ctx, inv.HostelID, sub.Source, actorID, now)
	}
	// Still owed: only a team registration lives here, on the due it was raised with.
	if sub.Source != "TEAM" {
		return nil, nil
	}
	due := inv.DueAt
	if due == nil {
		from := now
		if inv.IssuedAt != nil {
			from = *inv.IssuedAt
		}
		d := bs.DayEnd(from, s.Config.OperationsTyped(ctx).SubscriptionDueGraceDays)
		due = &d
	}
	_, err := subs.UpdateOne(ctx, bson.D{{Key: "_id", Value: sub.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "dueBy", Value: *due}, {Key: "status", Value: "PAST_DUE"}, {Key: "updatedAt", Value: now}}}})
	return due, err
}

func actorOf(actorID string) (bson.ObjectID, string) {
	if id, err := bson.ObjectIDFromHex(actorID); err == nil {
		return id, "USER"
	}
	return bson.ObjectID{}, "SYSTEM"
}

// invoicePlanWins is planAfterPayment === "invoice": the higher plan, or on the
// same plan the longer cycle.
func (s *Settler) invoicePlanWins(ctx context.Context, sub *settlingSubscription, inv *planInvoice) bool {
	if sub.PlanID == nil || *sub.PlanID == "" {
		return true
	}
	catalog, err := s.catalog(ctx)
	if err != nil {
		catalog = plans.Catalog{}
	}
	bought, held := plans.PlanRank(catalog, inv.PlanID), plans.PlanRank(catalog, *sub.PlanID)
	if bought != held {
		return bought > held
	}
	current := 0
	if sub.CycleMonths != nil {
		current = *sub.CycleMonths
	}
	return inv.CycleMonths > current
}

// goLive is publishForSubscription then openHostelAfterPayment. Only the
// publish can fail the settlement; the rest is logged, as in TS.
func (s *Settler) goLive(ctx context.Context, hostelID bson.ObjectID, source, actorID string, now time.Time) error {
	var actor *bson.ObjectID
	if id, err := bson.ObjectIDFromHex(actorID); err == nil {
		actor = &id
	}
	if err := s.publishForSubscription(ctx, hostelID, actor); err != nil {
		return err
	}
	if err := s.liftSuspension(ctx, hostelID, actorID, now); err != nil {
		s.logFailure(ctx, "hostel_suspension_lift_failed", hostelID, err)
	}
	if s.GoLive != nil {
		if err := s.GoLive(ctx, hostelID); err != nil {
			s.logFailure(ctx, "hostel_referral_settle_failed", hostelID, err)
		}
	}
	if source == "TEAM" || s.GrantOwnerAccess == nil {
		return nil
	}
	if err := s.GrantOwnerAccess(ctx, hostelID, actorID); err != nil {
		s.logFailure(ctx, "hostel_owner_access_grant_failed", hostelID, err)
	}
	return nil
}

// liftSuspension is liftHostelSuspension(cause PAID): the hostel and its branches.
func (s *Settler) liftSuspension(ctx context.Context, hostelID bson.ObjectID, actorID string, now time.Time) error {
	hostels := s.DB.Collection("hostels")
	clear := bson.D{{Key: "$set", Value: bson.D{{Key: "suspension.graceEndsAt", Value: nil}, {Key: "suspension.reason", Value: nil},
		{Key: "suspension.startedAt", Value: nil}, {Key: "suspension.startedBy", Value: nil}, {Key: "updatedAt", Value: now}}}}
	var before struct {
		Suspension *struct {
			StartedAt   *time.Time `bson:"startedAt"`
			GraceEndsAt *time.Time `bson:"graceEndsAt"`
			Reason      *string    `bson:"reason"`
		} `bson:"suspension"`
	}
	err := hostels.FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: hostelID}, {Key: "suspension.startedAt", Value: bson.D{{Key: "$ne", Value: nil}}}}, clear,
		options.FindOneAndUpdate().SetProjection(bson.D{{Key: "suspension", Value: 1}})).Decode(&before)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := hostels.UpdateMany(ctx, bson.D{{Key: "parentHostelId", Value: hostelID}}, clear); err != nil {
		return err
	}
	s.Cache.PublicChanged(ctx)
	meta := bson.D{{Key: "cause", Value: "PAID"}}
	var grace, started, reason any
	stage := ""
	if sp := before.Suspension; sp != nil {
		if sp.GraceEndsAt != nil {
			grace = *sp.GraceEndsAt
		}
		if sp.StartedAt != nil {
			started = *sp.StartedAt
		}
		if sp.Reason != nil {
			reason = *sp.Reason
		}
		stage = suspensionStage(sp.StartedAt, sp.GraceEndsAt, now)
	}
	// Audit drops nil values as mongoose drops undefined, but TS writes these
	// as null; bson.Null keeps them.
	orNull := func(v any) any {
		if v == nil {
			return bson.Null{}
		}
		return v
	}
	var stageV any = bson.Null{}
	if stage != "" {
		stageV = stage
	}
	meta = append(meta, bson.E{Key: "graceEndsAt", Value: orNull(grace)}, bson.E{Key: "reason", Value: orNull(reason)}, bson.E{Key: "stage", Value: stageV}, bson.E{Key: "startedAt", Value: orNull(started)})
	actor, _ := actorOf(actorID)
	return s.Audit.Write(ctx, audit.Entry{ActorID: actor, ActorType: map[bool]string{true: "SYSTEM", false: "USER"}[actor.IsZero()], Action: "HOSTEL_SUSPENSION_LIFTED",
		EntityType: "Hostel", EntityID: hostelID.Hex(), HostelID: hostelID, Metadata: meta})
}

func suspensionStage(startedAt, graceEndsAt *time.Time, now time.Time) string {
	if startedAt == nil || graceEndsAt == nil || now.Before(*startedAt) {
		return ""
	}
	if now.Before(*graceEndsAt) {
		return "PRE_SUSPENSION"
	}
	return "SUSPENDED"
}

// receiptEmail is onPaymentSettled: money Softmato saw is receipted by their
// own mail, so only the rest gets ours, with its paperwork attached.
func (s *Settler) receiptEmail(ctx context.Context, pay *settlingPayment, inv *planInvoice, outstanding int64, dueBy *time.Time, receiptRef string) {
	if s.Mail == nil || (pay.SoftmatoTx != nil && *pay.SoftmatoTx != "") {
		return
	}
	to, hostelName, err := s.ownerEmail(ctx, inv.HostelID)
	if err != nil || to == "" {
		if err != nil {
			slog.WarnContext(ctx, "subscription_receipt_email_failed", "category", "email", "err", err)
		}
		return
	}
	scope := []string{inv.HostelID.Hex()}
	var files []email.Attachment
	for _, doc := range []struct {
		kind, number string
		read         func(context.Context, string, []string) (*resolvedDoc, error)
	}{{"receipt", receiptRef, s.resolveReceipt}, {"invoice", inv.InvoiceNumber, s.resolveInvoice}} {
		d, err := doc.read(ctx, doc.number, scope)
		if err != nil {
			slog.WarnContext(ctx, "subscription_"+doc.kind+"_attachment_failed", "category", "email", "number", doc.number, "err", err)
			continue
		}
		if d != nil {
			files = append(files, email.Attachment{Content: d.data, Filename: d.name})
		}
	}
	due := ""
	if dueBy != nil {
		due = email.EmailDate(*dueBy)
	}
	m := email.SubscriptionReceipt(pay.Amount, len(files) > 0, due, hostelName, inv.InvoiceNumber, pay.Method, outstanding, inv.PlanName)
	if r := s.Mail.Send(ctx, email.Message{Category: m.Category, To: []string{to}, Subject: m.Subject, HTML: m.HTML, Attachments: files}); !r.Sent {
		slog.WarnContext(ctx, "subscription_receipt_email_failed", "category", "email", "reason", r.Reason)
	}
}

// ownerEmail is resolveOwnerEmail: the owner's address, else the hostel's contact.
func (s *Settler) ownerEmail(ctx context.Context, hostelID bson.ObjectID) (string, string, error) {
	var h struct {
		Contact *struct {
			Email string `bson:"email"`
		} `bson:"contact"`
		Name    string         `bson:"name"`
		OwnerID *bson.ObjectID `bson:"ownerId"`
	}
	err := s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostelID}}, options.FindOne().SetProjection(bson.D{{Key: "ownerId", Value: 1}, {Key: "contact", Value: 1}, {Key: "name", Value: 1}})).Decode(&h)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return "", "", err
	}
	if h.OwnerID != nil {
		var u struct {
			Email string `bson:"email"`
		}
		err := s.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: *h.OwnerID}}, options.FindOne().SetProjection(bson.D{{Key: "email", Value: 1}})).Decode(&u)
		if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
			return "", "", err
		}
		if u.Email != "" {
			return u.Email, h.Name, nil
		}
	}
	if h.Contact != nil {
		return h.Contact.Email, h.Name, nil
	}
	return "", h.Name, nil
}
