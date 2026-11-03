package billing

import (
	"context"
	"errors"
	"math"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/softmato"
)

// documentNumbers is softmatoDocumentNumbers: the original, then any balance documents.
func (inv *planInvoice) documentNumbers() []string {
	var out []string
	if inv.SoftmatoNo != nil && *inv.SoftmatoNo != "" {
		out = append(out, *inv.SoftmatoNo)
	}
	for _, d := range inv.BalanceDocs {
		out = append(out, d.No)
	}
	return out
}

// Reconcile is reconcileInvoiceFromSoftmato: Softmato's ledger for this invoice,
// recorded here. Each payment Softmato names goes the webhook's way under its
// own transaction number; a Softmato too old to name them is settled by the
// difference. Safe to call any number of times.
func (s *Settler) Reconcile(ctx context.Context, invoiceID bson.ObjectID) error {
	var inv planInvoice
	if err := s.DB.Collection("subscriptioninvoices").FindOne(ctx, bson.D{{Key: "_id", Value: invoiceID}}).Decode(&inv); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil
		}
		return err
	}
	if inv.Status == "VOID" || inv.SoftmatoNo == nil || *inv.SoftmatoNo == "" || s.Softmato == nil {
		return nil
	}
	numbers := inv.documentNumbers()
	details := make([]*softmato.InvoiceDetail, len(numbers))
	for i, no := range numbers {
		details[i], _ = s.Softmato.GetInvoice(ctx, no)
	}
	if details[0] == nil {
		return nil
	}
	if details[0].Payments != nil {
		for _, d := range details {
			if d == nil {
				continue
			}
			for _, p := range d.Payments {
				amount, err := paisaToRupees(p.AmountMinor)
				if err != nil {
					return err
				}
				if _, err := s.RecordSoftmatoPayment(ctx, inv.ID, inv.HostelID, inv.SubscriptionID, p.TransactionID, amount); err != nil {
					return err
				}
			}
		}
		return nil
	}
	// Their paisa against our rupees; ours can exceed theirs (cash they never
	// saw), which is not an error and writes nothing.
	paid, err := s.settledTotal(ctx, bson.D{{Key: "invoiceId", Value: inv.ID}})
	if err != nil {
		return err
	}
	difference := int64(math.Round(float64(details[0].PaidMinor)/100)) - paid
	if difference <= 0 {
		return nil
	}
	id := bson.NewObjectID()
	now := s.now()
	if _, err := s.DB.Collection("subscriptionpayments").InsertOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "amount", Value: difference}, {Key: "currency", Value: "NPR"}, {Key: "hostelId", Value: inv.HostelID},
		{Key: "invoiceId", Value: inv.ID}, {Key: "isMocked", Value: false}, {Key: "method", Value: "SOFTMATO"}, {Key: "status", Value: "PENDING"}, {Key: "subscriptionId", Value: inv.SubscriptionID},
		{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		return err
	}
	_, err = s.SettlePayment(ctx, id, SettleOptions{})
	return err
}

// ReadReturnState is readReturnState. owns is the ownership check (owner or
// the agent who filed it); a refusal reads as "unknown", exactly like a number
// that does not exist, so probing invoice numbers learns nothing.
func (s *Settler) ReadReturnState(ctx context.Context, invoiceNumber string, owns func(hostelID bson.ObjectID) bool, step func(string)) (ordered.Map, error) {
	unknown := ordered.Map{{Key: "kind", Value: "unknown"}}
	var inv planInvoice
	if err := s.DB.Collection("subscriptioninvoices").FindOne(ctx, bson.D{{Key: "invoiceNumber", Value: invoiceNumber}}).Decode(&inv); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return unknown, nil
		}
		return unknown, err
	}
	if !owns(inv.HostelID) {
		return unknown, nil
	}
	pending := ordered.Map{{Key: "invoiceNumber", Value: invoiceNumber}, {Key: "kind", Value: "pending_document"}}
	numbers := inv.documentNumbers()
	if len(numbers) == 0 || s.Softmato == nil {
		return pending, nil
	}
	step("confirm")
	detail, _ := s.Softmato.GetInvoice(ctx, numbers[len(numbers)-1])
	if detail == nil {
		return pending, nil
	}
	paid := detail.Status == "paid"
	if paid {
		step("record")
	}
	// Provisioned on what the read just said; a failed write downstream must
	// not tell someone who paid that their payment is broken.
	if err := s.Reconcile(ctx, inv.ID); err != nil {
		s.logFailure(ctx, "return_reconcile_failed", inv.HostelID, err)
	}
	rupees := func(minor int64) int64 { return int64(math.Round(float64(minor) / 100)) }
	switch {
	case detail.Status == "void" || detail.Status == "written_off":
		return ordered.Map{{Key: "invoiceNumber", Value: invoiceNumber}, {Key: "kind", Value: "void"}}, nil
	case paid:
		step("activate")
		var sub struct {
			CurrentPeriodEnd *time.Time `bson:"currentPeriodEnd"`
			Status           string     `bson:"status"`
		}
		err := s.DB.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "hostelId", Value: inv.HostelID}}, options.FindOne().SetProjection(bson.D{{Key: "currentPeriodEnd", Value: 1}, {Key: "status", Value: 1}})).Decode(&sub)
		if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
			return unknown, err
		}
		var until any
		if sub.Status == "ACTIVE" && sub.CurrentPeriodEnd != nil && sub.CurrentPeriodEnd.Before(LifetimePeriodEnd) {
			until = sub.CurrentPeriodEnd.UTC().Format("2006-01-02T15:04:05.000Z")
		}
		return ordered.Map{{Key: "activeUntil", Value: until}, {Key: "invoiceNumber", Value: invoiceNumber}, {Key: "kind", Value: "paid"}, {Key: "planName", Value: inv.PlanName}, {Key: "total", Value: rupees(detail.TotalMinor)}}, nil
	case detail.Status == "partially_paid":
		return ordered.Map{{Key: "balance", Value: rupees(detail.DueMinor)}, {Key: "invoiceNumber", Value: invoiceNumber}, {Key: "kind", Value: "partial"}, {Key: "planName", Value: inv.PlanName}}, nil
	}
	return ordered.Map{{Key: "invoiceNumber", Value: invoiceNumber}, {Key: "kind", Value: "unpaid"}, {Key: "planName", Value: inv.PlanName}, {Key: "total", Value: rupees(detail.TotalMinor)}}, nil
}
