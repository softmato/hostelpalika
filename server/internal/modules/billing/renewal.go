package billing

import (
	"context"
	"errors"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/plans"
)

// PriceMonths is pricePlan with a month count: any 1..12 months, priced from
// the monthly rate, on the cycle that count falls under.
func (s *Service) PriceMonths(ctx context.Context, planID string, months int) (Priced, error) {
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
	total := plans.MonthsTotal(*plan, months)
	if total <= 0 {
		return Priced{}, payErr(409, "PLAN_NOT_PRICED", "That plan has no price set, so it cannot be invoiced. Ask the platform team to price it.")
	}
	return Priced{Cycle: string(plans.CycleForMonths(months)), CycleMonths: months, CycleTotal: int64(total), MonthlyRate: plan.Monthly, PlanID: plan.ID, PlanName: plan.Name}, nil
}

func (s *Service) price(ctx context.Context, in RenewalIn) (Priced, error) {
	switch {
	case in.Lifetime:
		return s.PriceLifetime(ctx, in.PlanID, true)
	case in.Months > 0:
		return s.PriceMonths(ctx, in.PlanID, in.Months)
	}
	return s.PricePlan(ctx, in.PlanID, in.Cycle)
}

type RenewalIn struct {
	Cycle    plans.Cycle
	Lifetime bool
	Months   int
	PlanID   string
}

type RenewalOptions struct {
	// DeferDocument leaves Softmato's document for the pay step, so a checkout
	// that is still choosing does not raise one per click.
	DeferDocument bool
	// Reshape lets a deferred open invoice switch between lifetime and a plan.
	Reshape bool
	// Agreed is the price already agreed instead of today's catalogue: the first
	// bill after free months keeps the price the owner signed up at.
	Agreed *Priced
	// DueAt overrides the grace deadline: a renewal is due when the period ends.
	DueAt *time.Time
}

func actorType(actor *bson.ObjectID) string {
	if actor == nil {
		return "SYSTEM"
	}
	return "USER"
}

func entry(e audit.Entry, actor *bson.ObjectID) audit.Entry {
	e.ActorType = actorType(actor)
	if actor != nil {
		e.ActorID = *actor
	}
	return e
}

