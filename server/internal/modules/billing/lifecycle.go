package billing

import (
	"context"
	"errors"
	"log/slog"
	"net/url"
	"strconv"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	"github.com/softmato/hostelpalika/server/internal/platform/plans"
	"github.com/softmato/hostelpalika/server/internal/platform/softmato"
)

// The plan's life from choosing it to going live: subscription.service selectPlan,
// pricePlan, priceLifetime, startPlanPeriod, issueSubscriptionInvoice,
// issueSetupFeeInvoice; subscription-payment.service startFreeMonths; and
// cash-filing.service fileFieldCash.

// LifetimePeriodEnd is LIFETIME_PERIOD_END: a lifetime plan's period end.
var LifetimePeriodEnd = time.Date(2099, 12, 31, 18, 14, 59, 999_000_000, time.UTC)

// Priced is pricePlan / priceLifetime's snapshot of a plan at the moment of choosing.
type Priced struct {
	Cycle       string
	CycleMonths int
	CycleTotal  int64
	Lifetime    bool
	MonthlyRate float64
	PlanID      string
	PlanName    string
}

// subRow is the HostelSubscription the lifecycle reads.
type subRow struct {
	ID               bson.ObjectID  `bson:"_id"`
	HostelID         bson.ObjectID  `bson:"hostelId"`
	AgentID          *bson.ObjectID `bson:"agentId"`
	ActivatedAt      *time.Time     `bson:"activatedAt"`
	CurrentPeriodEnd *time.Time     `bson:"currentPeriodEnd"`
	Cycle            *string        `bson:"cycle"`
	CycleMonths      *int           `bson:"cycleMonths"`
	CycleTotal       *int64         `bson:"cycleTotal"`
	FreeMonths       *int           `bson:"freeMonths"`
	FreeUntil        *time.Time     `bson:"freeUntil"`
	Lifetime         bool           `bson:"lifetime"`
	LifetimeSince    *time.Time     `bson:"lifetimeSince"`
	PlanID           *string        `bson:"planId"`
	PlanName         *string        `bson:"planName"`
	Source           *string        `bson:"source"`
	Status           string         `bson:"status"`
	TrialDays        *int           `bson:"trialDays"`
}

func (s *Service) subscription(ctx context.Context, hostelID bson.ObjectID, source string, agent *bson.ObjectID) (*subRow, error) {
	got, err := GetOrCreateSubscription(ctx, s.DB, hostelID, source, agent)
	if err != nil {
		return nil, err
	}
	var row subRow
	return &row, s.DB.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "_id", Value: got.ID}}).Decode(&row)
}

func nowMS() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

// PricePlan is pricePlan: the catalogue as sold today, so a running event is the price.
func (s *Service) PricePlan(ctx context.Context, planID string, cycle plans.Cycle) (Priced, error) {
	stored, err := s.catalog(ctx)
	if err != nil {
		return Priced{}, err
	}
	period, err := bs.CurrentPeriod(time.Now())
	if err != nil {
		return Priced{}, err
	}
	plan := plans.GetPlan(plans.SellingCatalog(stored, period), planID)
	if plan == nil {
		return Priced{}, payErr(404, "PLAN_NOT_FOUND", "That plan is no longer available. Choose another one.")
	}
	total := plans.CycleTotal(*plan, cycle)
	if total <= 0 {
		return Priced{}, payErr(409, "PLAN_NOT_PRICED", "That plan has no price set, so it cannot be invoiced. Ask the platform team to price it.")
	}
	return Priced{Cycle: string(cycle), CycleMonths: plans.CycleMonths(cycle), CycleTotal: int64(total), MonthlyRate: plan.Monthly, PlanID: plan.ID, PlanName: plan.Name}, nil
}

// PriceLifetime is priceLifetime. gate=false when the money is already in: the
// window or the last seat closing in between must not refuse a hostel that paid.
func (s *Service) PriceLifetime(ctx context.Context, planID string, gate bool) (Priced, error) {
	a, err := Lifetime(ctx, s.DB, s.Config, time.Now())
	if err != nil {
		return Priced{}, err
	}
	if gate && a.Window != "open" {
		if a.Window == "upcoming" {
			return Priced{}, payErr(409, "LIFETIME_CLOSED", "The lifetime deal has not opened yet.")
		}
		return Priced{}, payErr(409, "LIFETIME_CLOSED", "The lifetime deal is closed. Choose a regular plan instead.")
	}
	for _, o := range a.Offers {
		if o.PlanID != planID {
			continue
		}
		if gate && o.Left <= 0 {
			return Priced{}, payErr(409, "LIFETIME_SOLD_OUT", "All "+strconv.Itoa(o.Seats)+" lifetime seats on "+o.PlanName+" are taken.")
		}
		return Priced{Cycle: "annual", CycleMonths: 12, CycleTotal: o.Price, Lifetime: true, MonthlyRate: o.Monthly, PlanID: o.PlanID, PlanName: o.PlanName}, nil
	}
	return Priced{}, payErr(404, "LIFETIME_NOT_OFFERED", "That plan has no lifetime offer. Choose another one.")
}

