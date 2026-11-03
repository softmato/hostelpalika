package billing

import (
	"context"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
)

// A verified payment.success settles a public hostel's plan once, however many
// times it is delivered. Against the compose Mongo in a throwaway db.
func TestSoftmatoWebhookSettlesOnce(t *testing.T) {
	ctx := context.Background()
	client, db, err := appmongo.Connect(ctx, "mongodb://127.0.0.1:27018/hostelpalika_p8settle?directConnection=true")
	if err != nil {
		t.Skip("local Mongo not running:", err)
	}
	defer func() { _ = db.Drop(ctx); _ = client.Disconnect(ctx) }()
	_ = db.Drop(ctx)

	now := time.Date(2026, 11, 3, 6, 0, 0, 0, time.UTC)
	hostel, sub, inv, pay, prepay := bson.NewObjectID(), bson.NewObjectID(), bson.NewObjectID(), bson.NewObjectID(), bson.NewObjectID()
	insert := func(coll string, doc bson.D) {
		if _, err := db.Collection(coll).InsertOne(ctx, doc); err != nil {
			t.Fatal(err)
		}
	}
	insert("hostels", bson.D{{Key: "_id", Value: hostel}, {Key: "name", Value: "Test Hostel"}, {Key: "status", Value: "PENDING_REVIEW"},
		{Key: "suspension", Value: bson.D{{Key: "startedAt", Value: now.Add(-48 * time.Hour)}, {Key: "graceEndsAt", Value: now.Add(-24 * time.Hour)}, {Key: "reason", Value: "unpaid"}}}})
	insert("hostelsubscriptions", bson.D{{Key: "_id", Value: sub}, {Key: "hostelId", Value: hostel}, {Key: "status", Value: "PENDING_PAYMENT"}, {Key: "source", Value: "PUBLIC"},
		{Key: "planId", Value: nil}, {Key: "currentPeriodEnd", Value: nil}})
	insert("subscriptioninvoices", bson.D{{Key: "_id", Value: inv}, {Key: "hostelId", Value: hostel}, {Key: "subscriptionId", Value: sub}, {Key: "amount", Value: int64(1500)},
		{Key: "invoiceNumber", Value: "HH-INV-1"}, {Key: "kind", Value: "PLAN"}, {Key: "planId", Value: "basic"}, {Key: "planName", Value: "Basic"}, {Key: "cycle", Value: "MONTHLY"},
		{Key: "cycleMonths", Value: 1}, {Key: "status", Value: "OPEN"}, {Key: "source", Value: "PUBLIC"}, {Key: "softmatoInvoiceNo", Value: "INV-2083/84-000001"}})
	insert("subscriptionpayments", bson.D{{Key: "_id", Value: pay}, {Key: "amount", Value: int64(1500)}, {Key: "hostelId", Value: hostel}, {Key: "invoiceId", Value: inv},
		{Key: "method", Value: "SOFTMATO"}, {Key: "status", Value: "PENDING"}, {Key: "subscriptionId", Value: sub}, {Key: "softmatoTransactionNo", Value: nil}, {Key: "createdAt", Value: now}})
	insert("teamprepayments", bson.D{{Key: "_id", Value: prepay}, {Key: "amount", Value: int64(5000)}, {Key: "invoiceNumber", Value: "HH-PRE-1"}, {Key: "status", Value: "OPEN"},
		{Key: "softmatoInvoiceNo", Value: "INV-2083/84-000009"}})

	goLive, granted := 0, 0
	w := &Webhooks{Settler: &Settler{Service: &Service{DB: db, SiteURL: "https://example.test", Config: platformconfig.New(db), Audit: audit.New(db)},
		GoLive:           func(context.Context, bson.ObjectID) error { goLive++; return nil },
		GrantOwnerAccess: func(context.Context, bson.ObjectID, string) error { granted++; return nil },
		Now:              func() time.Time { return now }}}

	success := &WebhookPayload{Event: "payment.success", TransactionID: "TXN-2083/84-00000042", InvoiceID: "INV-2083/84-000001", Amount: 150000, Status: "SUCCEEDED"}
	res, err := w.Apply(ctx, success)
	if err != nil || res.Action != "settled" || res.PaymentID != pay.Hex() {
		t.Fatalf("first delivery: %+v %v", res, err)
	}
	res, err = w.Apply(ctx, success)
	if err != nil || res.Action != "already_settled" || res.PaymentID != pay.Hex() {
		t.Fatalf("second delivery: %+v %v", res, err)
	}
	if goLive != 1 || granted != 1 {
		t.Fatalf("go-live hooks ran %d/%d times, want once each", goLive, granted)
	}

	var p bson.M
	_ = db.Collection("subscriptionpayments").FindOne(ctx, bson.D{{Key: "_id", Value: pay}}).Decode(&p)
	if p["status"] != "SETTLED" || p["softmatoTransactionNo"] != "TXN-2083/84-00000042" || !strings.HasPrefix(stringOf(p["receiptNumber"]), "SRC-0001-") {
		t.Fatalf("payment %v", p)
	}
	if n, _ := db.Collection("subscriptionpayments").CountDocuments(ctx, bson.D{}); n != 1 {
		t.Fatalf("%d payment rows, want 1", n)
	}
	var i, s, h bson.M
	_ = db.Collection("subscriptioninvoices").FindOne(ctx, bson.D{{Key: "_id", Value: inv}}).Decode(&i)
	_ = db.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "_id", Value: sub}}).Decode(&s)
	_ = db.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}}).Decode(&h)
	if i["status"] != "PAID" {
		t.Fatalf("invoice %v", i["status"])
	}
	if s["status"] != "ACTIVE" || s["planId"] != "basic" || s["currentPeriodEnd"] == nil || s["dueBy"] != nil {
		t.Fatalf("subscription %v", s)
	}
	if h["status"] != "PUBLISHED" || h["verificationStatus"] != "VERIFIED" {
		t.Fatalf("hostel %v", h)
	}
	if n, _ := db.Collection("hostels").CountDocuments(ctx, bson.D{{Key: "_id", Value: hostel}, {Key: "suspension.startedAt", Value: nil}}); n != 1 {
		t.Fatal("suspension not lifted")
	}
	for _, action := range []string{"SUBSCRIPTION_PAYMENT_SETTLED", "HOSTEL_SUSPENSION_LIFTED"} {
		var a bson.M
		if err := db.Collection("auditlogs").FindOne(ctx, bson.D{{Key: "action", Value: action}}).Decode(&a); err != nil || a["actorType"] != "SYSTEM" {
			t.Fatalf("audit %s: %v %v", action, a, err)
		}
	}

	// Recorded, never settled: a failure, a success label on a non-final status.
	for _, p := range []*WebhookPayload{{Event: "payment.failed", Status: "FAILED", InvoiceID: "INV-2083/84-000001"}, {Event: "payment.success", Status: "PENDING", InvoiceID: "INV-2083/84-000001"}} {
		if res, err := w.Apply(ctx, p); err != nil || res.Action != "recorded" {
			t.Fatalf("%+v: %+v %v", p, res, err)
		}
	}
	// A team prepayment is marked paid; an unknown number is ignored.
	pre := &WebhookPayload{Event: "payment.success", TransactionID: "TXN-2083/84-00000043", InvoiceID: "INV-2083/84-000009", Amount: 500000, Status: "SUCCEEDED"}
	if res, err := w.Apply(ctx, pre); err != nil || res.Event != "team_prepayment_paid" {
		t.Fatalf("prepayment: %+v %v", res, err)
	}
	var tp bson.M
	_ = db.Collection("teamprepayments").FindOne(ctx, bson.D{{Key: "_id", Value: prepay}}).Decode(&tp)
	if tp["status"] != "PAID" || tp["transactionNo"] != "TXN-2083/84-00000043" {
		t.Fatalf("prepayment row %v", tp)
	}
	if res, err := w.Apply(ctx, &WebhookPayload{Event: "payment.success", Status: "SUCCEEDED", InvoiceID: "INV-NOPE", Amount: 100}); err != nil || res.Action != "ignored" {
		t.Fatalf("unknown: %+v %v", res, err)
	}
}

func stringOf(v any) string { s, _ := v.(string); return s }
