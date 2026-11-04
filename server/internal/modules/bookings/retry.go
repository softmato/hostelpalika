package bookings

import (
	"context"
	"errors"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/softmato"
)

func (s *Signed) bookingByID(ctx context.Context, ref string) (*Booking, error) {
	id, err := bson.ObjectIDFromHex(ref)
	if err != nil {
		return nil, nil
	}
	var b Booking
	err = s.db.Collection("bookings").FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&b)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return &b, err
}

// RetryPayment is the BOOKING_PAYMENT task: the fee's Softmato invoice, raised
// now that Softmato answers. The guest is told they can pay.
func (s *Signed) RetryPayment(ctx context.Context, ref, _ string) (bool, error) {
	b, err := s.bookingByID(ctx, ref)
	if err != nil || b == nil || b.Status != "AWAITING_PAYMENT" || s.Softmato == nil {
		return false, err
	}
	_, err = s.ensureInvoice(ctx, b)
	return err == nil, err
}

// RefileRefund is refileBookingRefund: the refund request the booking's end
// owes, filed with Softmato (whose admin approves it). Keyed, so a retry never
// files it twice.
func (s *Signed) RefileRefund(ctx context.Context, ref, _ string) (bool, error) {
	b, err := s.bookingByID(ctx, ref)
	if err != nil || b == nil || b.Settlement == nil || b.Settlement.Refund == nil || *b.Settlement.Refund <= 0 {
		return false, err
	}
	if b.SoftmatoInvoiceNo == nil || *b.SoftmatoInvoiceNo == "" || b.ReceiptNumber == nil || !strings.HasPrefix(*b.ReceiptNumber, "TXN-") || s.Softmato == nil {
		return false, nil
	}
	_, err = s.Softmato.RequestRefund(ctx, softmato.Refund{TransactionID: *b.ReceiptNumber, AmountMinor: *b.Settlement.Refund * 100,
		Reason: "Booking " + b.Code + " ended (" + b.Status + ")."}, "hh-refund:"+b.ID.Hex())
	return false, err
}