// SelectPlan is selectPlan: snapshots the plan's price on the subscription.
func (s *Service) SelectPlan(ctx context.Context, hostelID bson.ObjectID, planID string, cycle plans.Cycle, lifetime, lifetimeGate bool, actor bson.ObjectID) error {
	sub, err := s.subscription(ctx, hostelID, "PUBLIC", nil)
	if err != nil {
		return err
	}
	if sub.LifetimeSince != nil {
		return payErr(409, "LIFETIME_PLAN", "This hostel is on a lifetime plan. There is nothing to renew or change.")
	}
	if sub.Status == "ACTIVE" {
		return payErr(409, "ALREADY_ACTIVE", "This hostel is already on an active plan.")
	}
	if open, err := s.openPlanInvoice(ctx, sub.ID); err != nil {
		return err
	} else if open != nil {
		return payErr(409, "INVOICE_OUTSTANDING", "Invoice "+open.InvoiceNumber+" is already outstanding for the "+open.PlanName+". Pay or cancel it before changing plan.")
	}
	var priced Priced
	if lifetime {
		priced, err = s.PriceLifetime(ctx, planID, lifetimeGate)
	} else {
		priced, err = s.PricePlan(ctx, planID, cycle)
	}
	if err != nil {
		return err
	}
	now := nowMS()
	if _, err := s.DB.Collection("hostelsubscriptions").UpdateOne(ctx, bson.D{{Key: "_id", Value: sub.ID}}, bson.D{{Key: "$set", Value: bson.D{
		{Key: "cycle", Value: priced.Cycle}, {Key: "cycleMonths", Value: priced.CycleMonths}, {Key: "cycleTotal", Value: priced.CycleTotal},
		{Key: "freeMonths", Value: 0}, {Key: "lifetime", Value: lifetime}, {Key: "monthlyRate", Value: priced.MonthlyRate}, {Key: "planId", Value: priced.PlanID},
		{Key: "planName", Value: priced.PlanName}, {Key: "selectedAt", Value: now}, {Key: "selectedBy", Value: actor}, {Key: "status", Value: "SELECTED"}, {Key: "updatedAt", Value: now}}}}); err != nil {
		return err
	}
	return s.Audit.Write(ctx, audit.Entry{Action: "SUBSCRIPTION_PLAN_SELECTED", ActorID: actor, EntityID: sub.ID.Hex(), EntityType: "HostelSubscription", HostelID: sub.HostelID,
		Metadata: bson.D{{Key: "cycle", Value: priced.Cycle}, {Key: "lifetime", Value: lifetime}, {Key: "planId", Value: priced.PlanID}, {Key: "total", Value: priced.CycleTotal}}})
}

// Free is the free time a plan went live on: a trial (TrialDays) or free months.
type Free struct {
	FreeMonths int
	FreeUntil  time.Time
	TrialDays  *int
}

