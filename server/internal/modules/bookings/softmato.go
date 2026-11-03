package bookings

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
)

// SettleFromSoftmato is the webhook's booking branch: finds the booking that
// carries Softmato's invoice number and settles it (settleBookingFromSoftmato).
// found=false when no booking carries it.
func (s *Signed) SettleFromSoftmato(ctx context.Context, invoiceNo string, now time.Time) (outcome, bookingID string, found bool, err error) {
	var b Booking
	err = s.db.Collection("bookings").FindOne(ctx, bson.D{{Key: "softmatoInvoiceNo", Value: invoiceNo}}).Decode(&b)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	outcome, err = s.settleSoftmato(ctx, &b, now, func(string) {})
	return outcome, b.ID.Hex(), true, err
}

// settleSoftmato is settleBookingFromSoftmato: paid, unpaid, no_document or
// refund_due. Asks Softmato rather than trusting the caller: the invoice must
// read paid.
func (s *Signed) settleSoftmato(ctx context.Context, b *Booking, now time.Time, step func(string)) (string, error) {
	if b.SoftmatoInvoiceNo == nil || *b.SoftmatoInvoiceNo == "" {
		return "no_document", nil
	}
	if b.PaymentVerifiedAt != nil {
		return "paid", nil
	}
	if s.Softmato == nil {
		return "", errors.New("softmato client is not configured")
	}
	detail, err := s.Softmato.GetInvoice(ctx, *b.SoftmatoInvoiceNo)
	if err != nil {
		return "", err
	}
	if detail == nil {
		return "no_document", nil
	}
	if detail.Status != "paid" {
		return "unpaid", nil
	}
	now = now.UTC().Truncate(time.Millisecond)
	// The money is in whoever wins the move below, so it gets its row first: one
	// row however many settlers run (softmatoInvoiceNo is uniquely indexed).
	_, err = s.db.Collection("bookingpayments").UpdateOne(ctx, bson.D{{Key: "bookingId", Value: b.ID}, {Key: "softmatoInvoiceNo", Value: *b.SoftmatoInvoiceNo}},
		bson.D{{Key: "$setOnInsert", Value: bson.D{{Key: "amount", Value: b.Total()}, {Key: "hostelId", Value: b.HostelID}, {Key: "reviewedAt", Value: now}, {Key: "status", Value: "APPROVED"},
			{Key: "submittedAt", Value: now}, {Key: "userId", Value: b.UserID}, {Key: "proofAssetId", Value: nil}, {Key: "reference", Value: nil}, {Key: "note", Value: nil},
			{Key: "reviewedBy", Value: nil}, {Key: "reviewNote", Value: nil}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}}},
		options.UpdateOne().SetUpsert(true))
	if err != nil && !mongo.IsDuplicateKeyError(err) {
		return "", err
	}
	if b.Status == "AWAITING_PAYMENT" {
		step("record")
		// Softmato's transaction number is the receipt the guest is sent.
		var receipt *string
		if n := len(detail.Payments); n > 0 && detail.Payments[n-1].TransactionID != "" {
			receipt = &detail.Payments[n-1].TransactionID
		}
		paid, err := s.MarkPaid(ctx, b, nil, now, "AWAITING_PAYMENT", receipt)
		if err != nil {
			return "", err
		}
		if paid != nil {
			return "paid", nil
		}
	}
	// Lost the move: the other settler won, or the booking ended first.
	var current Booking
	err = s.db.Collection("bookings").FindOne(ctx, bson.D{{Key: "_id", Value: b.ID}}).Decode(&current)
	if errors.Is(err, mongo.ErrNoDocuments) || (err == nil && current.PaymentVerifiedAt != nil) {
		return "paid", nil
	}
	if err != nil {
		return "", err
	}
	_, err = s.db.Collection("bookingtransfers").UpdateOne(ctx, bson.D{{Key: "bookingId", Value: current.ID}, {Key: "kind", Value: "REFUND"}},
		bson.D{{Key: "$setOnInsert", Value: bson.D{{Key: "hostelId", Value: current.HostelID}, {Key: "userId", Value: current.UserID}, {Key: "amount", Value: jsInt(current.Total())}, {Key: "status", Value: "DUE"},
			{Key: "sentAt", Value: nil}, {Key: "sentBy", Value: nil}, {Key: "transactionId", Value: nil}, {Key: "proofAssetId", Value: nil}, {Key: "note", Value: nil}, {Key: "documentNumber", Value: nil},
			{Key: "destination", Value: bson.D{{Key: "bankName", Value: ""}, {Key: "holderName", Value: ""}, {Key: "method", Value: nil}, {Key: "numberLast4", Value: ""}}},
			{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}}}, options.UpdateOne().SetUpsert(true))
	if err != nil {
		return "", err
	}
	slog.ErrorContext(ctx, "Booking fee arrived after the booking ended; full refund raised.", "category", "payments", "bookingId", current.ID.Hex(), "softmatoInvoiceNo", *b.SoftmatoInvoiceNo, "status", current.Status)
	if err := s.Audit.Write(ctx, audit.Entry{ActorType: "SYSTEM", Action: "BOOKING_PAID_AFTER_END", EntityType: "Booking", EntityID: current.ID.Hex(), HostelID: current.HostelID,
		Metadata: bson.D{{Key: "code", Value: current.Code}, {Key: "fee", Value: current.Fee}, {Key: "status", Value: current.Status}, {Key: "total", Value: current.Total()}}}); err != nil {
		slog.WarnContext(ctx, "booking paid-after-end audit failed", "error", err)
	}
	return "refund_due", nil
}

// MarkPaid is markBookingPaid: moves the booking out of `from` into
// AWAITING_HOSTEL as a compare-and-set, numbers the receipt only once the move
// is won, tells the guest and the hostel. nil when another settler won.
// TS threw BOOKING_NOT_IN_REVIEW for a lost move; callers treat that as nil.
func (s *Signed) MarkPaid(ctx context.Context, b *Booking, actor *bson.ObjectID, now time.Time, from string, softmatoReceipt *string) (*Booking, error) {
	answerBy := now.Add(time.Duration(b.Terms.HostelAnswerHours * float64(time.Hour)))
	var by any
	if actor != nil {
		by = *actor
	}
	var paid Booking
	err := s.db.Collection("bookings").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: b.ID}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{from}}}}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "hostelAnswerBy", Value: answerBy}, {Key: "paymentVerifiedAt", Value: now}, {Key: "paymentVerifiedBy", Value: by},
			{Key: "status", Value: "AWAITING_HOSTEL"}, {Key: "isOpen", Value: true}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&paid)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	receipt := ""
	if softmatoReceipt != nil {
		receipt = *softmatoReceipt
	} else if receipt, err = s.allocate(ctx, "BOOKING_RECEIPT", "HH-BKR", now); err != nil {
		return nil, err
	}
	paid.ReceiptNumber = &receipt
	if _, err := s.db.Collection("bookings").UpdateOne(ctx, bson.D{{Key: "_id", Value: paid.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "receiptNumber", Value: receipt}, {Key: "updatedAt", Value: now}}}}); err != nil {
		return nil, err
	}
	// Both papers on one mail; Softmato emails its own receipt, so ours rides
	// only when they did not take the fee.
	var papers []email.Attachment
	if paid.SoftmatoInvoiceNo == nil || *paid.SoftmatoInvoiceNo == "" {
		papers = append(papers, s.receiptAttachment(ctx, &paid)...)
	}
	papers = append(papers, s.attachment(ctx, &paid)...)
	m := email.BookingPaymentVerified(facts(&paid), s.appURL(guestPath(&paid)), whenText(answerBy), paid.Guest.Name, whenText(now), receipt)
	s.notifyGuest(ctx, &paid, "booking_payment_verified", fmt.Sprintf("Payment received for %s. %s answers by %s.", paid.Code, paid.HostelSnapshot.Name, whenText(answerBy)),
		&m, papers, "Booking fee received", "BOOKING_PAYMENT_VERIFIED")

	// The hostel may have gone while the payment waited: the money goes straight back.
	var hostel struct {
		IsDeleted bool   `bson:"isDeleted"`
		Status    string `bson:"status"`
	}
	err = s.db.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: paid.HostelID}}, options.FindOne().SetProjection(bson.D{{Key: "isDeleted", Value: 1}, {Key: "status", Value: 1}})).Decode(&hostel)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	if err != nil || hostel.IsDeleted || hostel.Status != "PUBLISHED" {
		reason := "The hostel is no longer listed."
		ended, err := s.endBooking(ctx, &paid, endInput{actor: actor, from: "AWAITING_HOSTEL", reason: &reason, status: "CANCELLED_BY_PLATFORM"}, now)
		if err != nil || ended == nil {
			return &paid, err
		}
		return ended, nil
	}
	share := settleBooking(now, paid.ConfirmedAt, "CHECKED_IN", paid.Fee, paid.Stay, paid.Terms).HostelShare
	stay := ""
	if paid.Stay != nil {
		stay = fmt.Sprintf("%d nights (%s) in ", paid.Stay.Nights, stayDatesText(paid.Stay))
	}
	s.notifyHostel(ctx, &paid, "booking_request", paid.Guest.Name+" booked "+stay+"a "+email.RoomTypeLabel(paid.RoomType)+". Answer by "+whenText(answerBy)+".",
		func(name string) email.Content {
			return email.BookingRequest(whenText(answerBy), paid.Terms.HostelAnswerHours, s.appURL(hostelPath(&paid)), paid.Code, paid.Guest.Name, paid.Guest.Phone,
				paid.Terms.HoldDays, paid.HostelSnapshot.Name, share, name, paid.RoomType)
		}, "HIGH", "New booking to confirm", "BOOKING_REQUEST")
	return &paid, nil
}

// receiptAttachment is bookingDocumentAttachment("receipt"): nil when it cannot be drawn.
func (s *Signed) receiptAttachment(ctx context.Context, b *Booking) []email.Attachment {
	if b.ReceiptNumber == nil || *b.ReceiptNumber == "" {
		return nil
	}
	issuer, err := s.loadIssuer(ctx)
	if err != nil {
		return nil
	}
	data, err := renderDocument(documentLayout("receipt", b, nil, issuer))
	if err != nil {
		slog.WarnContext(ctx, "booking_document_attachment_failed", "code", b.Code, "kind", "receipt", "error", err)
		return nil
	}
	return []email.Attachment{{Content: data, Filename: documentFileName(*b.ReceiptNumber)}}
}
