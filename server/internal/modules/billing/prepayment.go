package billing

import (
	"context"
	"errors"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/plans"
	"github.com/softmato/hostelpalika/server/internal/platform/softmato"
)

// A team prepayment is money a field agent takes online before the hostel
// exists: the setup fee (or the lifetime price, in full or in part) on its own
// Softmato document, claimed by the registration that publishes the hostel.

type Prepayment struct {
	ID       bson.ObjectID `bson:"_id"`
	AgentID  bson.ObjectID `bson:"agentId"`
	Amount   int64         `bson:"amount"`
	BilledTo struct {
		Email      *string `bson:"email"`
		HostelName *string `bson:"hostelName"`
		Name       *string `bson:"name"`
	} `bson:"billedTo"`
	ChargeAmount  *int64        `bson:"chargeAmount"`
	Cycle         string        `bson:"cycle"`
	CycleMonths   int           `bson:"cycleMonths"`
	Draft         bson.RawValue `bson:"draft"`
	HostelID      bson.ObjectID `bson:"hostelId"`
	InvoiceNumber string        `bson:"invoiceNumber"`
	Kind          *string       `bson:"kind"`
	PaidAt        *time.Time    `bson:"paidAt"`
	PlanID        string        `bson:"planId"`
	PlanName      string        `bson:"planName"`
	Provider      *string       `bson:"provider"`
	SoftmatoID    *string       `bson:"softmatoInvoiceId"`
	SoftmatoNo    *string       `bson:"softmatoInvoiceNo"`
	Status        string        `bson:"status"`
	TransactionNo *string       `bson:"transactionNo"`
}

func (r *Prepayment) kind() string {
	if r.Kind == nil || *r.Kind == "" {
		return "PLAN"
	}
	return *r.Kind
}

func (r *Prepayment) charge() int64 {
	if r.ChargeAmount != nil {
		return *r.ChargeAmount
	}
	return r.Amount
}

// Charge is what the payer is asked for: a part payment, or the whole amount.
func (r *Prepayment) Charge() int64 { return r.charge() }

func (r *Prepayment) view() ordered.Map {
	var ref any
	if r.TransactionNo != nil {
		ref = *r.TransactionNo
	} else if r.SoftmatoNo != nil {
		ref = *r.SoftmatoNo
	}
	var provider any
	if r.Provider != nil {
		provider = *r.Provider
	}
	return ordered.Map{{Key: "amount", Value: r.Amount}, {Key: "chargeAmount", Value: r.charge()}, {Key: "cycle", Value: r.Cycle}, {Key: "id", Value: r.ID.Hex()}, {Key: "kind", Value: r.kind()},
		{Key: "paidAt", Value: isoOrNil(r.PaidAt)}, {Key: "planId", Value: r.PlanID}, {Key: "planName", Value: r.PlanName}, {Key: "provider", Value: provider}, {Key: "reference", Value: ref}, {Key: "status", Value: r.Status}}
}

func prepaymentNotFound() error {
	return payErr(404, "PREPAYMENT_NOT_FOUND", "That payment was not found.")
}

func (s *Settler) prepayments() *mongo.Collection { return s.DB.Collection("teamprepayments") }

// loadPrepayment: an agent sees only their own; a superadmin any.
func (s *Settler) loadPrepayment(ctx context.Context, id string, p *authz.Principal) (*Prepayment, error) {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return nil, prepaymentNotFound()
	}
	var row Prepayment
	if err := s.prepayments().FindOne(ctx, bson.D{{Key: "_id", Value: oid}}).Decode(&row); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, prepaymentNotFound()
		}
		return nil, err
	}
	if p.Role != authz.Superadmin && row.AgentID.Hex() != p.UserID {
		return nil, prepaymentNotFound()
	}
	return &row, nil
}

func (s *Settler) reloadPrepayment(ctx context.Context, id bson.ObjectID) (*Prepayment, error) {
	var row Prepayment
	return &row, s.prepayments().FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&row)
}