// StartFreeMonths is startFreeMonths (on Settler: going live is settlePayment's goLive): the plan runs ACTIVE with no invoice until
// freeUntil. Nil when there is no free time to give. Idempotent.
//
// Plans stopped carrying free months (docs/QUICK_SIGNUP_KYC_TRIAL.md) and
// SelectPlan writes zero, so a subscription snapshotted with them before then
// keeps them through claimFreeMonths; every other hostel gets the trial.
func (s *Settler) StartFreeMonths(ctx context.Context, hostelID bson.ObjectID, actor *bson.ObjectID, from time.Time) (*Free, error) {
	var sub subRow
	if err := s.DB.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostelID}}).Decode(&sub); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil
		}
		return nil, err
	}
	if sub.PlanID == nil || *sub.PlanID == "" || sub.Lifetime {
		return nil, nil
	}
	if sub.FreeUntil != nil {
		months := 0
		if sub.FreeMonths != nil {
			months = *sub.FreeMonths
		}
		return &Free{FreeMonths: months, FreeUntil: *sub.FreeUntil, TrialDays: sub.TrialDays}, nil
	}
	if sub.Status != "SELECTED" && sub.Status != "PENDING_SELECTION" {
		return nil, nil
	}
	free := Free{}
	start := from.UTC().Truncate(time.Millisecond)
	if sub.FreeMonths != nil && *sub.FreeMonths > 0 {
		months, err := s.claimFreeMonths(ctx, sub.HostelID, *sub.PlanID, *sub.FreeMonths)
		if err != nil {
			return nil, err
		}
		if months <= 0 {
			_, err := s.DB.Collection("hostelsubscriptions").UpdateOne(ctx, bson.D{{Key: "_id", Value: sub.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "freeMonths", Value: 0}, {Key: "updatedAt", Value: nowMS()}}}})
			return nil, err
		}
		_, end, err := servicePeriod(months, nil, start)
		if err != nil {
			return nil, err
		}
		free = Free{FreeMonths: months, FreeUntil: end}
	} else {
		days := s.Config.OperationsTyped(ctx).TrialDays
		free = Free{FreeUntil: bs.DayEnd(start, days), TrialDays: &days}
	}
	set := bson.D{{Key: "activatedAt", Value: start}, {Key: "currentPeriodEnd", Value: free.FreeUntil}, {Key: "dueBy", Value: nil}, {Key: "freeMonths", Value: free.FreeMonths},
		{Key: "freeUntil", Value: free.FreeUntil}, {Key: "status", Value: "ACTIVE"}}
	if free.TrialDays != nil && *free.TrialDays != 0 {
		set = append(set, bson.E{Key: "trialDays", Value: *free.TrialDays}, bson.E{Key: "trialEndsAt", Value: free.FreeUntil})
	}
	set = append(set, bson.E{Key: "updatedAt", Value: nowMS()})
	if _, err := s.DB.Collection("hostelsubscriptions").UpdateOne(ctx, bson.D{{Key: "_id", Value: sub.ID}}, bson.D{{Key: "$set", Value: set}}); err != nil {
		return nil, err
	}
	source, actorID := "PUBLIC", ""
	if sub.Source != nil {
		source = *sub.Source
	}
	if actor != nil {
		actorID = actor.Hex()
	}
	if err := s.goLive(ctx, sub.HostelID, source, actorID, nowMS()); err != nil {
		return nil, err
	}
	var trial any
	if free.TrialDays != nil {
		trial = *free.TrialDays
	}
	entry := audit.Entry{Action: "SUBSCRIPTION_FREE_MONTHS_STARTED", ActorType: "SYSTEM", EntityID: sub.ID.Hex(), EntityType: "HostelSubscription", HostelID: sub.HostelID,
		Metadata: bson.D{{Key: "freeMonths", Value: free.FreeMonths}, {Key: "freeUntil", Value: httpx.ISO(free.FreeUntil)}, {Key: "planId", Value: *sub.PlanID}, {Key: "trialDays", Value: trial}}}
	if actor != nil {
		entry.ActorID, entry.ActorType = *actor, "USER"
	}
	return &free, s.Audit.Write(ctx, entry)
}

// publishForSubscription: a hostel whose plan is now running is published; one already live is left alone.
func (s *Service) publishForSubscription(ctx context.Context, hostelID bson.ObjectID, actor *bson.ObjectID) error {
	set := bson.D{{Key: "status", Value: "PUBLISHED"}}
	if actor != nil {
		set = append(set, bson.E{Key: "updatedBy", Value: *actor})
	}
	set = append(set, bson.E{Key: "verificationStatus", Value: "VERIFIED"}, bson.E{Key: "updatedAt", Value: nowMS()})
	res, err := s.DB.Collection("hostels").UpdateOne(ctx, bson.D{{Key: "_id", Value: hostelID}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "PUBLISHED"}}}}, bson.D{{Key: "$set", Value: set}})
	if err == nil && res.ModifiedCount > 0 {
		s.Cache.PublicChanged(ctx)
	}
	return err
}

// StartPlanPeriod is startPlanPeriod: the plan runs on the period an invoice pays
// for. Idempotent on the invoice.
func (s *Service) StartPlanPeriod(ctx context.Context, subscriptionID bson.ObjectID, cycleMonths int, periodEnd *time.Time, from time.Time) error {
	var sub subRow
	if err := s.DB.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "_id", Value: subscriptionID}}).Decode(&sub); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil
		}
		return err
	}
	running := sub.CurrentPeriodEnd
	if running != nil && periodEnd != nil && !running.Before(*periodEnd) {
		return nil
	}
	start, end, err := servicePeriod(max(cycleMonths, 1), running, from)
	if err != nil {
		return err
	}
	activated := start
	if running != nil && running.After(from) && sub.ActivatedAt != nil {
		activated = *sub.ActivatedAt
	}
	_, err = s.DB.Collection("hostelsubscriptions").UpdateOne(ctx, bson.D{{Key: "_id", Value: sub.ID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "activatedAt", Value: activated}, {Key: "currentPeriodEnd", Value: end}, {Key: "updatedAt", Value: nowMS()}}}})
	return err
}

// IssueOptions is issueSubscriptionInvoice's options.
type IssueOptions struct {
	Agent           *bson.ObjectID
	RequireVerified bool
	Source          string // "" keeps the subscription's own
	// Prepaid hands over a team prepayment's number and paid document.
	Prepaid *Prepaid
}

