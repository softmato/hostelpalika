package bookings

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/softmato"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

var objectIDRe = regexp.MustCompile(`(?i)^[a-f\d]{24}$`)

// A booking proof must be a fresh upload: older than this and it is refused.
const proofMaxAge = 24 * time.Hour

func (s *Signed) registerCheckout(b *gin.RouterGroup) {
	b.POST("/:id/checkout", s.checkout)
	b.POST("/:id/payment", s.payment)
	b.GET("/:id/return", s.returnState)
}

func payErr(status int, code, msg string) error { return httpx.NewError(status, code, msg, nil) }

var (
	errNotAwaitingPayment = payErr(http.StatusConflict, "BOOKING_NOT_AWAITING_PAYMENT", "This booking is not waiting for payment.")
	errBookingExpired     = payErr(http.StatusGone, "BOOKING_EXPIRED", "The time to pay for this booking has run out. Book again if the room is still free.")
)

// payable is the gate both ways of paying share: awaiting payment and in time.
// A booking past its deadline is ended here, as TS does on any touch.
func (s *Signed) payable(ctx context.Context, b *Booking, now time.Time) error {
	if b.Status != "AWAITING_PAYMENT" {
		return errNotAwaitingPayment
	}
	if !b.PaymentDueBy.After(now) {
		if _, err := s.expireUnpaid(ctx, b, now); err != nil {
			return err
		}
		return errBookingExpired
	}
	return nil
}

func (s *Signed) task(b *Booking) func(context.Context) error {
	return func(ctx context.Context) error {
		s.rememberTask(ctx, "BOOKING_PAYMENT", b.ID.Hex(), b.Guest.Email, b.Guest.Name, s.appURL(guestPath(b)))
		return nil
	}
}

// ensureInvoice is ensureBookingInvoice: Softmato's invoice for the booking (its
// external_ref makes a second call return the same one), numbered on the booking
// the first time.
func (s *Signed) ensureInvoice(ctx context.Context, b *Booking) (string, error) {
	lines := []softmato.InvoiceLine{{Description: fmt.Sprintf("Booking fee: %s, %s (%s)", b.HostelSnapshot.Name, email.RoomTypeLabel(b.RoomType), b.Code), Quantity: 1, UnitPriceMinor: b.Fee * 100}}
	if b.Stay != nil {
		lines = append(lines, softmato.InvoiceLine{Description: fmt.Sprintf("Short stay: %d nights, %s", b.Stay.Nights, stayDatesText(b.Stay)), Quantity: int(b.Stay.Nights), UnitPriceMinor: b.Stay.DailyRate * 100})
	}
	inv, err := s.Softmato.CreateInvoice(ctx, softmato.CreateInvoice{
		Customer:    softmato.Customer{ExternalRef: "hh-guest:" + b.UserID.Hex(), Name: b.Guest.Name, Email: b.Guest.Email},
		DueAt:       b.PaymentDueBy.UTC().Format("2006-01-02T15:04:05.000Z"),
		ExternalRef: "hh-bkg:" + b.ID.Hex(), Lines: lines})
	if err != nil {
		return "", err
	}
	if b.SoftmatoInvoiceNo == nil || *b.SoftmatoInvoiceNo == "" {
		no := inv.InvoiceID
		if inv.InvoiceNo != nil && *inv.InvoiceNo != "" {
			no = *inv.InvoiceNo
		}
		// Only where none is set: two raisers write the same number, never a second.
		if _, err := s.db.Collection("bookings").UpdateOne(ctx, bson.D{{Key: "_id", Value: b.ID}, {Key: "softmatoInvoiceNo", Value: bson.D{{Key: "$in", Value: bson.A{nil, ""}}}}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "softmatoInvoiceNo", Value: no}}}}); err != nil {
			return "", err
		}
		b.SoftmatoInvoiceNo = &no
	}
	return inv.InvoiceID, nil
}

// raiseInvoiceSoon is raiseBookingInvoiceSoon, run as the booking is made: an
// outage is remembered for the retry job, any other failure only logged (the
// guest can still pay by screenshot, and checkout raises it again).
func (s *Signed) raiseInvoiceSoon(ctx context.Context, b *Booking) {
	if !s.SoftmatoOn || s.Softmato == nil {
		return
	}
	if _, err := s.ensureInvoice(ctx, b); err != nil {
		if softmato.IsDown(err) {
			_ = s.task(b)(ctx)
			return
		}
		slog.ErrorContext(ctx, "Booking invoice not raised.", "category", "payments", "bookingId", b.ID.Hex(), "error", err.Error())
	}
}

