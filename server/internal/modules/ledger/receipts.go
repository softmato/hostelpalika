package ledger

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// Receipt is one Receipt row.
type Receipt struct {
	ID                bson.ObjectID  `bson:"_id"`
	Amount            int64          `bson:"amount"`
	CertificationCode *string        `bson:"certificationCode"`
	EventID           *bson.ObjectID `bson:"eventId"`
	HostelID          bson.ObjectID  `bson:"hostelId"`
	InvoiceID         *bson.ObjectID `bson:"invoiceId"`
	IssuedAt          time.Time      `bson:"issuedAt"`
	ReceiptNumber     string         `bson:"receiptNumber"`
	ResidentID        bson.ObjectID  `bson:"residentId"`
	VoidedAt          *time.Time     `bson:"voidedAt"`
}

const codeAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

func newCertificationCode() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b) // crypto/rand.Read never fails since Go 1.24
	for i := range b {
		b[i] = codeAlphabet[b[i]&31]
	}
	return "HP-" + string(b[:4]) + "-" + string(b[4:8]) + "-" + string(b[8:])
}

// NextReceiptNumber is nextReceiptNumber: RCP-EDU-2083-07-00001. One atomic $inc, per
// hostel and period. Five digits for reading only; the sequence keeps counting.
func (e *Engine) NextReceiptNumber(ctx context.Context, hostelID bson.ObjectID, period, prefix string) (string, error) {
	at := now()
	var counter struct {
		Sequence int64 `bson:"sequence"`
	}
	err := e.DB.Collection("receiptcounters").FindOneAndUpdate(ctx, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "kind", Value: "RECEIPT"}, {Key: "period", Value: period}},
		bson.D{{Key: "$inc", Value: bson.D{{Key: "sequence", Value: 1}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: at}}}, {Key: "$setOnInsert", Value: bson.D{{Key: "__v", Value: 0}, {Key: "createdAt", Value: at}}}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&counter)
	if err != nil {
		return "", err
	}
	parts := []string{"RCP"}
	if prefix != "" {
		parts = append(parts, prefix)
	}
	return strings.Join(append(parts, period, fmt.Sprintf("%05d", counter.Sequence)), "-"), nil
}

// issueReceipt is issueReceiptForEvent: idempotent on the event, through the unique
// index that allows one receipt per event.
func (e *Engine) issueReceipt(ctx context.Context, ev *Event, at time.Time, p *authz.Principal) (*Receipt, error) {
	existing := &Receipt{}
	err := e.DB.Collection("receipts").FindOne(ctx, bson.D{{Key: "eventId", Value: ev.ID}}).Decode(existing)
	if err == nil {
		return existing, nil
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	var hostel struct {
		Prefix string `bson:"referencePrefix"`
	}
	if err := e.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: ev.HostelID}}, options.FindOne().SetProjection(bson.D{{Key: "referencePrefix", Value: 1}})).Decode(&hostel); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	period, err := bs.PeriodOf(at)
	if err != nil {
		return nil, err
	}
	number, err := e.NextReceiptNumber(ctx, ev.HostelID, period, hostel.Prefix)
	if err != nil {
		return nil, err
	}
	var issuedBy, cert, certifiedAt any
	if p != nil {
		if me, err := httpx.OID(p.UserID, "user id"); err == nil {
			issuedBy = me
		}
	}
	if qualifiesForOfferProgram(ev) {
		cert, certifiedAt = newCertificationCode(), at
	}
	id := bson.NewObjectID()
	created := now()
	if _, err := e.DB.Collection("receipts").InsertOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: ev.HostelID}, {Key: "residentId", Value: *ev.ResidentID}, {Key: "eventId", Value: ev.ID},
		{Key: "invoiceId", Value: idOrNil(ev.InvoiceID)}, {Key: "paymentId", Value: nil}, {Key: "month", Value: nil}, {Key: "receiptNumber", Value: number}, {Key: "issuedAt", Value: at}, {Key: "issuedBy", Value: issuedBy},
		{Key: "amount", Value: JSInt(ev.Amount)}, {Key: "certificationCode", Value: cert}, {Key: "certifiedAt", Value: certifiedAt}, {Key: "voidedAt", Value: nil}, {Key: "voidedBy", Value: nil}, {Key: "voidReason", Value: nil},
		{Key: "replacedByReceiptId", Value: nil}, {Key: "createdAt", Value: created}, {Key: "__v", Value: 0}}); err != nil {
		return nil, err
	}
	r := &Receipt{}
	return r, e.DB.Collection("receipts").FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(r)
}

// voidReceiptOfEvent voids the receipt a reversed event earned, if it still stands,
// with no replacement: the money went back.
func (e *Engine) voidReceiptOfEvent(ctx context.Context, eventID, me bson.ObjectID, role, reason string, at time.Time) error {
	r := &Receipt{}
	err := e.DB.Collection("receipts").FindOne(ctx, bson.D{{Key: "eventId", Value: eventID}}).Decode(r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil
	}
	if err != nil || r.VoidedAt != nil {
		return err
	}
	if _, err := e.DB.Collection("receipts").UpdateOne(ctx, bson.D{{Key: "_id", Value: r.ID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "replacedByReceiptId", Value: nil}, {Key: "voidReason", Value: reason}, {Key: "voidedAt", Value: at}, {Key: "voidedBy", Value: me}}}}); err != nil {
		return err
	}
	if e.Audit == nil {
		return nil
	}
	f := audit.Finance{Action: "RECEIPT_VOIDED", AmountBefore: r.Amount, EntityID: r.ID.Hex(), EntityType: "Receipt", HostelID: r.HostelID, Reason: reason, Source: "RECEIPT_VOID"}
	if r.InvoiceID != nil {
		f.InvoiceID = r.InvoiceID.Hex()
	}
	if err := e.Audit.WriteFinance(ctx, me, role, f); err != nil {
		slog.ErrorContext(ctx, "finance audit failed after voiding a receipt", "receiptId", r.ID.Hex(), "error", err)
	}
	return nil
}