// IssueSubscriptionInvoice is issueSubscriptionInvoice. Idempotent: an open invoice is returned.
func (s *Service) IssueSubscriptionInvoice(ctx context.Context, hostelID, actor bson.ObjectID, o IssueOptions) (*planInvoice, error) {
	src := o.Source
	if src == "" {
		src = "PUBLIC"
	}
	sub, err := s.subscription(ctx, hostelID, src, o.Agent)
	if err != nil {
		return nil, err
	}
	if sub.PlanID == nil || *sub.PlanID == "" || sub.Cycle == nil {
		return nil, payErr(409, "NO_PLAN_SELECTED", "Choose a plan before asking for an invoice.")
	}
	if open, err := s.openPlanInvoice(ctx, sub.ID); err != nil || open != nil {
		if err != nil {
			return nil, err
		}
		return s.ensureRaised(ctx, open, false)
	}
	var hostel struct {
		Name     string `bson:"name"`
		Slug     string `bson:"slug"`
		Status   string `bson:"status"`
		Verified string `bson:"verificationStatus"`
	}
	if err := s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: sub.HostelID}}).Decode(&hostel); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, payErr(404, "HOSTEL_NOT_FOUND", "Hostel not found.")
		}
		return nil, err
	}
	if o.RequireVerified && hostel.Verified != "VERIFIED" {
		return nil, payErr(409, "NOT_VERIFIED", "This hostel has not been verified yet, so it cannot be invoiced. You will be emailed the moment it is.")
	}
	issued := nowMS()
	due := bs.DayEnd(issued, s.Config.OperationsTyped(ctx).SubscriptionDueGraceDays)
	// The window or the last seat closing must not refuse money already taken.
	if sub.Lifetime && o.Prepaid == nil {
		if _, err := s.PriceLifetime(ctx, *sub.PlanID, true); err != nil {
			return nil, err
		}
	}
	months := 1
	if sub.CycleMonths != nil && *sub.CycleMonths > 0 {
		months = *sub.CycleMonths
	}
	start, end := issued, LifetimePeriodEnd
	if !sub.Lifetime {
		if start, end, err = servicePeriod(months, sub.CurrentPeriodEnd, issued); err != nil {
			return nil, err
		}
	}
	source := o.Source
	if source == "" {
		source = "PUBLIC"
		if sub.Source != nil {
			source = *sub.Source
		}
	}
	agent := o.Agent
	if agent == nil {
		agent = sub.AgentID
	}
	var amount int64
	if sub.CycleTotal != nil {
		amount = *sub.CycleTotal
	}
	if o.Prepaid != nil && o.Prepaid.Amount != nil {
		amount = *o.Prepaid.Amount
	}
	planName := ""
	if sub.PlanName != nil {
		planName = *sub.PlanName
	}
	inv, err := s.insertInvoice(ctx, sub, invoiceFields{Agent: agent, Amount: amount, Cycle: *sub.Cycle, CycleMonths: months, DueAt: &due, IssuedAt: issued, Kind: "PLAN",
		Lifetime: sub.Lifetime, PeriodStart: &start, PeriodEnd: &end, PlanID: *sub.PlanID, PlanName: planName, Source: source, Prepaid: o.Prepaid}, hostel.Name)
	if err != nil {
		return nil, err
	}
	if _, err := s.DB.Collection("hostelsubscriptions").UpdateOne(ctx, bson.D{{Key: "_id", Value: sub.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "AWAITING_PAYMENT"}, {Key: "updatedAt", Value: nowMS()}}}}); err != nil {
		return nil, err
	}
	if err := s.Audit.Write(ctx, audit.Entry{Action: "SUBSCRIPTION_INVOICE_ISSUED", ActorID: actor, EntityID: inv.ID.Hex(), EntityType: "SubscriptionInvoice", HostelID: sub.HostelID,
		Metadata: bson.D{{Key: "amount", Value: amount}, {Key: "invoiceNumber", Value: inv.InvoiceNumber}, {Key: "lifetime", Value: sub.Lifetime}, {Key: "planId", Value: *sub.PlanID}, {Key: "prepaid", Value: o.Prepaid != nil}}}); err != nil {
		return nil, err
	}
	// Already paid: the settlement that follows sends the one email that is true.
	if o.Prepaid != nil {
		return inv, nil
	}
	s.onInvoiceIssued(ctx, inv, hostel.Name, hostel.Slug, hostel.Status == "PUBLISHED", source == "TEAM")
	return inv, nil
}

type invoiceFields struct {
	Agent                  *bson.ObjectID
	Amount                 int64
	Cycle                  string
	CycleMonths            int
	DueAt                  *time.Time
	IssuedAt               time.Time
	Kind                   string
	Lifetime               bool
	PeriodStart, PeriodEnd *time.Time
	PlanID, PlanName       string
	Source                 string
	Prepaid                *Prepaid
}