// checkout is POST /bookings/:id/checkout: Softmato's hosted checkout for the
// booking fee, streamed as invoice → session.
func (s *Signed) checkout(c *gin.Context) {
	p, err := s.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	via := c.Query("via") == "app"
	httpx.Progress(c, "Checkout opened", func(step func(string)) (any, error) {
		if !s.SoftmatoOn || s.Softmato == nil {
			return nil, payErr(http.StatusServiceUnavailable, "ONLINE_PAYMENT_UNAVAILABLE", "Online payment is not set up on this deployment yet.")
		}
		step("invoice")
		b, err := s.loadOwn(c, c.Param("id"), p)
		if err != nil {
			return nil, err
		}
		if err := s.payable(c, b, time.Now()); err != nil {
			return nil, err
		}
		invoiceID, err := s.ensureInvoice(c, b)
		if err != nil {
			return nil, softmato.Unless(c, err, s.task(b))
		}
		step("session")
		ret := url.Values{"booking": {b.ID.Hex()}}
		if via {
			ret.Set("via", "app")
		}
		session, err := s.Softmato.CreateCheckout(c, invoiceID, strings.TrimRight(s.Outbound, "/")+"/checkout/return?"+ret.Encode())
		if err != nil {
			return nil, softmato.Unless(c, err, s.task(b))
		}
		return ordered.Map{{Key: "checkoutUrl", Value: session.CheckoutURL}, {Key: "expiresAt", Value: session.ExpiresAt}}, nil
	})
}

// returnState is GET /bookings/:id/return: the page Softmato sends the guest
// back to settles from Softmato's own word, streamed as confirm → record → activate.
func (s *Signed) returnState(c *gin.Context) {
	p, err := s.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	c.Header("Cache-Control", "private, no-store")
	httpx.Progress(c, "Return state read", func(step func(string)) (any, error) {
		state := func(v ordered.Map) (any, error) { return ordered.Map{{Key: "state", Value: v}}, nil }
		b, err := s.loadOwn(c, c.Param("id"), p)
		if err != nil {
			return state(ordered.Map{{Key: "kind", Value: "unknown"}})
		}
		if (b.SoftmatoInvoiceNo == nil || *b.SoftmatoInvoiceNo == "") && b.PaymentVerifiedAt == nil {
			return state(ordered.Map{{Key: "kind", Value: "unpaid"}})
		}
		step("confirm")
		settled, err := s.settleSoftmato(c, b, time.Now(), step)
		if err != nil {
			slog.ErrorContext(c, "Booking return could not settle from Softmato.", "category", "payments", "bookingId", b.ID.Hex(), "error", err.Error())
			settled = "no_document"
		}
		switch settled {
		case "unpaid":
			return state(ordered.Map{{Key: "kind", Value: "unpaid"}})
		case "no_document":
			return state(ordered.Map{{Key: "kind", Value: "pending_document"}})
		case "refund_due":
			return state(ordered.Map{{Key: "code", Value: b.Code}, {Key: "kind", Value: "booking_refund"}})
		}
		step("activate")
		var paid Booking
		answerBy := any(nil)
		if err := s.db.Collection("bookings").FindOne(c, bson.D{{Key: "_id", Value: b.ID}}).Decode(&paid); err == nil && paid.HostelAnswerBy != nil {
			answerBy = paid.HostelAnswerBy.UTC().Format("2006-01-02T15:04:05.000Z")
		}
		return state(ordered.Map{{Key: "code", Value: b.Code}, {Key: "hostelAnswerBy", Value: answerBy}, {Key: "hostelName", Value: b.HostelSnapshot.Name}, {Key: "kind", Value: "booking_paid"}})
	})
}

// loadProof is loadBookingProof: the guest's own fresh screenshot, never a file
// we issued. A missing file and somebody else's answer alike.
func (s *Signed) loadProof(ctx context.Context, raw, actor string, now time.Time) (bson.ObjectID, error) {
	notOwned := payErr(http.StatusForbidden, "PROOF_NOT_OWNED", "That file is not yours to send. Attach the screenshot again.")
	id, err := bson.ObjectIDFromHex(raw)
	if err != nil {
		return id, notOwned
	}
	var a struct {
		HostelID  *bson.ObjectID `bson:"hostelId"`
		Kind      string         `bson:"kind"`
		OwnerID   *bson.ObjectID `bson:"ownerId"`
		SystemDoc *string        `bson:"systemDocumentKind"`
		Completed *time.Time     `bson:"uploadCompletedAt"`
	}
	err = s.db.Collection("fileassets").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}}).Decode(&a)
	if errors.Is(err, mongo.ErrNoDocuments) || (err == nil && (a.OwnerID == nil || a.OwnerID.Hex() != actor || a.Kind != "BOOKING_PAYMENT_PROOF" || a.HostelID != nil)) {
		return id, notOwned
	}
	if err != nil {
		return id, err
	}
	if a.Completed == nil || a.Completed.Before(now.Add(-proofMaxAge)) {
		return id, payErr(http.StatusUnprocessableEntity, "PROOF_UPLOAD_INCOMPLETE", "That upload did not finish or has expired. Attach the screenshot again.")
	}
	if a.SystemDoc != nil && *a.SystemDoc != "" {
		return id, payErr(http.StatusUnprocessableEntity, "PROOF_IS_OUR_DOCUMENT", "That is a document we issued, not proof of your payment. Attach the screenshot from your banking app.")
	}
	return id, nil
}