// refreshPrepayment asks Softmato about an OPEN row, so a payment whose webhook
// is late still reads as paid.
func (s *Settler) refreshPrepayment(ctx context.Context, row *Prepayment) (*Prepayment, error) {
	if row.Status != "OPEN" || row.SoftmatoNo == nil || s.Softmato == nil {
		return row, nil
	}
	detail, _ := s.Softmato.GetInvoice(ctx, *row.SoftmatoNo)
	if detail == nil || detail.Status != "paid" {
		return row, nil
	}
	paidAt := s.now()
	var provider, tx *string
	if len(detail.Payments) > 0 {
		pay := detail.Payments[0]
		if t, err := time.Parse(time.RFC3339Nano, pay.PaidAt); err == nil {
			paidAt = t.UTC()
		}
		provider = pay.Provider
		if pay.TransactionID != "" {
			tx = &pay.TransactionID
		}
	}
	if err := s.MarkTeamPrepaymentPaid(ctx, row.ID, paidAt, provider, tx); err != nil {
		return nil, err
	}
	return s.reloadPrepayment(ctx, row.ID)
}

type PrepaymentIn struct {
	Area, Cycle, Email, HostelName, OwnerName, Phone, PlanID, PrepaymentID string
	Amount                                                                 *int64
	Lifetime                                                               bool
	Draft                                                                  any // nil when absent
}

// OpenTeamPrepayment is openTeamPrepayment: the agent's "Take payment now". An
// open row for the same money is reused; a different amount or kind supersedes it.
func (s *Settler) OpenTeamPrepayment(ctx context.Context, in PrepaymentIn, p *authz.Principal, outbound string, step func(string)) (ordered.Map, error) {
	if s.Softmato == nil {
		return nil, payErr(503, "ONLINE_PAYMENT_UNAVAILABLE", "Online payment is not set up on this deployment yet.")
	}
	step("invoice")
	var priced Priced
	var err error
	if in.Lifetime {
		priced, err = s.PriceLifetime(ctx, in.PlanID, true)
	} else {
		priced, err = s.PricePlan(ctx, in.PlanID, plans.Cycle(in.Cycle))
	}
	if err != nil {
		return nil, err
	}
	setupFee := int64(s.Config.OperationsTyped(ctx).TeamSetupFee)
	fee, kind := setupFee, "SETUP_FEE"
	if in.Amount != nil {
		fee = *in.Amount
	}
	var part *int64
	if in.Lifetime {
		fee, kind = priced.CycleTotal, "LIFETIME"
		if in.Amount != nil && *in.Amount < priced.CycleTotal {
			part = in.Amount
		}
		if in.Amount != nil && *in.Amount > priced.CycleTotal {
			return nil, payErr(422, "PREPAYMENT_ABOVE_PRICE", fmt.Sprintf("The lifetime price is Rs %d. Take that or less now.", priced.CycleTotal))
		}
	} else if fee > setupFee || fee <= 0 {
		return nil, payErr(422, "PREPAYMENT_ABOVE_PRICE", fmt.Sprintf("The setup fee is 1 to Rs %d. It can't be more than that.", setupFee))
	}
	var previous *Prepayment
	if in.PrepaymentID != "" {
		loaded, err := s.loadPrepayment(ctx, in.PrepaymentID, p)
		if err != nil {
			return nil, err
		}
		if previous, err = s.refreshPrepayment(ctx, loaded); err != nil {
			return nil, err
		}
	}
	if previous != nil && (previous.Status == "PAID" || previous.Status == "CLAIMED") {
		msg := "That payment already belongs to a published hostel."
		if previous.Status == "PAID" {
			msg = "The setup fee is already paid. Carry on to Review & publish."
			if previous.kind() == "LIFETIME" {
				msg = "The lifetime payment is already in. Carry on to Review & publish."
			}
		}
		return nil, payErr(409, "PREPAYMENT_ALREADY_PAID", msg)
	}
	samePart := func(a, b *int64) bool { return (a == nil && b == nil) || (a != nil && b != nil && *a == *b) }
	now := s.now()
	row := previous
	if row == nil || row.Status != "OPEN" || row.kind() != kind || row.Amount != fee || !samePart(row.ChargeAmount, part) || (in.Lifetime && row.PlanID != priced.PlanID) {
		hostelID := bson.NewObjectID()
		if previous != nil {
			hostelID = previous.HostelID
			if previous.Status == "OPEN" {
				if _, err := s.prepayments().UpdateOne(ctx, bson.D{{Key: "_id", Value: previous.ID}, {Key: "status", Value: "OPEN"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "SUPERSEDED"}, {Key: "updatedAt", Value: now}}}}); err != nil {
					return nil, err
				}
			}
		}
		agent, err := httpx.OID(p.UserID, "user id")
		if err != nil {
			return nil, err
		}
		number, err := s.allocateInvoiceNumber(ctx, hostelID)
		if err != nil {
			return nil, err
		}
		var mail, chargeAmount any
		if in.Email != "" {
			mail = in.Email
		}
		if part != nil {
			chargeAmount = *part
		}
		id := bson.NewObjectID()
		if _, err := s.prepayments().InsertOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "agentId", Value: agent}, {Key: "hostelId", Value: hostelID}, {Key: "invoiceNumber", Value: number}, {Key: "kind", Value: kind},
			{Key: "planId", Value: priced.PlanID}, {Key: "planName", Value: priced.PlanName}, {Key: "cycle", Value: priced.Cycle}, {Key: "cycleMonths", Value: priced.CycleMonths}, {Key: "amount", Value: fee}, {Key: "chargeAmount", Value: chargeAmount},
			{Key: "billedTo", Value: bson.D{{Key: "email", Value: mail}, {Key: "hostelName", Value: in.HostelName}, {Key: "name", Value: in.OwnerName}}}, {Key: "softmatoInvoiceId", Value: nil}, {Key: "softmatoInvoiceNo", Value: nil},
			{Key: "status", Value: "OPEN"}, {Key: "paidAt", Value: nil}, {Key: "transactionNo", Value: nil}, {Key: "provider", Value: nil}, {Key: "claimedAt", Value: nil}, {Key: "draft", Value: in.Draft},
			{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
			return nil, err
		}
		if row, err = s.reloadPrepayment(ctx, id); err != nil {
			return nil, err
		}
	} else if in.Draft != nil {
		if _, err := s.prepayments().UpdateOne(ctx, bson.D{{Key: "_id", Value: row.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "draft", Value: in.Draft}, {Key: "updatedAt", Value: now}}}}); err != nil {
			return nil, err
		}
	}
	if row.SoftmatoID == nil || row.SoftmatoNo == nil {
		if err := s.raisePrepayment(ctx, row); err != nil {
			return nil, s.softmatoRefusal(ctx, err)
		}
	}
	step("session")
	session, err := s.Softmato.CreateCheckout(ctx, *row.SoftmatoID, outbound+"/team/register?prepayment="+row.ID.Hex())
	if err != nil {
		return nil, s.softmatoRefusal(ctx, err)
	}
	return ordered.Map{{Key: "checkoutUrl", Value: session.CheckoutURL}, {Key: "expiresAt", Value: session.ExpiresAt}, {Key: "prepayment", Value: row.view()}}, nil
}