// insertInvoice writes our row first and raises Softmato's document second: an
// obligation with no paper yet is survivable, the reverse is not.
func (s *Service) insertInvoice(ctx context.Context, sub *subRow, f invoiceFields, hostelName string) (*planInvoice, error) {
	mail, ownerName, _, err := s.billingContact(ctx, sub.HostelID)
	if err != nil {
		return nil, err
	}
	var number string
	var softmatoID, softmatoNo, docURL any
	if f.Prepaid != nil {
		number, softmatoID, softmatoNo = f.Prepaid.InvoiceNumber, f.Prepaid.SoftmatoID, f.Prepaid.SoftmatoNo
		docURL = s.documentURL("invoice", number)
	} else if number, err = s.allocateInvoiceNumber(ctx, sub.HostelID); err != nil {
		return nil, err
	}
	now := nowMS()
	inv := &planInvoice{ID: bson.NewObjectID(), Amount: f.Amount, Cycle: f.Cycle, CycleMonths: f.CycleMonths, DueAt: f.DueAt, HostelID: sub.HostelID, InvoiceNumber: number,
		IssuedAt: &f.IssuedAt, Kind: f.Kind, Lifetime: f.Lifetime, PeriodEnd: f.PeriodEnd, PeriodStart: f.PeriodStart, PlanID: f.PlanID, PlanName: f.PlanName, Status: "OPEN", SubscriptionID: sub.ID}
	inv.BilledTo.Email, inv.BilledTo.HostelName, inv.BilledTo.Name = mail, hostelName, ownerName
	if f.Prepaid != nil {
		inv.SoftmatoID, inv.SoftmatoNo = &f.Prepaid.SoftmatoID, &f.Prepaid.SoftmatoNo
	}
	var agent, due, ps, pe any
	if f.Agent != nil {
		agent = *f.Agent
	}
	if f.DueAt != nil {
		due = *f.DueAt
	}
	if f.PeriodStart != nil {
		ps, pe = *f.PeriodStart, *f.PeriodEnd
	}
	if _, err := s.DB.Collection("subscriptioninvoices").InsertOne(ctx, bson.D{{Key: "_id", Value: inv.ID}, {Key: "invoiceNumber", Value: number}, {Key: "hostelId", Value: sub.HostelID},
		{Key: "subscriptionId", Value: sub.ID}, {Key: "kind", Value: f.Kind}, {Key: "lifetime", Value: f.Lifetime}, {Key: "planId", Value: f.PlanID}, {Key: "planName", Value: f.PlanName},
		{Key: "cycle", Value: f.Cycle}, {Key: "cycleMonths", Value: f.CycleMonths}, {Key: "amount", Value: f.Amount}, {Key: "currency", Value: "NPR"}, {Key: "status", Value: "OPEN"},
		{Key: "billedTo", Value: bson.D{{Key: "email", Value: mail}, {Key: "hostelName", Value: hostelName}, {Key: "name", Value: ownerName}}},
		{Key: "issuedAt", Value: f.IssuedAt}, {Key: "dueAt", Value: due}, {Key: "periodStart", Value: ps}, {Key: "periodEnd", Value: pe}, {Key: "source", Value: f.Source},
		{Key: "agentId", Value: agent}, {Key: "softmatoInvoiceNo", Value: softmatoNo}, {Key: "softmatoInvoiceId", Value: softmatoID}, {Key: "documentUrl", Value: docURL},
		{Key: "softmatoBalanceInvoices", Value: bson.A{}}, {Key: "localInvoiceNo", Value: nil}, {Key: "localIssuedAt", Value: nil}, {Key: "voidedAt", Value: nil}, {Key: "voidedBy", Value: nil},
		{Key: "voidReason", Value: nil}, {Key: "reminders", Value: bson.D{{Key: "sent", Value: bson.A{}}}}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		return nil, err
	}
	return s.ensureRaised(ctx, inv, false)
}

// IssueSetupFeeInvoice is issueSetupFeeInvoice: the fee a field agent collects, as
// its own invoice. No period, no due date, no email of its own.
func (s *Service) IssueSetupFeeInvoice(ctx context.Context, hostelID bson.ObjectID, amount int64, agent bson.ObjectID, prepaid *Prepaid) (*planInvoice, error) {
	sub, err := s.subscription(ctx, hostelID, "TEAM", &agent)
	if err != nil {
		return nil, err
	}
	var hostel struct {
		Name string `bson:"name"`
	}
	if err := s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: sub.HostelID}}).Decode(&hostel); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	cycle, plan := "monthly", "setup-fee"
	if sub.Cycle != nil {
		cycle = *sub.Cycle
	}
	if sub.PlanID != nil && *sub.PlanID != "" {
		plan = *sub.PlanID
	}
	inv, err := s.insertInvoice(ctx, sub, invoiceFields{Agent: &agent, Amount: amount, Cycle: cycle, CycleMonths: 1, IssuedAt: nowMS(), Kind: "SETUP_FEE",
		PlanID: plan, PlanName: "Setup fee", Source: "TEAM", Prepaid: prepaid}, hostel.Name)
	if err != nil {
		return nil, err
	}
	return inv, s.Audit.Write(ctx, audit.Entry{Action: "SETUP_FEE_INVOICE_ISSUED", ActorID: agent, EntityID: inv.ID.Hex(), EntityType: "SubscriptionInvoice", HostelID: sub.HostelID,
		Metadata: bson.D{{Key: "amount", Value: amount}, {Key: "invoiceNumber", Value: inv.InvoiceNumber}, {Key: "prepaid", Value: prepaid != nil}}})
}