// RaiseRenewalInvoice is raiseRenewalInvoice: an open invoice is reused (or
// reshaped when the checkout switched lifetime on or off before anything was
// paid); otherwise a new one extends the running plan.
func (s *Service) RaiseRenewalInvoice(ctx context.Context, hostelID bson.ObjectID, in RenewalIn, actor *bson.ObjectID, o RenewalOptions) (*planInvoice, bool, error) {
	sub, err := s.subscription(ctx, hostelID, "PUBLIC", nil)
	if err != nil {
		return nil, false, err
	}
	if sub.LifetimeSince != nil {
		return nil, false, payErr(409, "LIFETIME_PLAN", "This hostel is on a lifetime plan. There is nothing to renew or change.")
	}
	open, err := s.openPlanInvoice(ctx, sub.ID)
	if err != nil {
		return nil, false, err
	}
	if open != nil {
		if o.DeferDocument && o.Reshape && open.Lifetime != in.Lifetime {
			locked, err := s.InvoiceMonthsLocked(ctx, open)
			if err != nil {
				return nil, false, err
			}
			if !locked {
				priced, err := s.price(ctx, in)
				if err != nil {
					return nil, false, err
				}
				inv, err := s.reshape(ctx, sub, open, priced, actor, "SUBSCRIPTION_INVOICE_RESHAPED")
				return inv, true, err
			}
		}
		inv, err := s.ensureRaised(ctx, open, false)
		return inv, true, err
	}
	var hostel struct {
		Name     string `bson:"name"`
		Verified string `bson:"verificationStatus"`
	}
	if err := s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: sub.HostelID}}).Decode(&hostel); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, false, payErr(404, "HOSTEL_NOT_FOUND", "Hostel not found.")
		}
		return nil, false, err
	}
	if hostel.Verified != "VERIFIED" {
		return nil, false, payErr(409, "NOT_VERIFIED", "This hostel is still being verified, so it cannot buy a plan yet. You will be emailed the moment it is.")
	}
	var priced Priced
	if o.Agreed != nil && !in.Lifetime {
		priced = *o.Agreed
	} else if priced, err = s.price(ctx, in); err != nil {
		return nil, false, err
	}
	if err := s.branchesFit(ctx, sub.HostelID, priced.PlanID); err != nil {
		return nil, false, err
	}
	now := nowMS()
	start, end, err := s.periodFor(priced, sub.CurrentPeriodEnd, now)
	if err != nil {
		return nil, false, err
	}
	mail, ownerName, _, err := s.billingContact(ctx, sub.HostelID)
	if err != nil {
		return nil, false, err
	}
	number, err := s.allocateInvoiceNumber(ctx, sub.HostelID)
	if err != nil {
		return nil, false, err
	}
	inv := &planInvoice{ID: bson.NewObjectID(), Amount: priced.CycleTotal, Cycle: priced.Cycle, CycleMonths: priced.CycleMonths, HostelID: sub.HostelID, InvoiceNumber: number, IssuedAt: &now, Kind: "PLAN", Lifetime: priced.Lifetime,
		PeriodEnd: &end, PeriodStart: &start, PlanID: priced.PlanID, PlanName: priced.PlanName, Source: "PUBLIC", Status: "OPEN", SubscriptionID: sub.ID}
	inv.BilledTo.Email, inv.BilledTo.HostelName, inv.BilledTo.Name = mail, hostel.Name, ownerName
	due := bs.DayEnd(now, s.Config.OperationsTyped(ctx).SubscriptionDueGraceDays)
	if o.DueAt != nil {
		due = o.DueAt.UTC().Truncate(time.Millisecond)
	}
	inv.DueAt = &due
	if _, err := s.DB.Collection("subscriptioninvoices").InsertOne(ctx, bson.D{{Key: "_id", Value: inv.ID}, {Key: "agentId", Value: sub.AgentID}, {Key: "amount", Value: inv.Amount}, {Key: "billedTo", Value: bson.D{{Key: "email", Value: mail}, {Key: "hostelName", Value: hostel.Name}, {Key: "name", Value: ownerName}}},
		{Key: "currency", Value: "NPR"}, {Key: "cycle", Value: inv.Cycle}, {Key: "cycleMonths", Value: inv.CycleMonths}, {Key: "dueAt", Value: due}, {Key: "hostelId", Value: sub.HostelID}, {Key: "invoiceNumber", Value: number}, {Key: "issuedAt", Value: now}, {Key: "kind", Value: "PLAN"}, {Key: "lifetime", Value: inv.Lifetime},
		{Key: "periodEnd", Value: end}, {Key: "periodStart", Value: start}, {Key: "planId", Value: inv.PlanID}, {Key: "planName", Value: inv.PlanName}, {Key: "source", Value: "PUBLIC"}, {Key: "status", Value: "OPEN"}, {Key: "subscriptionId", Value: sub.ID},
		{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		return nil, false, err
	}
	if !o.DeferDocument {
		if inv, err = s.ensureRaised(ctx, inv, false); err != nil {
			return nil, false, err
		}
	}
	// A running plan stays ACTIVE while its renewal is open: that is paying early, not owing.
	if sub.Status != "ACTIVE" {
		if _, err := s.DB.Collection("hostelsubscriptions").UpdateOne(ctx, bson.D{{Key: "_id", Value: sub.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "AWAITING_PAYMENT"}, {Key: "updatedAt", Value: now}}}}); err != nil {
			return nil, false, err
		}
	}
	return inv, false, s.Audit.Write(ctx, entry(audit.Entry{Action: "SUBSCRIPTION_RENEWAL_INVOICE_ISSUED", EntityID: inv.ID.Hex(), EntityType: "SubscriptionInvoice", HostelID: sub.HostelID,
		Metadata: bson.D{{Key: "amount", Value: inv.Amount}, {Key: "cycle", Value: inv.Cycle}, {Key: "invoiceNumber", Value: number}, {Key: "lifetime", Value: inv.Lifetime}, {Key: "planId", Value: inv.PlanID}}}, actor))
}

func (s *Service) branchesFit(ctx context.Context, hostelID bson.ObjectID, planID string) error {
	stored, err := s.catalog(ctx)
	if err != nil {
		return err
	}
	return s.assertBranchesFit(ctx, hostelID, stored, planID)
}

// periodFor is lifetimePeriod or servicePeriod.
func (s *Service) periodFor(p Priced, currentEnd *time.Time, from time.Time) (time.Time, time.Time, error) {
	if p.Lifetime {
		return from, LifetimePeriodEnd, nil
	}
	return servicePeriod(p.CycleMonths, currentEnd, from)
}