// softmatoRefusal: a prepayment has no invoice to remember, so down and refused
// are both said plainly.
func (s *Settler) softmatoRefusal(ctx context.Context, err error) error {
	return softmato.Unless(ctx, err, nil)
}

// raisePrepayment issues the prepayment's own Softmato document.
func (s *Settler) raisePrepayment(ctx context.Context, row *Prepayment) error {
	issued := s.now()
	start, end, err := servicePeriod(row.CycleMonths, nil, issued)
	if err != nil {
		return err
	}
	kind := row.kind()
	inv := &planInvoice{ID: row.ID, Amount: row.charge(), Cycle: row.Cycle, CycleMonths: row.CycleMonths, HostelID: row.HostelID, InvoiceNumber: row.InvoiceNumber, IssuedAt: &issued,
		Kind: kind, Lifetime: kind == "LIFETIME", PeriodEnd: &end, PeriodStart: &start, PlanID: row.PlanID, PlanName: row.PlanName, Source: "TEAM", Status: "OPEN"}
	if kind == "LIFETIME" {
		inv.Kind = "PLAN"
	}
	if row.BilledTo.Email != nil {
		inv.BilledTo.Email = *row.BilledTo.Email
	}
	if row.BilledTo.HostelName != nil {
		inv.BilledTo.HostelName = *row.BilledTo.HostelName
	}
	if row.BilledTo.Name != nil {
		inv.BilledTo.Name = *row.BilledTo.Name
	}
	prefix := ""
	if row.ChargeAmount != nil {
		prefix = "Part payment — "
	}
	doc, err := s.documentInput(ctx, inv, inv.Amount, row.InvoiceNumber, prefix)
	if err != nil {
		return err
	}
	out, err := s.Softmato.CreateInvoice(ctx, doc)
	if err != nil {
		return err
	}
	number := out.InvoiceID
	if out.InvoiceNo != nil {
		number = *out.InvoiceNo
	}
	if _, err := s.prepayments().UpdateOne(ctx, bson.D{{Key: "_id", Value: row.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "softmatoInvoiceId", Value: out.InvoiceID}, {Key: "softmatoInvoiceNo", Value: number}, {Key: "updatedAt", Value: s.now()}}}}); err != nil {
		return err
	}
	row.SoftmatoID, row.SoftmatoNo = &out.InvoiceID, &number
	return nil
}