// MarkPastDue: nothing was collected toward the plan, so the whole price is the
// due, on the invoice's own deadline.
func (s *Service) MarkPastDue(ctx context.Context, inv *planInvoice) error {
	due := inv.DueAt
	if due == nil {
		d := bs.DayEnd(*inv.IssuedAt, s.Config.OperationsTyped(ctx).SubscriptionDueGraceDays)
		due = &d
	}
	_, err := s.DB.Collection("hostelsubscriptions").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: inv.HostelID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "dueBy", Value: *due}, {Key: "status", Value: "PAST_DUE"}, {Key: "updatedAt", Value: nowMS()}}}})
	return err
}

// FileFieldCash is fileFieldCash: the agent's cash as a PENDING payment, filed with
// Softmato as a claim their admin confirms.
//
// The hostel is already published when this runs, so a Softmato failure of any
// kind is remembered for the retry worker rather than thrown (P7-11): TS rethrew
// anything that was not an outage, failing a registration that had gone live.
func (s *Service) FileFieldCash(ctx context.Context, inv *planInvoice, amount int64, reference string, agent bson.ObjectID, agentName string) error {
	now := nowMS()
	var ref any
	if reference != "" {
		ref = reference
	}
	id := bson.NewObjectID()
	if _, err := s.DB.Collection("subscriptionpayments").InsertOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "invoiceId", Value: inv.ID}, {Key: "hostelId", Value: inv.HostelID},
		{Key: "subscriptionId", Value: inv.SubscriptionID}, {Key: "amount", Value: amount}, {Key: "currency", Value: "NPR"}, {Key: "method", Value: "CASH"}, {Key: "status", Value: "PENDING"},
		{Key: "collectedBy", Value: agent}, {Key: "recordedBy", Value: agent}, {Key: "gatewayReference", Value: ref}, {Key: "isMocked", Value: false},
		{Key: "softmatoTransactionNo", Value: nil}, {Key: "softmatoSessionId", Value: nil}, {Key: "softmatoProvider", Value: nil}, {Key: "settledAt", Value: nil}, {Key: "failureReason", Value: nil},
		{Key: "proofAssetId", Value: nil}, {Key: "claimedAt", Value: nil}, {Key: "claimNote", Value: nil}, {Key: "reviewedBy", Value: nil}, {Key: "reviewedAt", Value: nil}, {Key: "reviewNote", Value: nil},
		{Key: "receiptNumber", Value: nil}, {Key: "receiptIssuedAt", Value: nil}, {Key: "receiptDocumentUrl", Value: nil}, {Key: "localTransactionNo", Value: nil},
		{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		return err
	}
	if err := s.submitFieldCash(ctx, inv, id, amount, reference, agentName); err != nil {
		slog.ErrorContext(ctx, "field_cash_filing_deferred", "paymentId", id.Hex(), "error", err.Error())
		return s.rememberCashFiling(ctx, agentName, id.Hex())
	}
	return nil
}

func (s *Service) submitFieldCash(ctx context.Context, inv *planInvoice, paymentID bson.ObjectID, amount int64, reference, collectedBy string) error {
	raised, err := s.ensureRaised(ctx, inv, true)
	if err != nil {
		return err
	}
	if collectedBy == "" {
		collectedBy = "Field agent"
	}
	tx, err := s.Softmato.RecordOfflinePayment(ctx, softmato.OfflinePayment{AmountMinor: money.RupeesToPaisa(amount), CollectedBy: collectedBy, InvoiceID: *raised.SoftmatoNo, Reference: reference}, "hh-cash:"+paymentID.Hex())
	if err != nil {
		return err
	}
	if _, err := s.DB.Collection("subscriptionpayments").UpdateOne(ctx, bson.D{{Key: "_id", Value: paymentID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "softmatoTransactionNo", Value: tx}, {Key: "updatedAt", Value: nowMS()}}}}); err != nil {
		return err
	}
	if raised.BilledTo.Email != "" && s.Mail != nil {
		m := email.FieldCashReceived(amount, collectedBy, raised.PlanName, tx)
		s.Mail.Notify(ctx, email.Notification{Action: "field_cash_received", To: raised.BilledTo.Email, Subject: m.Subject, HTML: m.HTML, Category: m.Category})
	}
	return nil
}

