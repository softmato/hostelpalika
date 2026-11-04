package billing

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/softmato"
)

// TaskHandler files one remembered task; true when the person who was waiting
// should be told they can finish now.
type TaskHandler func(ctx context.Context, ref, name string) (bool, error)

// probeInvoice is a number Softmato can never have: a cheap "are you up?".
const probeInvoice = "INV-0000/00-000000"

// RetryTasks is retrySoftmatoTasks (inside the platform-push job): work deferred
// while Softmato was down is filed once it answers, oldest first. extra holds
// the bookings module's kinds (BOOKING_PAYMENT, REFUND_FILING).
func (s *Service) RetryTasks(ctx context.Context, extra map[string]TaskHandler, now time.Time) (ordered.Map, error) {
	if s.Softmato == nil {
		return ordered.Map{{Key: "done", Value: 0}}, nil
	}
	tasks := s.DB.Collection("softmatotasks")
	cur, err := tasks.Find(ctx, bson.D{{Key: "attempts", Value: bson.D{{Key: "$lt", Value: 50}}}, {Key: "doneAt", Value: nil}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: 1}}).SetLimit(20))
	if err != nil {
		return nil, err
	}
	var list []struct {
		ID    bson.ObjectID `bson:"_id"`
		Email string        `bson:"email"`
		Kind  string        `bson:"kind"`
		Link  string        `bson:"link"`
		Name  string        `bson:"name"`
		Ref   string        `bson:"ref"`
	}
	if err := cur.All(ctx, &list); err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return ordered.Map{{Key: "done", Value: 0}}, nil
	}
	if _, err := s.Softmato.GetInvoice(ctx, probeInvoice); err != nil && softmato.IsDown(err) {
		return ordered.Map{{Key: "done", Value: 0}, {Key: "down", Value: true}}, nil
	}
	handlers := map[string]TaskHandler{"PLAN_PAYMENT": s.refilePlanPayment, "CASH_FILING": s.refileCash}
	for k, h := range extra {
		handlers[k] = h
	}
	now = now.UTC().Truncate(time.Millisecond)
	done := 0
	for _, t := range list {
		needsPerson, err := false, error(nil)
		if h := handlers[t.Kind]; h != nil {
			needsPerson, err = h(ctx, t.Ref, t.Name)
		}
		if err == nil && needsPerson && t.Email != "" && t.Link != "" && s.Mail != nil {
			m := email.SoftmatoBack(t.Link, t.Name)
			s.Mail.Send(ctx, email.Message{Category: m.Category, To: []string{t.Email}, Subject: m.Subject, HTML: m.HTML})
		}
		if err == nil {
			_, err = tasks.UpdateByID(ctx, t.ID, bson.D{{Key: "$set", Value: bson.D{{Key: "doneAt", Value: now}, {Key: "updatedAt", Value: now}}}})
		}
		if err != nil {
			msg := err.Error()
			if len(msg) > 300 {
				msg = msg[:300]
			}
			if _, uerr := tasks.UpdateByID(ctx, t.ID, bson.D{{Key: "$inc", Value: bson.D{{Key: "attempts", Value: 1}}}, {Key: "$set", Value: bson.D{{Key: "lastError", Value: msg}, {Key: "updatedAt", Value: now}}}}); uerr != nil {
				return nil, uerr
			}
			slog.WarnContext(ctx, "Softmato task not filed yet", "kind", t.Kind, "ref", t.Ref, "error", err)
			if softmato.IsDown(err) {
				break
			}
			continue
		}
		done++
	}
	return ordered.Map{{Key: "done", Value: done}}, nil
}

func (s *Service) invoiceByID(ctx context.Context, ref string) (*planInvoice, error) {
	id, err := bson.ObjectIDFromHex(ref)
	if err != nil {
		return nil, nil
	}
	var inv planInvoice
	err = s.DB.Collection("subscriptioninvoices").FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&inv)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return &inv, err
}

func (s *Service) refilePlanPayment(ctx context.Context, ref, _ string) (bool, error) {
	inv, err := s.invoiceByID(ctx, ref)
	if err != nil || inv == nil || inv.Status == "PAID" || inv.Status == "VOID" {
		return false, err
	}
	_, err = s.ensureRaised(ctx, inv, true)
	return err == nil, err
}

// refileCash is submitFieldCash(paymentId, collectedBy): a still-PENDING cash
// payment Softmato never received. It emails the owner itself.
func (s *Service) refileCash(ctx context.Context, ref, name string) (bool, error) {
	id, err := bson.ObjectIDFromHex(ref)
	if err != nil {
		return false, nil
	}
	var pay struct {
		Amount           int64         `bson:"amount"`
		GatewayReference string        `bson:"gatewayReference"`
		InvoiceID        bson.ObjectID `bson:"invoiceId"`
		TransactionNo    string        `bson:"softmatoTransactionNo"`
		Status           string        `bson:"status"`
	}
	err = s.DB.Collection("subscriptionpayments").FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&pay)
	if errors.Is(err, mongo.ErrNoDocuments) || (err == nil && (pay.Status != "PENDING" || pay.TransactionNo != "")) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	inv, err := s.invoiceByID(ctx, pay.InvoiceID.Hex())
	if err != nil || inv == nil {
		return false, err
	}
	if err := s.submitFieldCash(ctx, inv, id, pay.Amount, pay.GatewayReference, name); err != nil {
		return false, fmt.Errorf("cash filing: %w", err)
	}
	return false, nil
}