// ReadTeamPrepayment is readTeamPrepayment: the row (refreshed) and the agent's saved draft.
func (s *Settler) ReadTeamPrepayment(ctx context.Context, id string, p *authz.Principal) (ordered.Map, error) {
	row, err := s.loadPrepayment(ctx, id, p)
	if err != nil {
		return nil, err
	}
	if row, err = s.refreshPrepayment(ctx, row); err != nil {
		return nil, err
	}
	var draft any
	if row.Draft.Type != 0 && row.Draft.Type != bson.TypeNull {
		draft = ordered.FromBSON(row.Draft)
	}
	return append(row.view(), ordered.Pair{Key: "draft", Value: draft}), nil
}

// SaveTeamPrepaymentDraft keeps the registration form beside its payment.
func (s *Settler) SaveTeamPrepaymentDraft(ctx context.Context, id string, p *authz.Principal, draft any) error {
	row, err := s.loadPrepayment(ctx, id, p)
	if err != nil {
		return err
	}
	if row.Status != "OPEN" && row.Status != "PAID" {
		return payErr(409, "PREPAYMENT_CLAIMED", "That payment already belongs to a published hostel.")
	}
	_, err = s.prepayments().UpdateOne(ctx, bson.D{{Key: "_id", Value: row.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "draft", Value: draft}, {Key: "updatedAt", Value: s.now()}}}})
	return err
}

// ListUnpublishedPrepayments is listUnpublishedPrepayments: paid, not yet published.
func (s *Settler) ListUnpublishedPrepayments(ctx context.Context, p *authz.Principal) ([]ordered.Map, error) {
	filter := bson.D{{Key: "status", Value: "PAID"}}
	if p.Role != authz.Superadmin {
		agent, err := httpx.OID(p.UserID, "user id")
		if err != nil {
			return nil, err
		}
		filter = append(filter, bson.E{Key: "agentId", Value: agent})
	}
	cur, err := s.prepayments().Find(ctx, filter, options.Find().SetSort(bson.D{{Key: "paidAt", Value: -1}}).SetLimit(100).SetProjection(bson.D{{Key: "draft", Value: 0}}))
	if err != nil {
		return nil, err
	}
	var rows []Prepayment
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := make([]ordered.Map, len(rows))
	for i := range rows {
		name, owner := "Hostel", ""
		if rows[i].BilledTo.HostelName != nil {
			name = *rows[i].BilledTo.HostelName
		}
		if rows[i].BilledTo.Name != nil {
			owner = *rows[i].BilledTo.Name
		}
		out[i] = append(rows[i].view(), ordered.Pair{Key: "hostelName", Value: name}, ordered.Pair{Key: "ownerName", Value: owner})
	}
	return out, nil
}

var cycleWords = map[string]string{"annual": "annual", "halfYearly": "6 months", "monthly": "monthly"}

// ClaimedPrepayment is a prepayment taken by a registration: Paid says whether
// the money was already in when it was claimed.
type ClaimedPrepayment struct {
	*Prepayment
	Paid bool
}

// Prepaid is the paid document a claimed prepayment hands to the hostel's invoice.
func (c *ClaimedPrepayment) Prepaid(withAmount bool) *Prepaid {
	out := &Prepaid{InvoiceNumber: c.InvoiceNumber, SoftmatoID: *c.SoftmatoID, SoftmatoNo: *c.SoftmatoNo}
	if withAmount {
		amount := c.Amount
		out.Amount = &amount
	}
	return out
}

// IsLifetime / IsPlan name the prepayment's kind for the filing.
func (c *ClaimedPrepayment) IsLifetime() bool { return c.kind() == "LIFETIME" }
func (c *ClaimedPrepayment) IsPlan() bool     { return c.kind() == "PLAN" }