// rememberCashFiling is rememberTask({kind: CASH_FILING}): filed once Softmato answers.
func (s *Service) rememberCashFiling(ctx context.Context, name, ref string) error {
	now := nowMS()
	var n any
	if name != "" {
		n = name
	}
	_, err := s.DB.Collection("softmatotasks").UpdateOne(ctx, bson.D{{Key: "doneAt", Value: nil}, {Key: "kind", Value: "CASH_FILING"}, {Key: "ref", Value: ref}},
		bson.D{{Key: "$setOnInsert", Value: bson.D{{Key: "name", Value: n}, {Key: "attempts", Value: 0}, {Key: "lastError", Value: nil}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}}},
		options.UpdateOne().SetUpsert(true))
	if mongo.IsDuplicateKeyError(err) {
		return nil
	}
	return err
}

// onInvoiceIssued is the registration events' bill email, with the PDF when it can be had.
func (s *Service) onInvoiceIssued(ctx context.Context, inv *planInvoice, hostelName, slug string, live, team bool) {
	if inv.BilledTo.Email == "" || s.Mail == nil {
		return
	}
	var files []email.Attachment
	if doc, err := s.resolveInvoice(ctx, inv.InvoiceNumber, []string{inv.HostelID.Hex()}); err != nil {
		slog.WarnContext(ctx, "subscription_invoice_attachment_failed", "number", inv.InvoiceNumber, "message", err.Error())
	} else if doc != nil {
		files = append(files, email.Attachment{Content: doc.data, Filename: doc.name})
	}
	action, label := s.SiteURL+"/register-hostel/form", "Pay now"
	if team {
		label = "View billing"
	}
	if slug != "" && (team || live) {
		action = s.PlanPayLink(ctx, inv.HostelID, s.SiteURL+"/"+url.PathEscape(slug)+"/admin/billing")
	}
	cycleLabel := "Lifetime"
	if !inv.Lifetime {
		cycleLabel = inv.Cycle
		if c, err := s.catalog(ctx); err == nil {
			if l := cycleLabelOf(c, inv.Cycle); l != "" {
				cycleLabel = l
			}
		}
	}
	due, doc := "", ""
	if inv.DueAt != nil {
		due = email.EmailDate(*inv.DueAt)
	}
	if inv.SoftmatoNo != nil {
		doc = s.documentURL("invoice", inv.InvoiceNumber)
	}
	m := email.SubscriptionInvoice(label, action, inv.Amount, len(files) > 0, cycleLabel, doc, due, !team && !live, hostelName, inv.InvoiceNumber, inv.BilledTo.Name, inv.PlanName)
	s.Mail.Notify(ctx, email.Notification{Action: "subscription_invoice_issued", To: inv.BilledTo.Email, Subject: m.Subject, HTML: m.HTML, Category: m.Category, Attachments: files})
}

func cycleLabelOf(c plans.Catalog, cycle string) string {
	switch plans.Cycle(cycle) {
	case plans.Monthly:
		return c.CycleLabels.Monthly
	case plans.HalfYearly:
		return c.CycleLabels.HalfYearly
	case plans.Annual:
		return c.CycleLabels.Annual
	}
	return ""
}

// PlanPayLink is planPayLink: a signed link straight to the plan checkout, for the
// owner of the hostel that pays (a branch's main hostel); fallback when there is none.
func (s *Service) PlanPayLink(ctx context.Context, hostelID bson.ObjectID, fallback string) string {
	if s.PayLinkSecret == "" {
		return fallback
	}
	billed, err := BillingHostelID(ctx, s.DB, hostelID)
	if err != nil {
		return fallback
	}
	var h struct {
		OwnerID *bson.ObjectID `bson:"ownerId"`
	}
	if err := s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: billed}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&h); err != nil || h.OwnerID == nil {
		return fallback
	}
	now := time.Now()
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"ownerId": h.OwnerID.Hex(), "tokenType": "plan-pay-link", "sub": billed.Hex(),
		"iat": now.Unix(), "exp": now.Add(14 * 24 * time.Hour).Unix()}).SignedString([]byte(s.PayLinkSecret))
	if err != nil {
		return fallback
	}
	return s.SiteURL + "/plans-pricing/checkout?link=" + url.QueryEscape(token)
}