// reshape is reshapeOpenInvoice and the write of changeOpenInvoiceMonths: an
// OPEN invoice nothing has been paid on, repriced in place.
func (s *Service) reshape(ctx context.Context, sub *subRow, open *planInvoice, p Priced, actor *bson.ObjectID, action string) (*planInvoice, error) {
	if err := s.branchesFit(ctx, sub.HostelID, p.PlanID); err != nil {
		return nil, err
	}
	now := nowMS()
	from := now
	if open.IssuedAt != nil {
		from = *open.IssuedAt
	}
	start, end, err := s.periodFor(p, sub.CurrentPeriodEnd, from)
	if err != nil {
		return nil, err
	}
	if _, err := s.DB.Collection("subscriptioninvoices").UpdateOne(ctx, bson.D{{Key: "_id", Value: open.ID}, {Key: "status", Value: "OPEN"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "amount", Value: p.CycleTotal}, {Key: "cycle", Value: p.Cycle},
		{Key: "cycleMonths", Value: p.CycleMonths}, {Key: "lifetime", Value: p.Lifetime}, {Key: "periodEnd", Value: end}, {Key: "periodStart", Value: start}, {Key: "planId", Value: p.PlanID}, {Key: "planName", Value: p.PlanName}, {Key: "updatedAt", Value: now}}}}); err != nil {
		return nil, err
	}
	meta := bson.D{{Key: "amount", Value: p.CycleTotal}, {Key: "fromLifetime", Value: open.Lifetime}, {Key: "fromPlanId", Value: open.PlanID}, {Key: "lifetime", Value: p.Lifetime}, {Key: "planId", Value: p.PlanID}}
	if action == "SUBSCRIPTION_INVOICE_MONTHS_CHANGED" {
		meta = bson.D{{Key: "amount", Value: p.CycleTotal}, {Key: "fromMonths", Value: open.CycleMonths}, {Key: "fromPlanId", Value: open.PlanID}, {Key: "months", Value: p.CycleMonths}, {Key: "planId", Value: p.PlanID}}
	}
	if err := s.Audit.Write(ctx, entry(audit.Entry{Action: action, EntityID: open.ID.Hex(), EntityType: "SubscriptionInvoice", HostelID: sub.HostelID, Metadata: meta}, actor)); err != nil {
		return nil, err
	}
	var out planInvoice
	return &out, s.DB.Collection("subscriptioninvoices").FindOne(ctx, bson.D{{Key: "_id", Value: open.ID}}).Decode(&out)
}

// InvoiceMonthsLocked is invoiceMonthsLocked: an invoice stops being reshapeable
// once it is not OPEN, came from the field team, or has any payment against it
// other than an abandoned Softmato attempt.
func (s *Service) InvoiceMonthsLocked(ctx context.Context, inv *planInvoice) (bool, error) {
	if inv.Status != "OPEN" || inv.Source == "TEAM" {
		return true, nil
	}
	n, err := s.DB.Collection("subscriptionpayments").CountDocuments(ctx, bson.D{{Key: "invoiceId", Value: inv.ID},
		{Key: "$nor", Value: bson.A{bson.D{{Key: "method", Value: "SOFTMATO"}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"PENDING", "FAILED"}}}}}}}})
	return n > 0, err
}

// ChangeOpenInvoiceMonths is changeOpenInvoiceMonths: the checkout's month
// picker, repricing the open invoice in place while nothing is paid on it.
func (s *Service) ChangeOpenInvoiceMonths(ctx context.Context, hostelID bson.ObjectID, months int, actor bson.ObjectID, planID string) (*planInvoice, error) {
	sub, err := s.subscription(ctx, hostelID, "PUBLIC", nil)
	if err != nil {
		return nil, err
	}
	if sub.LifetimeSince != nil {
		return nil, payErr(409, "LIFETIME_PLAN", "This hostel is on a lifetime plan. There is nothing to renew or change.")
	}
	open, err := s.openPlanInvoice(ctx, sub.ID)
	if err != nil {
		return nil, err
	}
	if open == nil {
		return nil, payErr(409, "NO_OPEN_INVOICE", "There is no open invoice to change.")
	}
	locked, err := s.InvoiceMonthsLocked(ctx, open)
	if err != nil {
		return nil, err
	}
	if locked {
		return nil, payErr(409, "INVOICE_LOCKED", "This invoice can no longer be changed. Pay it as it is.")
	}
	if planID == "" {
		planID = open.PlanID
	}
	priced, err := s.PriceMonths(ctx, planID, months)
	if err != nil {
		return nil, err
	}
	return s.reshape(ctx, sub, open, priced, &actor, "SUBSCRIPTION_INVOICE_MONTHS_CHANGED")
}

// PlanAfterPayment is planAfterPayment: which plan the hostel is on once this
// invoice is paid. A bigger plan wins; on the same plan, a longer cycle does.
func PlanAfterPayment(c plans.Catalog, currentPlan string, currentMonths int, inv *planInvoice) string {
	if currentPlan == "" {
		return "invoice"
	}
	bought, held := plans.PlanRank(c, inv.PlanID), plans.PlanRank(c, currentPlan)
	if bought != held {
		if bought > held {
			return "invoice"
		}
		return "current"
	}
	if inv.CycleMonths > currentMonths {
		return "invoice"
	}
	return "current"
}