// payment is POST /bookings/:id/payment: the guest's screenshot for the platform
// to check.
func (s *Signed) payment(c *gin.Context) {
	p, err := s.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	note, _ := f.Str("note", valid.S{Opt: true, Trim: true, Max: 500})
	proofRaw, _ := f.Str("proofAssetId", valid.S{Trim: true, Re: objectIDRe, ReMsg: "Not a valid id."})
	reference, _ := f.Str("reference", valid.S{Opt: true, Trim: true, Max: 64})
	if err := f.Is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	b, err := s.loadOwn(c, c.Param("id"), p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if b.Status == "PAYMENT_IN_REVIEW" {
		httpx.Fail(c, payErr(http.StatusConflict, "BOOKING_PAYMENT_IN_REVIEW", "We already have your screenshot and are checking it."))
		return
	}
	if err := s.payable(c, b, now); err != nil {
		httpx.Fail(c, err)
		return
	}
	proof, err := s.loadProof(c, proofRaw, p.UserID, now)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	orNull := func(v string) any {
		if v == "" {
			return nil
		}
		return v
	}
	// The move and its payment row together: TS moved the booking into review
	// and then created the row, so a failure between left a booking in review
	// with nothing for anyone to check (P8-7).
	var moved Booking
	paymentID := bson.NewObjectID()
	err = appmongo.InTx(c, s.db, func(ctx context.Context) error {
		err := s.db.Collection("bookings").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: b.ID}, {Key: "status", Value: "AWAITING_PAYMENT"}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "paymentSubmittedAt", Value: now}, {Key: "status", Value: "PAYMENT_IN_REVIEW"}, {Key: "updatedAt", Value: now}}}},
			options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&moved)
		if errors.Is(err, mongo.ErrNoDocuments) {
			return errNotAwaitingPayment
		}
		if err != nil {
			return err
		}
		_, err = s.db.Collection("bookingpayments").InsertOne(ctx, bson.D{{Key: "_id", Value: paymentID}, {Key: "bookingId", Value: b.ID}, {Key: "userId", Value: b.UserID}, {Key: "hostelId", Value: b.HostelID},
			{Key: "amount", Value: jsInt(b.Total())}, {Key: "proofAssetId", Value: proof}, {Key: "reference", Value: orNull(reference)}, {Key: "note", Value: orNull(note)}, {Key: "status", Value: "IN_REVIEW"},
			{Key: "submittedAt", Value: now}, {Key: "reviewedAt", Value: nil}, {Key: "reviewedBy", Value: nil}, {Key: "reviewNote", Value: nil}, {Key: "softmatoInvoiceNo", Value: nil},
			{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}})
		return err
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, _ := bson.ObjectIDFromHex(p.UserID)
	if err := s.Audit.Write(c, audit.Entry{ActorID: actor, HostelID: b.HostelID, Action: "BOOKING_PAYMENT_SUBMITTED", EntityType: "BookingPayment", EntityID: paymentID.Hex(),
		Metadata: bson.D{{Key: "amount", Value: jsInt(b.Total())}, {Key: "code", Value: b.Code}, {Key: "proofAssetId", Value: proof.Hex()}}}); err != nil {
		slog.WarnContext(c, "booking payment audit failed", "error", err)
	}
	checkBy := whenText(now.Add(time.Duration(s.BookingConfig(c).PaymentCheckHours * float64(time.Hour))))
	guest := email.BookingProofReceived(facts(&moved), s.appURL(guestPath(&moved)), checkBy, moved.Guest.Name, reference)
	s.notifyGuest(c, &moved, "booking_proof_received", "We are checking your payment for "+moved.Code+". You will hear from us by "+checkBy+".", &guest, nil, "Payment screenshot received", "BOOKING_PROOF_RECEIVED")
	desk := email.BookingProofToCheck(moved.Total(), checkBy, moved.Code, moved.Guest.Name, moved.HostelSnapshot.Name, s.appURL(platformBookingsPath+"?tab=payments"), reference)
	s.notifyPlatform(c, &moved, "booking_proof_to_check", moved.Guest.Name+" sent a screenshot for Rs "+groupIN(moved.Total())+" ("+moved.Code+").", &desk, "payments", "Booking payment to check", "BOOKING_PROOF_TO_CHECK")
	detail, err := s.detailFor(c, &moved, now)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "booking", Value: detail}}, "Screenshot sent. We will check it and email you.")
}