// ClaimTeamPrepayment is claimTeamPrepayment: taken before the hostel is
// written, so two publishes cannot both spend it. A row that no longer fits the
// plan being published is superseded while OPEN (nil), refused once PAID.
func (s *Settler) ClaimTeamPrepayment(ctx context.Context, id string, p *authz.Principal, planID, cycle string, lifetime bool) (*ClaimedPrepayment, error) {
	row, err := s.loadPrepayment(ctx, id, p)
	if err != nil {
		return nil, err
	}
	if row, err = s.refreshPrepayment(ctx, row); err != nil {
		return nil, err
	}
	if row.Status == "SUPERSEDED" {
		return nil, nil
	}
	supersede := func() (*ClaimedPrepayment, error) {
		_, err := s.prepayments().UpdateOne(ctx, bson.D{{Key: "_id", Value: row.ID}, {Key: "status", Value: "OPEN"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "SUPERSEDED"}, {Key: "updatedAt", Value: s.now()}}}})
		return nil, err
	}
	isLifetime := row.kind() == "LIFETIME"
	if (row.Status == "OPEN" || row.Status == "PAID") && (lifetime != isLifetime || (isLifetime && row.PlanID != planID)) {
		if row.Status == "PAID" {
			msg := "The online payment was the setup fee. A lifetime plan is paid in full instead — publish this hostel on a regular plan, or ask the platform team to refund the setup fee first."
			if isLifetime {
				msg = "The online payment was the lifetime price for " + row.PlanName + ". Pick " + row.PlanName + " · Lifetime to publish."
			}
			return nil, payErr(409, "PREPAYMENT_PLAN_MISMATCH", msg)
		}
		return supersede()
	}
	claimedErr := payErr(409, "PREPAYMENT_CLAIMED", "That online payment already belongs to a published hostel.")
	if row.Status == "CLAIMED" {
		return nil, claimedErr
	}
	if row.kind() == "PLAN" && (row.PlanID != planID || row.Cycle != cycle) {
		if row.Status == "PAID" {
			return nil, payErr(409, "PREPAYMENT_PLAN_MISMATCH", "The online payment was for "+row.PlanName+", "+cycleWords[row.Cycle]+". Pick that plan to publish.")
		}
		return supersede()
	}
	var claimed Prepayment
	now := s.now()
	err = s.prepayments().FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: row.ID}, {Key: "status", Value: row.Status}}, bson.D{{Key: "$set", Value: bson.D{{Key: "claimedAt", Value: now}, {Key: "status", Value: "CLAIMED"}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&claimed)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, claimedErr
	}
	if err != nil {
		return nil, err
	}
	out := &ClaimedPrepayment{Prepayment: &claimed, Paid: row.Status == "PAID"}
	if claimed.SoftmatoID == nil || claimed.SoftmatoNo == nil {
		// Claimed, but there is no document to hand over: put it back.
		s.ReleaseTeamPrepayment(ctx, out)
		return nil, claimedErr
	}
	return out, nil
}

// ReleaseTeamPrepayment undoes a claim whose publish failed.
func (s *Settler) ReleaseTeamPrepayment(ctx context.Context, c *ClaimedPrepayment) {
	status := "OPEN"
	if c.Paid {
		status = "PAID"
	}
	if _, err := s.prepayments().UpdateOne(ctx, bson.D{{Key: "_id", Value: c.ID}, {Key: "status", Value: "CLAIMED"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "claimedAt", Value: nil}, {Key: "status", Value: status}, {Key: "updatedAt", Value: s.now()}}}}); err != nil {
		s.logFailure(ctx, "team_prepayment_release_failed", c.HostelID, err)
	}
}

// SettleTeamPrepayment records the paid prepayment against the hostel's invoice
// and settles it, under Softmato's own transaction number.
func (s *Settler) SettleTeamPrepayment(ctx context.Context, c *ClaimedPrepayment, inv *planInvoice, actor bson.ObjectID) error {
	id := bson.NewObjectID()
	now := s.now()
	if _, err := s.DB.Collection("subscriptionpayments").InsertOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "amount", Value: c.charge()}, {Key: "currency", Value: "NPR"}, {Key: "hostelId", Value: inv.HostelID}, {Key: "invoiceId", Value: inv.ID},
		{Key: "isMocked", Value: false}, {Key: "method", Value: "SOFTMATO"}, {Key: "recordedBy", Value: actor}, {Key: "softmatoProvider", Value: c.Provider}, {Key: "softmatoTransactionNo", Value: c.TransactionNo},
		{Key: "status", Value: "PENDING"}, {Key: "subscriptionId", Value: inv.SubscriptionID}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		return err
	}
	_, err := s.SettlePayment(ctx, id, SettleOptions{ActorID: actor.Hex()})
	return err
}

// Prepaid is issueSubscriptionInvoice's / issueSetupFeeInvoice's `prepaid`:
// the invoice takes the prepayment's number and its already-paid document.
type Prepaid struct {
	Amount        *int64
	InvoiceNumber string
	SoftmatoID    string
	SoftmatoNo    string
}