// Recharge is rechargeSubscription: a superadmin sells months by hand (cash at the
// office, a deal on the phone). The plan runs ACTIVE to the new end; no invoice.
func (s *Service) Recharge(ctx context.Context, hostelID bson.ObjectID, planID string, months int, actor bson.ObjectID) (time.Time, string, error) {
	sub, err := s.subscription(ctx, hostelID, "PUBLIC", nil)
	if err != nil {
		return time.Time{}, "", err
	}
	if sub.LifetimeSince != nil {
		return time.Time{}, "", payErr(409, "LIFETIME_PLAN", "This hostel is on a lifetime plan. There is nothing to renew or change.")
	}
	stored, err := s.catalog(ctx)
	if err != nil {
		return time.Time{}, "", err
	}
	period, err := bs.CurrentPeriod(time.Now())
	if err != nil {
		return time.Time{}, "", err
	}
	plan := plans.GetPlan(plans.SellingCatalog(stored, period), planID)
	if plan == nil {
		return time.Time{}, "", payErr(404, "PLAN_NOT_FOUND", "That plan is no longer available. Choose another one.")
	}
	total := plans.MonthsTotal(*plan, months)
	if total <= 0 {
		return time.Time{}, "", payErr(409, "PLAN_NOT_PRICED", "That plan has no price set, so it cannot be invoiced. Ask the platform team to price it.")
	}
	var row struct {
		SelectedAt *time.Time `bson:"selectedAt"`
	}
	if err := s.DB.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "_id", Value: sub.ID}}).Decode(&row); err != nil {
		return time.Time{}, "", err
	}
	now := nowMS()
	start, end, err := servicePeriod(months, sub.CurrentPeriodEnd, now)
	if err != nil {
		return time.Time{}, "", err
	}
	activated := start
	if sub.CurrentPeriodEnd != nil && sub.CurrentPeriodEnd.After(now) && sub.ActivatedAt != nil {
		activated = *sub.ActivatedAt
	}
	selected := now
	if row.SelectedAt != nil {
		selected = *row.SelectedAt
	}
	if _, err := s.DB.Collection("hostelsubscriptions").UpdateOne(ctx, bson.D{{Key: "_id", Value: sub.ID}}, bson.D{{Key: "$set", Value: bson.D{
		{Key: "activatedAt", Value: activated}, {Key: "currentPeriodEnd", Value: end}, {Key: "cycle", Value: string(plans.CycleForMonths(months))}, {Key: "cycleMonths", Value: months},
		{Key: "cycleTotal", Value: int64(total)}, {Key: "dueBy", Value: nil}, {Key: "monthlyRate", Value: plan.Monthly}, {Key: "planId", Value: plan.ID}, {Key: "planName", Value: plan.Name},
		{Key: "selectedAt", Value: selected}, {Key: "status", Value: "ACTIVE"}, {Key: "updatedAt", Value: now}}}}); err != nil {
		return time.Time{}, "", err
	}
	var from any
	if sub.CurrentPeriodEnd != nil {
		from = *sub.CurrentPeriodEnd
	}
	return end, plan.Name, s.Audit.Write(ctx, audit.Entry{Action: "SUBSCRIPTION_RECHARGED", ActorID: actor, ActorType: "USER", EntityID: sub.ID.Hex(), EntityType: "HostelSubscription", HostelID: sub.HostelID,
		Metadata: bson.D{{Key: "from", Value: from}, {Key: "months", Value: months}, {Key: "planId", Value: plan.ID}, {Key: "to", Value: end}}})
}

// Owed is the plan invoice a suspension collects: issued (or the open one), with what is left on it.
type Owed struct {
	InvoiceNumber, PlanName string
	IssuedAt                time.Time
	Outstanding             int64
	HostelID                bson.ObjectID
}

// PlanOwed raises (or finds) the plan invoice and says what is left on it.
func (s *Service) PlanOwed(ctx context.Context, hostelID, actor bson.ObjectID) (*Owed, error) {
	inv, err := s.IssueSubscriptionInvoice(ctx, hostelID, actor, IssueOptions{})
	if err != nil {
		return nil, err
	}
	left, err := s.outstanding(ctx, inv)
	if err != nil {
		return nil, err
	}
	issued := time.Time{}
	if inv.IssuedAt != nil {
		issued = *inv.IssuedAt
	}
	return &Owed{InvoiceNumber: inv.InvoiceNumber, PlanName: inv.PlanName, IssuedAt: issued, Outstanding: left, HostelID: inv.HostelID}, nil
}

// InvoiceAttachment is attach("invoice"): the PDF, or none. Never fails the email.
func (s *Service) InvoiceAttachment(ctx context.Context, number string, hostelID bson.ObjectID) []email.Attachment {
	doc, err := s.resolveInvoice(ctx, number, []string{hostelID.Hex()})
	if err != nil {
		slog.WarnContext(ctx, "subscription_invoice_attachment_failed", "number", number, "message", err.Error())
		return nil
	}
	if doc == nil {
		return nil
	}
	return []email.Attachment{{Content: doc.data, Filename: doc.name}}
}
