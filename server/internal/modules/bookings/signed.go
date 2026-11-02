package bookings

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/ratelimit"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Signed is the booker's own surface (booking.service.ts, booking-answer's
// cancelMyBooking, booking-lifecycle.ts, booking-notify.ts). Paying moves in
// Phase 8 with the Softmato client; `submitBookingPayment` goes with it.
type Signed struct {
	*Service
	Guards   *authz.Guards
	Limiter  *ratelimit.Limiter
	Notify   *notifications.Service
	Mail     *email.Sender
	Audit    *audit.Log
	RT       *realtime.Client
	Bump     realtime.Bumper
	Outbound string
	// FinanceKeys is masterKeys(): missing or bad, sealing refuses as TS does.
	FinanceKeys func() ([]crypto.MasterKey, error)
	// SoftmatoOn is isSoftmatoConfigured.
	SoftmatoOn bool
}

// Booking is BookingRecord.
type Booking struct {
	ID          bson.ObjectID  `bson:"_id"`
	BedHeld     bool           `bson:"bedHeld"`
	CheckedInAt *time.Time     `bson:"checkedInAt"`
	Code        string         `bson:"code"`
	ConfirmedAt *time.Time     `bson:"confirmedAt"`
	CreatedAt   time.Time      `bson:"createdAt"`
	Currency    string         `bson:"currency"`
	EndReason   *string        `bson:"endReason"`
	EndedAt     *time.Time     `bson:"endedAt"`
	EndedBy     *bson.ObjectID `bson:"endedBy"`
	Fee         int64          `bson:"fee"`
	Guest       struct {
		Email string `bson:"email"`
		Name  string `bson:"name"`
		Phone string `bson:"phone"`
	} `bson:"guest"`
	HoldEndsAt     *time.Time    `bson:"holdEndsAt"`
	HostelAnswerBy *time.Time    `bson:"hostelAnswerBy"`
	HostelID       bson.ObjectID `bson:"hostelId"`
	HostelSnapshot struct {
		Address string `bson:"address"`
		Name    string `bson:"name"`
		Phone   string `bson:"phone"`
		Slug    string `bson:"slug"`
	} `bson:"hostelSnapshot"`
	InvoiceNumber    string    `bson:"invoiceNumber"`
	IsOpen           bool      `bson:"isOpen"`
	Kind             string    `bson:"kind"`
	MonthlyRent      int64     `bson:"monthlyRent"`
	PaymentDueBy     time.Time `bson:"paymentDueBy"`
	PaymentRejection *struct {
		At     *time.Time `bson:"at"`
		Reason *string    `bson:"reason"`
	} `bson:"paymentRejection"`
	PaymentSubmittedAt *time.Time `bson:"paymentSubmittedAt"`
	PaymentVerifiedAt  *time.Time `bson:"paymentVerifiedAt"`
	PlannedMoveIn      *time.Time `bson:"plannedMoveIn"`
	ReceiptNumber      *string    `bson:"receiptNumber"`
	SoftmatoInvoiceNo  *string    `bson:"softmatoInvoiceNo"`
	RefundAccount      struct {
		BankName    string `bson:"bankName"`
		HolderName  string `bson:"holderName"`
		Method      string `bson:"method"`
		NumberLast4 string `bson:"numberLast4"`
	} `bson:"refundAccount"`
	RoomType   string `bson:"roomType"`
	Settlement *struct {
		HostelShare   *int64   `bson:"hostelShare"`
		Refund        *int64   `bson:"refund"`
		RefundPercent *float64 `bson:"refundPercent"`
	} `bson:"settlement"`
	Status string        `bson:"status"`
	Stay   *Stay         `bson:"stay"`
	Terms  Terms         `bson:"terms"`
	UserID bson.ObjectID `bson:"userId"`
}

// Total is amountDue: the fee, plus a short stay's nights.
func (b *Booking) Total() int64 {
	if b.Stay != nil {
		return b.Fee + b.Stay.Amount
	}
	return b.Fee
}

// Destination is a transfer's account.
type Destination struct {
	BankName    string  `bson:"bankName"`
	HolderName  string  `bson:"holderName"`
	Method      *string `bson:"method"`
	NumberLast4 string  `bson:"numberLast4"`
}

// Transfer is TransferRecord.
type Transfer struct {
	ID             bson.ObjectID `bson:"_id"`
	Amount         int64         `bson:"amount"`
	BookingID      bson.ObjectID `bson:"bookingId"`
	Destination    *Destination  `bson:"destination"`
	DocumentNumber *string       `bson:"documentNumber"`
	SentAt         *time.Time    `bson:"sentAt"`
	Status         string        `bson:"status"`
	TransactionID  *string       `bson:"transactionId"`
}

var statusLabels = map[string]string{
	"AWAITING_HOSTEL": "Waiting for the hostel", "AWAITING_PAYMENT": "Waiting for payment", "CANCELLED_BY_HOSTEL": "Cancelled by the hostel",
	"CANCELLED_BY_PLATFORM": "Cancelled by " + platformName, "CANCELLED_BY_USER": "Cancelled", "CHECKED_IN": "Moved in", "CONFIRMED": "Confirmed",
	"DECLINED": "Declined by the hostel", "EXPIRED": "Not paid in time", "HOSTEL_NO_RESPONSE": "Hostel did not answer", "NO_SHOW": "Did not move in", "PAYMENT_IN_REVIEW": "Checking payment",
}

func masked(last4 string) string { return "••••" + last4 }

// destinationText is destinationText: `eSewa ••••4321 (Sita Sharma)`.
func destinationText(d *Destination) string {
	if d == nil || d.Method == nil || *d.Method == "" {
		return ""
	}
	parts := []string{}
	for _, p := range []string{payoutLabels[*d.Method], d.BankName, masked(d.NumberLast4)} {
		if p != "" {
			parts = append(parts, p)
		}
	}
	return strings.Join(parts, " ") + " (" + d.HolderName + ")"
}

func isoOf(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := httpx.ISO(*t)
	return &s
}

type cancelPreviewOut struct {
	Allowed       bool    `json:"allowed"`
	Refund        int64   `json:"refund"`
	RefundPercent float64 `json:"refundPercent"`
}

func cancelPreview(b *Booking, now time.Time) cancelPreviewOut {
	if !b.IsOpen {
		return cancelPreviewOut{}
	}
	if b.Status == "CONFIRMED" && b.ConfirmedAt != nil {
		s := settleBooking(now, b.ConfirmedAt, "CANCELLED_BY_USER", b.Fee, b.Stay, b.Terms)
		return cancelPreviewOut{true, s.Refund, s.RefundPercent}
	}
	if b.Status == "PAYMENT_IN_REVIEW" {
		return cancelPreviewOut{}
	}
	if b.Status == "AWAITING_HOSTEL" {
		return cancelPreviewOut{true, b.Total(), 100}
	}
	return cancelPreviewOut{Allowed: true}
}

type snapshotOut struct {
	Address string `json:"address"`
	ID      string `json:"id"`
	Name    string `json:"name"`
	Phone   string `json:"phone"`
	Slug    string `json:"slug"`
}

type rejectionOut struct {
	At     *string `json:"at"`
	Reason *string `json:"reason"`
}

type refundOut struct {
	Amount         int64   `json:"amount"`
	DocumentNumber *string `json:"documentNumber"`
	SentAt         *string `json:"sentAt"`
	Status         string  `json:"status"`
	TransactionID  *string `json:"transactionId"`
}

type refundAccountOut struct {
	HolderName   string `json:"holderName"`
	MaskedNumber string `json:"maskedNumber"`
	Method       string `json:"method"`
	MethodLabel  string `json:"methodLabel"`
}

type noShowOut struct {
	After         string  `json:"after"`
	Refund        int64   `json:"refund"`
	RefundPercent float64 `json:"refundPercent"`
}

type stepOut struct {
	PolicyRow
	Until string `json:"until"`
}

type scheduleOut struct {
	NoShow noShowOut `json:"noShow"`
	Steps  []stepOut `json:"steps"`
}

type settlementOut struct {
	Refund        int64   `json:"refund"`
	RefundPercent float64 `json:"refundPercent"`
}

type stayOut struct {
	Amount     int64  `json:"amount"`
	DailyRate  int64  `json:"dailyRate"`
	Dates      string `json:"dates"`
	HoldBlocks int64  `json:"holdBlocks"`
	MoveIn     string `json:"moveIn"`
	MoveOut    string `json:"moveOut"`
	Nights     int64  `json:"nights"`
}

// GuestView is GuestBookingView.
type GuestView struct {
	Cancel             cancelPreviewOut `json:"cancel"`
	CheckedInAt        *string          `json:"checkedInAt"`
	Code               string           `json:"code"`
	ConfirmedAt        *string          `json:"confirmedAt"`
	CreatedAt          string           `json:"createdAt"`
	Currency           string           `json:"currency"`
	EndReason          *string          `json:"endReason"`
	EndedAt            *string          `json:"endedAt"`
	Fee                int64            `json:"fee"`
	HoldEndsAt         *string          `json:"holdEndsAt"`
	Hostel             snapshotOut      `json:"hostel"`
	HostelAnswerBy     *string          `json:"hostelAnswerBy"`
	ID                 string           `json:"id"`
	InvoiceNumber      string           `json:"invoiceNumber"`
	Kind               string           `json:"kind"`
	MonthlyRent        int64            `json:"monthlyRent"`
	PaymentDueBy       string           `json:"paymentDueBy"`
	PaymentRejection   *rejectionOut    `json:"paymentRejection"`
	PaymentSubmittedAt *string          `json:"paymentSubmittedAt"`
	PaymentVerifiedAt  *string          `json:"paymentVerifiedAt"`
	PlannedMoveIn      *string          `json:"plannedMoveIn"`
	Policy             PolicySummary    `json:"policy"`
	ReceiptNumber      *string          `json:"receiptNumber"`
	Refund             *refundOut       `json:"refund"`
	RefundAccount      refundAccountOut `json:"refundAccount"`
	RoomType           string           `json:"roomType"`
	Schedule           *scheduleOut     `json:"schedule"`
	Settlement         *settlementOut   `json:"settlement"`
	Status             string           `json:"status"`
	StatusLabel        string           `json:"statusLabel"`
	Stay               *stayOut         `json:"stay"`
	Total              int64            `json:"total"`
}

func toGuestView(b *Booking, now time.Time, transfer *Transfer) GuestView {
	v := GuestView{
		Cancel: cancelPreview(b, now), CheckedInAt: isoOf(b.CheckedInAt), Code: b.Code, ConfirmedAt: isoOf(b.ConfirmedAt), CreatedAt: httpx.ISO(b.CreatedAt),
		Currency: b.Currency, EndReason: b.EndReason, EndedAt: isoOf(b.EndedAt), Fee: b.Fee, HoldEndsAt: isoOf(b.HoldEndsAt),
		Hostel:         snapshotOut{b.HostelSnapshot.Address, b.HostelID.Hex(), b.HostelSnapshot.Name, b.HostelSnapshot.Phone, b.HostelSnapshot.Slug},
		HostelAnswerBy: isoOf(b.HostelAnswerBy), ID: b.ID.Hex(), InvoiceNumber: b.InvoiceNumber, Kind: b.Kind, MonthlyRent: b.MonthlyRent, PaymentDueBy: httpx.ISO(b.PaymentDueBy),
		PaymentSubmittedAt: isoOf(b.PaymentSubmittedAt), PaymentVerifiedAt: isoOf(b.PaymentVerifiedAt), Policy: policySummary(b.Terms, b.Fee), ReceiptNumber: b.ReceiptNumber,
		RefundAccount: refundAccountOut{b.RefundAccount.HolderName, masked(b.RefundAccount.NumberLast4), b.RefundAccount.Method, payoutLabels[b.RefundAccount.Method]},
		RoomType:      b.RoomType, Status: b.Status, StatusLabel: statusLabels[b.Status], Total: b.Total(),
	}
	if v.Currency == "" {
		v.Currency = "NPR"
	}
	if v.Kind == "" {
		v.Kind = "MONTHLY"
	}
	if r := b.PaymentRejection; r != nil && r.Reason != nil && *r.Reason != "" {
		v.PaymentRejection = &rejectionOut{isoOf(r.At), r.Reason}
	}
	if b.PlannedMoveIn != nil {
		s := httpx.ISO(*b.PlannedMoveIn)[:10]
		v.PlannedMoveIn = &s
	}
	if t := transfer; t != nil {
		r := &refundOut{Amount: t.Amount, SentAt: isoOf(t.SentAt), Status: t.Status}
		if t.Status == "SENT" {
			r.DocumentNumber, r.TransactionID = t.DocumentNumber, t.TransactionID
		}
		v.Refund = r
	}
	if b.ConfirmedAt != nil {
		noShow := settlementFor(b.Fee, b.Terms.NoShowRefundPercent, b.Terms.HostelSharePercent)
		s := &scheduleOut{NoShow: noShowOut{httpx.ISO(addDays(*b.ConfirmedAt, b.Terms.HoldDays)), noShow.Refund, b.Terms.NoShowRefundPercent}, Steps: []stepOut{}}
		for _, row := range policyRows(b.Terms, b.Fee) {
			s.Steps = append(s.Steps, stepOut{row, httpx.ISO(addDays(*b.ConfirmedAt, row.ThroughDay))})
		}
		v.Schedule = s
	}
	if st := b.Settlement; st != nil && st.Refund != nil {
		pct := 0.0
		if st.RefundPercent != nil {
			pct = *st.RefundPercent
		}
		v.Settlement = &settlementOut{*st.Refund, pct}
	}
	if st := b.Stay; st != nil {
		v.Stay = &stayOut{st.Amount, st.DailyRate, stayDatesText(st), st.HoldBlocks, st.MoveIn.UTC().Format("2006-01-02"), st.MoveOut.UTC().Format("2006-01-02"), st.Nights}
	}
	return v
}

type qrOut struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}

type payOut struct {
	Amount     int64   `json:"amount"`
	CheckHours float64 `json:"checkHours"`
	PayBy      string  `json:"payBy"`
	QR         *qrOut  `json:"qr"`
	Reference  string  `json:"reference"`
}

// Detail is GuestBookingDetail.
type Detail struct {
	GuestView
	CoverPhotoURL *string `json:"coverPhotoUrl"`
	Pay           *payOut `json:"pay"`
}

func (s *Signed) detailFor(ctx context.Context, b *Booking, now time.Time) (*Detail, error) {
	var transfer *Transfer
	var t Transfer
	err := s.db.Collection("bookingtransfers").FindOne(ctx, bson.D{{Key: "bookingId", Value: b.ID}, {Key: "kind", Value: "REFUND"}}).Decode(&t)
	if err == nil {
		transfer = &t
	} else if !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	h, err := s.loadBookable(ctx, b.HostelID.Hex())
	if err != nil {
		return nil, err
	}
	d := &Detail{GuestView: toGuestView(b, now, transfer)}
	if h != nil {
		d.CoverPhotoURL = h.cover()
	}
	if b.Status == "AWAITING_PAYMENT" {
		ops := s.cfg.OperationsTyped(ctx)
		c := s.BookingConfig(ctx)
		pay := &payOut{Amount: b.Total(), CheckHours: c.PaymentCheckHours, PayBy: httpx.ISO(b.PaymentDueBy), Reference: b.Code}
		if ops.CollectionQrURL != "" {
			label := ops.CollectionQrLabel
			if label == "" {
				label = "Scan to pay"
			}
			pay.QR = &qrOut{label, ops.CollectionQrURL}
		}
		d.Pay = pay
	}
	return d, nil
}

/* ── The quote ── */

type quoteHostel struct {
	Address       string  `json:"address"`
	CoverPhotoURL *string `json:"coverPhotoUrl"`
	HostelType    *string `json:"hostelType"`
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	Phone         string  `json:"phone"`
	Slug          string  `json:"slug"`
}

type openOut struct {
	Code       string `json:"code"`
	HostelName string `json:"hostelName"`
	ID         string `json:"id"`
}

type quotePayment struct {
	CheckHours        float64 `json:"checkHours"`
	QrReady           bool    `json:"qrReady"`
	UnpaidWindowHours float64 `json:"unpaidWindowHours"`
}

type errOut struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type stayQuote struct {
	Fee        int64  `json:"fee"`
	HoldBlocks int64  `json:"holdBlocks"`
	MoveIn     string `json:"moveIn"`
	MoveOut    string `json:"moveOut"`
	Nights     int64  `json:"nights"`
	StayAmount int64  `json:"stayAmount"`
	Total      int64  `json:"total"`
}

type shortStayOut struct {
	Available bool        `json:"available"`
	DailyRate *int64      `json:"dailyRate"`
	Error     *errOut     `json:"error"`
	Limits    *stayLimits `json:"limits"`
	Quote     *stayQuote  `json:"quote"`
}

type quoteTerms struct {
	FeePercent        float64 `json:"feePercent"`
	HoldDays          float64 `json:"holdDays"`
	HostelAnswerHours float64 `json:"hostelAnswerHours"`
}

// Quote is BookingQuote.
type Quote struct {
	Available     bool           `json:"available"`
	Fee           *int64         `json:"fee"`
	Hostel        quoteHostel    `json:"hostel"`
	OpenBooking   *openOut       `json:"openBooking"`
	Payment       quotePayment   `json:"payment"`
	Policy        *PolicySummary `json:"policy"`
	PolicyVersion string         `json:"policyVersion"`
	Reason        *string        `json:"reason"`
	ReasonMessage *string        `json:"reasonMessage"`
	Room          fullRoom       `json:"room"`
	ShortStay     shortStayOut   `json:"shortStay"`
	Terms         quoteTerms     `json:"terms"`
}

var unavailableMessages = map[string]string{
	"BOOKINGS_OFF": "Room booking is not open yet.", "BOOKINGS_PAUSED": "This hostel is not taking bookings right now.", "FULL": "This room type is full.",
	"HOSTEL_NOT_LIVE": "This hostel is not listed right now.", "HOSTEL_SUSPENDED": "This hostel is not taking bookings right now.",
	"NOT_PRICED": "This room type has no rent set yet, so it cannot be booked.", "NO_PAYOUT_ACCOUNT": "This hostel is not taking bookings yet.", "ROOM_NOT_FOUND": "This hostel does not have that room type.",
}

func priceShortStay(a *fullAvailability, r *fullRoom, moveIn, moveOut string, c Config, now time.Time) (*Stay, error) {
	if a.ShortStays == nil || r.DailyRate == nil {
		return nil, httpx.NewError(409, "SHORT_STAYS_OFF", "This room does not take short stays.", nil)
	}
	return quoteStay(*r.DailyRate, c.HoldDays, c.ShortStayHostelSharePercent, a.ShortStays.MaxAdvanceDays, a.ShortStays.MaxNights, a.ShortStays.MinNights, moveIn, moveOut, now)
}

func (s *Signed) findOpen(ctx context.Context, userID bson.ObjectID) (*openOut, error) {
	var o struct {
		ID             bson.ObjectID `bson:"_id"`
		Code           string        `bson:"code"`
		HostelSnapshot struct {
			Name string `bson:"name"`
		} `bson:"hostelSnapshot"`
	}
	err := s.db.Collection("bookings").FindOne(ctx, bson.D{{Key: "isOpen", Value: true}, {Key: "userId", Value: userID}},
		options.FindOne().SetProjection(bson.D{{Key: "code", Value: 1}, {Key: "hostelSnapshot", Value: 1}})).Decode(&o)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &openOut{o.Code, o.HostelSnapshot.Name, o.ID.Hex()}, nil
}

func (s *Signed) quote(c *gin.Context) {
	now := time.Now()
	cfg := s.BookingConfig(c)
	p, err := s.Guards.Load(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var h *bookableHostel
	if ref := c.Query("hostel"); ref != "" {
		if h, err = s.loadBookable(c, ref); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	version, err := s.currentPolicyVersion(c, cfg)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if h == nil || h.IsDeleted || h.Status != "PUBLISHED" {
		httpx.Fail(c, httpx.NewError(404, "HOSTEL_NOT_FOUND", "Hostel not found.", nil))
		return
	}
	a, err := s.availabilityOf(c, h, cfg, now)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r := a.find(c.Query("roomType"))
	if r == nil {
		httpx.Fail(c, httpx.NewError(404, "ROOM_NOT_FOUND", unavailableMessages["ROOM_NOT_FOUND"], nil))
		return
	}
	terms := termsFromConfig(cfg)
	q := Quote{Available: r.Bookable, Fee: r.Fee, Hostel: quoteHostel{h.address(), h.cover(), h.HostelType, h.ID.Hex(), h.Name, h.phone(), h.Slug},
		Payment:       quotePayment{cfg.PaymentCheckHours, s.cfg.OperationsTyped(c).CollectionQrURL != "", cfg.UnpaidWindowHours},
		PolicyVersion: version, Reason: r.Reason, Room: *r, Terms: quoteTerms{terms.FeePercent, terms.HoldDays, terms.HostelAnswerHours}}
	if p != nil {
		id, _ := bson.ObjectIDFromHex(p.UserID)
		if q.OpenBooking, err = s.findOpen(c, id); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	if r.Fee != nil && *r.Fee != 0 {
		ps := policySummary(terms, *r.Fee)
		q.Policy = &ps
	}
	if r.Reason != nil {
		m := unavailableMessages[*r.Reason]
		q.ReasonMessage = &m
	}
	moveIn, moveOut := c.Query("moveIn"), c.Query("moveOut")
	q.ShortStay = shortStayOut{Available: a.ShortStays != nil && r.DailyRate != nil && r.Bookable, DailyRate: r.DailyRate, Limits: a.ShortStays}
	if q.ShortStay.Available && r.Fee != nil && *r.Fee != 0 && moveIn != "" && moveOut != "" {
		stay, err := priceShortStay(a, r, moveIn, moveOut, cfg, now)
		var be *httpx.Error
		switch {
		case errors.As(err, &be):
			q.ShortStay.Error = &errOut{be.ErrorCode, be.Message}
		case err != nil:
			httpx.Fail(c, err)
			return
		default:
			fee := *r.Fee * stay.HoldBlocks
			q.ShortStay.Quote = &stayQuote{fee, stay.HoldBlocks, moveIn, moveOut, stay.Nights, stay.Amount, fee + stay.Amount}
		}
	}
	httpx.OK(c, gin.H{"quote": q}, "Booking quote")
}

/* ── Creating ── */

const codeAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

func newBookingCode() string {
	b := []byte("BK-______")
	for i := 3; i < len(b); i++ {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(codeAlphabet))))
		if err != nil {
			panic(err)
		}
		b[i] = codeAlphabet[n.Int64()]
	}
	return string(b)
}

// allocateInvoice is allocate("BOOKING_INVOICE"): the fiscal year's next number.
func (s *Signed) allocateInvoice(ctx context.Context, now time.Time) (string, error) {
	fy := bs.FiscalYear(now)
	if fy == "" {
		return "", fmt.Errorf("cannot number a document dated %s: outside the Bikram Sambat table", httpx.ISO(now))
	}
	stamp := now.UTC().Truncate(time.Millisecond)
	var row struct {
		Sequence int64 `bson:"sequence"`
	}
	err := s.db.Collection("platformdocumentsequences").FindOneAndUpdate(ctx, bson.D{{Key: "fiscalYear", Value: fy}, {Key: "kind", Value: "BOOKING_INVOICE"}},
		bson.D{{Key: "$inc", Value: bson.D{{Key: "sequence", Value: 1}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: stamp}}},
			{Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: stamp}, {Key: "__v", Value: 0}}}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&row)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("HH-BKI-%s-%06d", fy, row.Sequence), nil
}

type refundInput struct{ BankName, Branch, HolderName, Method, Number string }

// parseRefundAccount is payoutAccountInputSchema, superRefine and transforms.
func parseRefundAccount(f *valid.Form) refundInput {
	var r refundInput
	f.Nest("refundAccount", false, func(sub *valid.Form) {
		if _, present := sub.M["bankName"]; present {
			r.BankName, _ = sub.Str("bankName", valid.S{Trim: true, Max: 120})
		}
		if _, present := sub.M["branch"]; present {
			r.Branch, _ = sub.Str("branch", valid.S{Trim: true, Max: 120})
		}
		r.HolderName, _ = sub.Str("holderName", valid.S{Trim: true, Min: 2, MinMsg: "Enter the name on the account.", Max: 120})
		r.Method, _ = sub.Enum("method", false, nil, "BANK", "ESEWA", "KHALTI")
		raw, _ := sub.Str("number", valid.S{Max: 40})
		r.Number = normalizePayoutNumber(raw)
		if sub.Hard {
			return
		}
		if r.Method == "BANK" {
			if valid.JSLen(r.BankName) < 2 {
				sub.Is.Add("bankName", "Enter the bank's name.")
			}
			if !bankNumber.MatchString(r.Number) {
				sub.Is.Add("number", "Enter the account number: 6 to 24 letters or digits.")
			}
			return
		}
		if !walletNumber.MatchString(r.Number) {
			sub.Is.Add("number", "Enter the 10-digit mobile number your "+payoutLabels[r.Method]+" account uses.")
		}
		r.BankName, r.Branch = "", ""
	})
	return r
}

func nullish(f *valid.Form, key string, o valid.S) string {
	if v, present := f.M[key]; !present || v == nil {
		return ""
	}
	s, _ := f.Str(key, o)
	return s
}

func refundScope(id bson.ObjectID) crypto.Scope {
	return crypto.Scope{HostelID: id.Hex(), Purpose: "BOOKING_REFUND_ACCOUNT"}
}

func (s *Signed) create(c *gin.Context) {
	if err := s.Limiter.Check(c, "booking-create", 10, 15*time.Minute); err != nil {
		httpx.Fail(c, err)
		return
	}
	p, err := s.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	source := "WEB"
	if c.GetHeader("authorization") != "" {
		source = "MOBILE"
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	d, err := s.createBooking(c, body, p, source)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, 201, gin.H{"booking": d}, "Booking created. Pay the booking fee to send it to the hostel.")
}

func (s *Signed) createBooking(ctx *gin.Context, body any, p *authz.Principal, source string) (*Detail, error) {
	if p.Role != authz.Public && p.Role != authz.Resident {
		return nil, httpx.NewError(403, "BOOKING_ACCOUNT_NOT_ALLOWED", "Room booking is for personal accounts. Sign in with your own account to book.", nil)
	}
	f := valid.NewForm(body)
	if f.M != nil {
		if v, _ := f.M["acceptPolicy"].(bool); !v {
			f.Is.Add("acceptPolicy", "Accept the refund policy to book.")
		}
	}
	hostelRef, _ := f.Str("hostel", valid.S{Trim: true, Min: 1, Max: 200})
	def := "MONTHLY"
	kind, _ := f.Enum("kind", false, &def, "MONTHLY", "SHORT_STAY")
	moveInRaw := nullish(f, "moveIn", valid.S{Trim: true, Max: 10})
	moveOutRaw := nullish(f, "moveOut", valid.S{Trim: true, Max: 10})
	planned := nullish(f, "plannedMoveIn", valid.S{Trim: true, Re: dayShape, ReMsg: "Use a date like 2026-09-20."})
	versionIn, _ := f.Str("policyVersion", valid.S{Trim: true, Min: 1, Max: 64})
	account := parseRefundAccount(f)
	roomType, _ := f.Str("roomType", valid.S{Trim: true, Min: 1, Max: 120})
	if err := f.Err(); err != nil {
		return nil, err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	cfg := s.BookingConfig(ctx)
	h, err := s.loadBookable(ctx, hostelRef)
	if err != nil {
		return nil, err
	}
	version, err := s.currentPolicyVersion(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if h == nil {
		return nil, httpx.NewError(404, "HOSTEL_NOT_FOUND", "Hostel not found.", nil)
	}
	a, err := s.availabilityOf(ctx, h, cfg, now)
	if err != nil {
		return nil, err
	}
	r := a.find(roomType)
	if r == nil {
		return nil, httpx.NewError(404, "ROOM_NOT_FOUND", unavailableMessages["ROOM_NOT_FOUND"], nil)
	}
	if !r.Bookable || r.Fee == nil || r.MonthlyRent == nil {
		reason := "NOT_PRICED"
		if r.Reason != nil {
			reason = *r.Reason
		}
		return nil, httpx.NewError(409, "BOOKING_UNAVAILABLE_"+reason, unavailableMessages[reason], nil)
	}
	terms := termsFromConfig(cfg)
	if version != versionIn {
		return nil, httpx.NewError(409, "BOOKING_POLICY_CHANGED", "The booking terms changed while this page was open. Read the updated refund policy and accept it again.", gin.H{"policyVersion": version})
	}
	userID, _ := bson.ObjectIDFromHex(p.UserID)
	var user struct {
		Email *string `bson:"email"`
		Name  string  `bson:"name"`
		Phone *string `bson:"phone"`
	}
	err = s.db.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: userID}}, options.FindOne().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "name", Value: 1}, {Key: "phone", Value: 1}})).Decode(&user)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	if user.Email == nil || *user.Email == "" {
		return nil, httpx.NewError(422, "BOOKING_EMAIL_REQUIRED", "Add an email address to your account first. Your invoice and receipt are sent there.", nil)
	}
	open, err := s.findOpen(ctx, userID)
	if err != nil {
		return nil, err
	}
	if open != nil {
		return nil, httpx.NewError(409, "OPEN_BOOKING_EXISTS", "You already have an open booking ("+open.Code+" at "+open.HostelName+"). Finish or cancel it first.", ordered.Map{{Key: "bookingId", Value: open.ID}, {Key: "code", Value: open.Code}})
	}
	n, err := s.db.Collection("residents").CountDocuments(ctx, bson.D{{Key: "hostelId", Value: h.ID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
		{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "PENDING"}}}}, {Key: "userId", Value: userID}}, options.Count().SetLimit(1))
	if err != nil {
		return nil, err
	}
	if n > 0 {
		return nil, httpx.NewError(409, "ALREADY_RESIDENT", "You already live at this hostel.", nil)
	}
	var stay *Stay
	fee := *r.Fee
	var plannedMoveIn *time.Time
	if kind == "SHORT_STAY" {
		if stay, err = priceShortStay(a, r, moveInRaw, moveOutRaw, cfg, now); err != nil {
			return nil, err
		}
		fee *= stay.HoldBlocks
		plannedMoveIn = &stay.MoveIn
	} else if planned != "" {
		date := parseDay(planned)
		today := bs.Today(now)
		if date == nil || date.Before(today) || date.After(today.Add(60*oneDay)) {
			return nil, httpx.NewError(422, "VALIDATION_ERROR", "Pick a move-in date between today and 60 days from now.", nil)
		}
		plannedMoveIn = date
	}
	bookingID := bson.NewObjectID()
	invoice, err := s.allocateInvoice(ctx, now)
	if err != nil {
		return nil, err
	}
	keys, err := s.FinanceKeys()
	if err != nil {
		return nil, err
	}
	sealed, err := crypto.EncryptSecret(account.Number, refundScope(bookingID), keys[0])
	if err != nil {
		return nil, err
	}
	var stayDoc any
	if stay != nil {
		stayDoc = bson.D{{Key: "amount", Value: jsInt(stay.Amount)}, {Key: "dailyRate", Value: jsInt(stay.DailyRate)}, {Key: "holdBlocks", Value: jsInt(stay.HoldBlocks)}, {Key: "hostelSharePercent", Value: stay.HostelSharePercent},
			{Key: "moveIn", Value: stay.MoveIn}, {Key: "moveOut", Value: stay.MoveOut}, {Key: "nights", Value: jsInt(stay.Nights)}}
	}
	steps := bson.A{}
	for _, st := range terms.CancelSteps {
		steps = append(steps, bson.D{{Key: "refundPercent", Value: st.RefundPercent}, {Key: "throughDay", Value: st.ThroughDay}})
	}
	phone := ""
	if user.Phone != nil {
		phone = *user.Phone
	}
	last4 := account.Number
	if rs := []rune(last4); len(rs) > 4 {
		last4 = string(rs[len(rs)-4:])
	}
	var nullAt *time.Time
	build := func(code string) bson.D {
		return bson.D{{Key: "_id", Value: bookingID}, {Key: "kind", Value: kind}, {Key: "stay", Value: stayDoc}, {Key: "code", Value: code}, {Key: "hostelId", Value: h.ID}, {Key: "userId", Value: userID}, {Key: "roomType", Value: r.RoomType},
			{Key: "guest", Value: bson.D{{Key: "email", Value: *user.Email}, {Key: "name", Value: user.Name}, {Key: "phone", Value: phone}}},
			{Key: "hostelSnapshot", Value: bson.D{{Key: "address", Value: h.address()}, {Key: "name", Value: h.Name}, {Key: "phone", Value: h.phone()}, {Key: "slug", Value: h.Slug}}},
			{Key: "monthlyRent", Value: jsInt(*r.MonthlyRent)}, {Key: "fee", Value: jsInt(fee)}, {Key: "currency", Value: "NPR"},
			{Key: "terms", Value: bson.D{{Key: "cancelSteps", Value: steps}, {Key: "feePercent", Value: terms.FeePercent}, {Key: "holdDays", Value: terms.HoldDays}, {Key: "hostelAnswerHours", Value: terms.HostelAnswerHours},
				{Key: "hostelSharePercent", Value: terms.HostelSharePercent}, {Key: "noShowRefundPercent", Value: terms.NoShowRefundPercent}}},
			{Key: "policy", Value: bson.D{{Key: "acceptedAt", Value: now}, {Key: "source", Value: source}, {Key: "version", Value: version}}},
			{Key: "refundAccount", Value: bson.D{{Key: "bankName", Value: account.BankName}, {Key: "branch", Value: account.Branch}, {Key: "holderName", Value: account.HolderName}, {Key: "method", Value: account.Method}, {Key: "number", Value: sealed}, {Key: "numberLast4", Value: last4}}},
			{Key: "plannedMoveIn", Value: plannedMoveIn}, {Key: "invoiceNumber", Value: invoice}, {Key: "receiptNumber", Value: nil}, {Key: "softmatoInvoiceNo", Value: nil}, {Key: "status", Value: "AWAITING_PAYMENT"}, {Key: "isOpen", Value: true},
			{Key: "paymentDueBy", Value: now.Add(millis(cfg.UnpaidWindowHours * float64(oneHour.Milliseconds())))}, {Key: "paymentSubmittedAt", Value: nullAt},
			{Key: "paymentRejection", Value: bson.D{{Key: "at", Value: nil}, {Key: "reason", Value: nil}}}, {Key: "paymentVerifiedAt", Value: nullAt}, {Key: "paymentVerifiedBy", Value: nil},
			{Key: "hostelAnswerBy", Value: nullAt}, {Key: "confirmedAt", Value: nullAt}, {Key: "confirmedBy", Value: nil}, {Key: "holdEndsAt", Value: nullAt},
			{Key: "bedHeld", Value: false}, {Key: "checkedInAt", Value: nullAt}, {Key: "checkedInBy", Value: nil}, {Key: "residentId", Value: nil}, {Key: "endedAt", Value: nullAt}, {Key: "endedBy", Value: nil}, {Key: "endReason", Value: nil}, {Key: "hostelStrike", Value: false},
			{Key: "settlement", Value: bson.D{{Key: "hostelShare", Value: nil}, {Key: "kept", Value: nil}, {Key: "platformShare", Value: nil}, {Key: "refund", Value: nil}, {Key: "refundPercent", Value: nil}, {Key: "stayKept", Value: nil}, {Key: "stayRefund", Value: nil}}},
			{Key: "hostelRemindersSent", Value: bson.A{}}, {Key: "moveInRemindersSent", Value: bson.A{}},
			{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}
	}
	inserted := false
	code := ""
	for attempt := 0; attempt < 5 && !inserted; attempt++ {
		code = newBookingCode()
		_, err := s.db.Collection("bookings").InsertOne(ctx, build(code))
		switch field := httpx.DuplicateField(err); {
		case err == nil:
			inserted = true
		case field == "userId":
			return nil, httpx.NewError(409, "OPEN_BOOKING_EXISTS", "You already have an open booking. Finish or cancel it first.", nil)
		case field != "code":
			return nil, err
		}
	}
	if !inserted {
		return nil, httpx.NewError(500, "BOOKING_NOT_CREATED", "The booking could not be created. Try again.", nil)
	}
	if _, err := s.db.Collection("consentlogs").InsertOne(ctx, bson.D{{Key: "userId", Value: userID}, {Key: "hostelId", Value: h.ID}, {Key: "consentType", Value: "BOOKING_REFUND_POLICY"}, {Key: "granted", Value: true},
		{Key: "policyVersion", Value: version}, {Key: "recordedAt", Value: now}, {Key: "source", Value: source}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		slog.WarnContext(ctx, "booking consent row failed", "error", err)
	}
	var created Booking
	if err := s.db.Collection("bookings").FindOne(ctx, bson.D{{Key: "_id", Value: bookingID}}).Decode(&created); err != nil {
		return nil, err
	}
	_ = s.Audit.Write(ctx, audit.Entry{ActorID: userID, HostelID: h.ID, Action: "BOOKING_CREATED", EntityType: "Booking", EntityID: bookingID.Hex(), Metadata: bson.D{{Key: "code", Value: code}, {Key: "fee", Value: jsInt(fee)},
		{Key: "invoiceNumber", Value: invoice}, {Key: "kind", Value: kind}, {Key: "roomType", Value: r.RoomType}, {Key: "total", Value: jsInt(created.Total())}}})

	policy := policySummary(terms, fee)
	paper := s.attachment(ctx, &created)
	// ponytail: Softmato's invoice is raised by its retry job off this task row;
	// the first email goes without their number until the client lands in Phase 8.
	if s.SoftmatoOn {
		s.rememberTask(ctx, "BOOKING_PAYMENT", bookingID.Hex(), *user.Email, user.Name, s.appURL("/bookings/"+bookingID.Hex()))
	}
	rows := make([]email.RefundRow, len(policy.Rows))
	for i, row := range policy.Rows {
		rows[i] = email.RefundRow{FromDay: jsNum(row.FromDay), ThroughDay: jsNum(row.ThroughDay), RefundPercent: jsNum(row.RefundPercent), Refund: row.Refund}
	}
	mail := email.BookingInvoice(email.BookingInvoiceInput{Booking: facts(&created), BookingURL: s.appURL(guestPath(&created)), HostelAnswerHours: jsNum(terms.HostelAnswerHours), InvoiceNumber: invoice, Name: user.Name, NoShowRefund: policy.NoShowRefund,
		PayBy: email.EmailDateTime(created.PaymentDueBy), PaymentCheckHours: jsNum(cfg.PaymentCheckHours), PolicyURL: s.appURL("/refund-policy"), RefundRows: rows})
	s.notifyGuest(ctx, &created, "booking_invoice", "Pay Rs "+groupIN(created.Total())+" with code "+code+" to book "+email.RoomTypeLabel(r.RoomType)+" at "+created.HostelSnapshot.Name+".", &mail, paper, "Pay your booking fee", "BOOKING_CREATED")
	return s.detailFor(ctx, &created, now)
}

/* ── Reading ── */

func (s *Signed) loadOwn(ctx context.Context, id string, p *authz.Principal) (*Booking, error) {
	oid, err := bson.ObjectIDFromHex(id)
	notFound := httpx.NewError(404, "BOOKING_NOT_FOUND", "Booking not found.", nil)
	if err != nil {
		return nil, notFound
	}
	uid, _ := bson.ObjectIDFromHex(p.UserID)
	var b Booking
	err = s.db.Collection("bookings").FindOne(ctx, bson.D{{Key: "_id", Value: oid}, {Key: "userId", Value: uid}}).Decode(&b)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, notFound
	}
	return &b, err
}

type summaryOut struct {
	Code          string  `json:"code"`
	CoverPhotoURL *string `json:"coverPhotoUrl"`
	CreatedAt     string  `json:"createdAt"`
	Fee           int64   `json:"fee"`
	HoldEndsAt    *string `json:"holdEndsAt"`
	HostelName    string  `json:"hostelName"`
	ID            string  `json:"id"`
	RoomType      string  `json:"roomType"`
	Status        string  `json:"status"`
	StatusLabel   string  `json:"statusLabel"`
}

func (s *Signed) list(c *gin.Context) {
	p, err := s.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, _ := bson.ObjectIDFromHex(p.UserID)
	cur, err := s.db.Collection("bookings").Find(c, bson.D{{Key: "userId", Value: uid}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(100))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []Booking
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	ids := bson.A{}
	for _, b := range rows {
		ids = append(ids, b.HostelID)
	}
	covers := map[bson.ObjectID]*string{}
	if len(rows) > 0 {
		hc, err := s.db.Collection("hostels").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "photos", Value: 1}}))
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var hs []bookableHostel
		if err := hc.All(c, &hs); err != nil {
			httpx.Fail(c, err)
			return
		}
		for i := range hs {
			covers[hs[i].ID] = hs[i].cover()
		}
	}
	out := make([]summaryOut, len(rows))
	for i := range rows {
		b := &rows[i]
		out[i] = summaryOut{b.Code, covers[b.HostelID], httpx.ISO(b.CreatedAt), b.Fee, isoOf(b.HoldEndsAt), b.HostelSnapshot.Name, b.ID.Hex(), b.RoomType, b.Status, statusLabels[b.Status]}
	}
	httpx.OK(c, gin.H{"bookings": out}, "Your bookings")
}

// myBooking is getMyBooking: an unpaid booking past its window is shown as what it is.
func (s *Signed) myBooking(ctx context.Context, id string, p *authz.Principal) (*Detail, error) {
	b, err := s.loadOwn(ctx, id, p)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if b.Status == "AWAITING_PAYMENT" && !b.PaymentDueBy.After(now) {
		ended, err := s.expireUnpaid(ctx, b, now)
		if err != nil {
			return nil, err
		}
		if ended != nil {
			b = ended
		}
	}
	return s.detailFor(ctx, b, now)
}

func (s *Signed) detail(c *gin.Context) {
	p, err := s.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	d, err := s.myBooking(c, c.Param("id"), p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"booking": d}, "Booking")
}

/* ── Ending ── */

type endInput struct {
	actor  *bson.ObjectID
	from   string
	reason *string
	status string
	strike bool
	// set is written first (check-in's checkedInAt/residentId); keepBed leaves the
	// held bed counted, as a resident now sleeps in it.
	set     bson.D
	keepBed bool
}

func endingFor(b *Booking, status string) string {
	if status == "CANCELLED_BY_USER" {
		if b.Status == "CONFIRMED" {
			return "CANCELLED_BY_USER"
		}
		return "CANCELLED_BEFORE_CONFIRMATION"
	}
	switch status {
	case "CANCELLED_BY_HOSTEL", "CANCELLED_BY_PLATFORM", "CHECKED_IN", "DECLINED", "HOSTEL_NO_RESPONSE", "NO_SHOW":
		return status
	}
	return ""
}

func openStatus(status string) bool {
	switch status {
	case "AWAITING_PAYMENT", "PAYMENT_IN_REVIEW", "AWAITING_HOSTEL", "CONFIRMED":
		return true
	}
	return false
}

// endBooking is endBooking: a conditional write on the status left, then the money it owes.
func (s *Signed) endBooking(ctx context.Context, b *Booking, in endInput, now time.Time) (*Booking, error) {
	ending := endingFor(b, in.status)
	var settlement *Settlement
	settleDoc := bson.D{{Key: "hostelShare", Value: nil}, {Key: "kept", Value: nil}, {Key: "platformShare", Value: nil}, {Key: "refund", Value: nil}, {Key: "refundPercent", Value: nil}}
	if b.PaymentVerifiedAt != nil && ending != "" {
		st := settleBooking(now, b.ConfirmedAt, ending, b.Fee, b.Stay, b.Terms)
		settlement = &st
		settleDoc = st.doc()
	}
	var reason any
	if in.reason != nil {
		if t := valid.JSPrefix(valid.Trim(*in.reason), 500); t != "" {
			reason = t
		}
	}
	var actor any
	if in.actor != nil {
		actor = *in.actor
	}
	var ended Booking
	err := s.db.Collection("bookings").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: b.ID}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{in.from}}}}},
		bson.D{{Key: "$set", Value: append(append(bson.D{}, in.set...), bson.D{{Key: "bedHeld", Value: false}, {Key: "endReason", Value: reason}, {Key: "endedAt", Value: now}, {Key: "endedBy", Value: actor}, {Key: "hostelStrike", Value: in.strike},
			{Key: "settlement", Value: settleDoc}, {Key: "status", Value: in.status}, {Key: "isOpen", Value: openStatus(in.status)}, {Key: "updatedAt", Value: now}}...)}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&ended)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if b.BedHeld && !in.keepBed {
		if err := s.releaseBed(ctx, b.HostelID, b.RoomType, now); err != nil {
			slog.ErrorContext(ctx, "Booking ended but its held bed could not be released.", "bookingId", b.ID.Hex(), "error", err)
		}
	}
	var settleAudit any = bson.Null{}
	if settlement != nil {
		if err := s.raiseTransfers(ctx, &ended, *settlement, now); err != nil {
			return nil, err
		}
		settleAudit = settleDoc
		if settlement.Refund > 0 && ended.SoftmatoInvoiceNo != nil && *ended.SoftmatoInvoiceNo != "" && ended.ReceiptNumber != nil && strings.HasPrefix(*ended.ReceiptNumber, "TXN-") && s.SoftmatoOn {
			// ponytail: filed by its retry job off this task row; the client lands in Phase 8.
			s.rememberTask(ctx, "REFUND_FILING", ended.ID.Hex(), "", "", "")
		}
	}
	entry := audit.Entry{HostelID: b.HostelID, Action: "BOOKING_ENDED", EntityType: "Booking", EntityID: b.ID.Hex(), ActorType: "SYSTEM"}
	if in.actor != nil {
		entry.ActorID, entry.ActorType = *in.actor, ""
	}
	var reasonAudit any = bson.Null{}
	if in.reason != nil {
		reasonAudit = *in.reason
	}
	entry.Metadata = bson.D{{Key: "code", Value: b.Code}, {Key: "from", Value: b.Status}, {Key: "reason", Value: reasonAudit}, {Key: "settlement", Value: settleAudit}, {Key: "status", Value: in.status}, {Key: "strike", Value: in.strike}}
	_ = s.Audit.Write(ctx, entry)
	if in.strike {
		if err := s.applyStrikeRule(ctx, &ended, now); err != nil {
			return nil, err
		}
	}
	return &ended, nil
}

func (s *Signed) raiseTransfers(ctx context.Context, b *Booking, st Settlement, now time.Time) error {
	raise := func(kind string, amount int64) error {
		_, err := s.db.Collection("bookingtransfers").UpdateOne(ctx, bson.D{{Key: "bookingId", Value: b.ID}, {Key: "kind", Value: kind}},
			bson.D{{Key: "$setOnInsert", Value: bson.D{{Key: "hostelId", Value: b.HostelID}, {Key: "userId", Value: b.UserID}, {Key: "amount", Value: jsInt(amount)}, {Key: "status", Value: "DUE"},
				{Key: "sentAt", Value: nil}, {Key: "sentBy", Value: nil}, {Key: "transactionId", Value: nil}, {Key: "proofAssetId", Value: nil}, {Key: "note", Value: nil}, {Key: "documentNumber", Value: nil},
				{Key: "destination", Value: bson.D{{Key: "bankName", Value: ""}, {Key: "holderName", Value: ""}, {Key: "method", Value: nil}, {Key: "numberLast4", Value: ""}}},
				{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}}}, options.UpdateOne().SetUpsert(true))
		return err
	}
	if st.Refund > 0 {
		if err := raise("REFUND", st.Refund); err != nil {
			return err
		}
	}
	if st.HostelShare > 0 {
		return raise("PAYOUT", st.HostelShare)
	}
	return nil
}

// releaseBed is releaseBedForRoomType + writeConfigurations.
func (s *Signed) releaseBed(ctx context.Context, hostelID bson.ObjectID, roomType string, now time.Time) error {
	var h struct {
		Rooms []bson.D `bson:"roomConfigurations"`
	}
	err := s.db.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostelID}, {Key: "isDeleted", Value: false}}, options.FindOne().SetProjection(bson.D{{Key: "roomConfigurations", Value: 1}})).Decode(&h)
	if err != nil {
		return err
	}
	num := func(row bson.D, key string) float64 {
		for _, e := range row {
			if e.Key == key {
				switch v := e.Value.(type) {
				case int32:
					return float64(v)
				case int64:
					return float64(v)
				case float64:
					return v
				}
			}
		}
		return 0
	}
	str := func(row bson.D, key string) string {
		for _, e := range row {
			if e.Key == key {
				v, _ := e.Value.(string)
				return v
			}
		}
		return ""
	}
	found := false
	var totalBeds, totalRooms, vacantBeds float64
	for i, row := range h.Rooms {
		rooms := num(row, "rooms")
		beds := rooms * max(1, num(row, "bedsPerRoom"))
		vacant := num(row, "vacantBeds")
		if !found && str(row, "roomType") == roomType {
			found = true
			vacant = min(vacant+1, beds)
			set := false
			for j := range row {
				if row[j].Key == "vacantBeds" {
					row[j].Value, set = vacant, true
				}
			}
			if !set {
				row = append(row, bson.E{Key: "vacantBeds", Value: vacant})
			}
			h.Rooms[i] = row
		}
		totalBeds, totalRooms, vacantBeds = totalBeds+beds, totalRooms+rooms, vacantBeds+vacant
	}
	if !found {
		return nil
	}
	_, err = s.db.Collection("hostels").UpdateOne(ctx, bson.D{{Key: "_id", Value: hostelID}, {Key: "isDeleted", Value: false}}, bson.D{{Key: "$set", Value: bson.D{
		{Key: "capacitySummary", Value: bson.D{{Key: "totalBeds", Value: totalBeds}, {Key: "totalRooms", Value: totalRooms}, {Key: "vacantBeds", Value: vacantBeds}}},
		{Key: "roomConfigurations", Value: h.Rooms}, {Key: "updatedAt", Value: now}}}})
	if err != nil {
		return err
	}
	realtime.PublishResourceChange(ctx, s.RT, s.Bump, realtime.Change{HostelIDs: []string{hostelID.Hex()}, Topics: []realtime.Topic{realtime.Rooms, realtime.Residents}})
	return nil
}

func (s *Signed) applyStrikeRule(ctx context.Context, ended *Booking, now time.Time) error {
	cfg := s.BookingConfig(ctx)
	hostels := s.db.Collection("hostels")
	var h struct {
		BookingPause *struct {
			ResumedAt *time.Time `bson:"resumedAt"`
		} `bson:"bookingPause"`
	}
	err := hostels.FindOne(ctx, bson.D{{Key: "_id", Value: ended.HostelID}}, options.FindOne().SetProjection(bson.D{{Key: "bookingPause", Value: 1}})).Decode(&h)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return err
	}
	since := addDays(now, -cfg.StrikeWindowDays)
	if h.BookingPause != nil && h.BookingPause.ResumedAt != nil && h.BookingPause.ResumedAt.After(since) {
		since = *h.BookingPause.ResumedAt
	}
	strikes, err := s.db.Collection("bookings").CountDocuments(ctx, bson.D{{Key: "endedAt", Value: bson.D{{Key: "$gt", Value: since}}}, {Key: "hostelId", Value: ended.HostelID}, {Key: "hostelStrike", Value: true}})
	if err != nil {
		return err
	}
	if float64(strikes) < cfg.StrikeLimit {
		return nil
	}
	res, err := hostels.UpdateOne(ctx, bson.D{{Key: "_id", Value: ended.HostelID}, {Key: "bookingPause.pausedAt", Value: nil}}, bson.D{{Key: "$set", Value: bson.D{{Key: "bookingPause.pausedAt", Value: now}, {Key: "bookingPause.pausedBy", Value: nil},
		{Key: "bookingPause.reason", Value: fmt.Sprintf("%d missed or cancelled bookings in %s days", strikes, jsNum(cfg.StrikeWindowDays))}, {Key: "updatedAt", Value: now}}}})
	if err != nil {
		return err
	}
	if res.ModifiedCount == 0 {
		return nil
	}
	_ = s.Audit.Write(ctx, audit.Entry{ActorType: "SYSTEM", HostelID: ended.HostelID, Action: "HOSTEL_BOOKINGS_PAUSED", EntityType: "Hostel", EntityID: ended.HostelID.Hex(),
		Metadata: bson.D{{Key: "strikeLimit", Value: cfg.StrikeLimit}, {Key: "strikes", Value: jsInt(strikes)}, {Key: "windowDays", Value: cfg.StrikeWindowDays}}})
	s.announcePaused(ctx, ended, strikes, jsNum(cfg.StrikeWindowDays))
	return nil
}

func (s *Signed) expireUnpaid(ctx context.Context, b *Booking, now time.Time) (*Booking, error) {
	reason := "No payment arrived in time."
	return s.endBooking(ctx, b, endInput{from: "AWAITING_PAYMENT", reason: &reason, status: "EXPIRED"}, now)
}

func (s *Signed) cancel(c *gin.Context) {
	p, err := s.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var body any = map[string]any{}
	if parsed, err := valid.Body(c); err == nil && parsed != nil {
		body = parsed
	}
	f := valid.NewForm(body)
	expected, hasExpected := f.Num("expectedRefund", valid.N{Opt: true, Int: true, Min: valid.P(0)})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	d, err := s.cancelMine(c, c.Param("id"), expected, hasExpected, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"booking": d}, "Booking cancelled.")
}

func past(t *time.Time, now time.Time) bool { return t != nil && !now.Before(*t) }

func (s *Signed) cancelMine(ctx context.Context, id string, expected float64, hasExpected bool, p *authz.Principal) (*Detail, error) {
	b, err := s.loadOwn(ctx, id, p)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if !b.IsOpen {
		return nil, httpx.NewError(409, "BOOKING_CLOSED", "This booking has already ended.", nil)
	}
	if b.Status == "PAYMENT_IN_REVIEW" {
		return nil, httpx.NewError(409, "BOOKING_PAYMENT_IN_REVIEW", "We are checking your payment. You can cancel as soon as it is checked.", nil)
	}
	if b.Status == "AWAITING_PAYMENT" && past(&b.PaymentDueBy, now) {
		ended, err := s.expireUnpaid(ctx, b, now)
		if err != nil {
			return nil, err
		}
		if ended != nil {
			s.announceEnding(ctx, ended, b.Status)
		}
		return s.myBooking(ctx, id, p)
	}
	if b.Status == "AWAITING_HOSTEL" && past(b.HostelAnswerBy, now) {
		ended, err := s.endBooking(ctx, b, endInput{from: "AWAITING_HOSTEL", status: "HOSTEL_NO_RESPONSE", strike: true}, now)
		if err != nil {
			return nil, err
		}
		if ended != nil {
			s.announceEnding(ctx, ended, b.Status)
		}
		return s.myBooking(ctx, id, p)
	}
	if b.Status == "CONFIRMED" && past(b.HoldEndsAt, now) {
		ended, err := s.endBooking(ctx, b, endInput{from: "CONFIRMED", status: "NO_SHOW"}, now)
		if err != nil {
			return nil, err
		}
		if ended != nil {
			s.announceEnding(ctx, ended, b.Status)
		}
		return nil, httpx.NewError(409, "HOLD_ENDED", "The time to move in has passed, so this booking has ended as not moved in.", nil)
	}
	preview := cancelPreview(b, now)
	if hasExpected && int64(expected) != preview.Refund {
		return nil, httpx.NewError(409, "REFUND_CHANGED", "Cancelling now gives back "+email.Rupees(preview.Refund)+", not "+email.Rupees(int64(expected))+". Check the new figure and cancel again.", gin.H{"cancel": preview})
	}
	uid, _ := bson.ObjectIDFromHex(p.UserID)
	ended, err := s.endBooking(ctx, b, endInput{actor: &uid, from: b.Status, status: "CANCELLED_BY_USER"}, now)
	if err != nil {
		return nil, err
	}
	if ended == nil {
		return nil, httpx.NewError(409, "BOOKING_STATE_CHANGED", "This booking has just changed. Refresh to see where it stands.", nil)
	}
	s.announceEnding(ctx, ended, b.Status)
	return s.myBooking(ctx, id, p)
}

/* ── Telling people (booking-notify.ts). Every failure here is swallowed: the step is written. ── */

const platformBookingsPath = "/platform/bookings"

func (s *Signed) appURL(path string) string { return residents.AppURL(s.Outbound, path) }

func guestPath(b *Booking) string { return "/bookings/" + b.ID.Hex() }

func hostelPath(b *Booking) string {
	if b.HostelSnapshot.Slug != "" {
		return "/" + httpx.EncodeURIComponent(b.HostelSnapshot.Slug) + "/admin/bookings"
	}
	return "/hostel-admin/bookings"
}

func groupIN(v int64) string { return strings.TrimPrefix(email.Rupees(v), "Rs ") }

func facts(b *Booking) email.BookingFacts {
	f := email.BookingFacts{Code: b.Code, Fee: b.Fee, HostelName: b.HostelSnapshot.Name, MonthlyRent: b.MonthlyRent, RoomType: b.RoomType, Total: b.Total()}
	if b.Stay != nil {
		f.Stay = &email.BookingStay{Amount: b.Stay.Amount, Dates: stayDatesText(b.Stay), Nights: b.Stay.Nights}
	}
	return f
}

func (s *Signed) rememberTask(ctx context.Context, kind, ref, mailTo, name, link string) {
	now := time.Now().UTC().Truncate(time.Millisecond)
	orNull := func(v string) any {
		if v == "" {
			return nil
		}
		return v
	}
	_, err := s.db.Collection("softmatotasks").UpdateOne(ctx, bson.D{{Key: "doneAt", Value: nil}, {Key: "kind", Value: kind}, {Key: "ref", Value: ref}},
		bson.D{{Key: "$setOnInsert", Value: bson.D{{Key: "email", Value: orNull(mailTo)}, {Key: "name", Value: orNull(name)}, {Key: "link", Value: orNull(link)}, {Key: "attempts", Value: 0}, {Key: "lastError", Value: nil},
			{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}}}, options.UpdateOne().SetUpsert(true))
	if err != nil && httpx.DuplicateField(err) == "" {
		slog.WarnContext(ctx, "softmato task not remembered", "kind", kind, "ref", ref, "error", err)
	}
}

func (s *Signed) deliver(ctx context.Context, action, to string, m email.Content, papers []email.Attachment) {
	if to == "" {
		return
	}
	s.Mail.Notify(ctx, email.Notification{Action: action, To: to, Subject: m.Subject, HTML: m.HTML, Category: m.Category, Attachments: papers})
}

func (s *Signed) bell(ctx context.Context, audience, body string, b *Booking, hostelID, path, priority, title, kind, userID string) {
	_, err := s.Notify.CreateInApp(ctx, notifications.Input{ActionURL: path, Body: body, Category: "BOOKING", Data: ordered.Map{{Key: "audience", Value: audience}, {Key: "bookingCode", Value: b.Code},
		{Key: "bookingId", Value: b.ID.Hex()}, {Key: "type", Value: kind}}, HostelID: hostelID, Priority: priority, Title: title, UserID: userID})
	if err != nil {
		slog.WarnContext(ctx, "booking bell failed", "error", err)
	}
}

func (s *Signed) notifyGuest(ctx context.Context, b *Booking, action, body string, m *email.Content, papers []email.Attachment, title, kind string) {
	if m != nil {
		s.deliver(ctx, action, b.Guest.Email, *m, papers)
	}
	s.bell(ctx, "GUEST", body, b, "", guestPath(b), "", title, kind, b.UserID.Hex())
}

func (s *Signed) notifyHostel(ctx context.Context, b *Booking, action, body string, m func(name string) email.Content, priority, title, kind string) {
	contacts, err := residents.HostelAdminContacts(ctx, s.db, b.HostelID)
	if err != nil {
		return
	}
	for _, ct := range contacts {
		if m != nil {
			s.deliver(ctx, action, ct.Email, m(ct.Name), nil)
		}
		if ct.UserID != "" {
			s.bell(ctx, "HOSTEL", body, b, b.HostelID.Hex(), "/hostel-admin/bookings", priority, title, kind, ct.UserID)
		}
	}
}

func (s *Signed) notifyPlatform(ctx context.Context, b *Booking, action, body string, m *email.Content, tab, title, kind string) {
	cur, err := s.db.Collection("users").Find(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "role", Value: "SUPERADMIN"}, {Key: "status", Value: "ACTIVE"}},
		options.Find().SetProjection(bson.D{{Key: "email", Value: 1}}))
	if err != nil {
		return
	}
	var staff []struct {
		ID    bson.ObjectID `bson:"_id"`
		Email string        `bson:"email"`
	}
	if cur.All(ctx, &staff) != nil {
		return
	}
	for _, member := range staff {
		if m != nil {
			s.deliver(ctx, action, member.Email, *m, nil)
		}
		s.bell(ctx, "PLATFORM", body, b, "", platformBookingsPath+"?tab="+tab, "", title, kind, member.ID.Hex())
	}
}

func (s *Signed) announcePaused(ctx context.Context, b *Booking, strikes int64, windowDays string) {
	name := b.HostelSnapshot.Name
	body := fmt.Sprintf("%d missed or cancelled bookings in %s days. Bookings on %s are paused.", strikes, windowDays, name)
	s.notifyHostel(ctx, b, "bookings_paused", body, func(contact string) email.Content {
		return email.BookingsPaused(s.appURL(hostelPath(b)), name, contact, strikes, windowDays)
	}, "HIGH", "Bookings paused", "BOOKINGS_PAUSED")
	m := email.HostelBookingsPaused(name, s.appURL(platformBookingsPath+"?tab=paused"), strikes, windowDays)
	s.notifyPlatform(ctx, b, "hostel_bookings_paused", body, &m, "paused", "Hostel bookings paused", "BOOKINGS_PAUSED")
}

func endCause(ended *Booking, previous string) string {
	switch ended.Status {
	case "CANCELLED_BY_USER":
		if previous == "CONFIRMED" {
			return "CANCELLED_BY_USER"
		}
		return "CANCELLED_BEFORE_CONFIRMATION"
	case "EXPIRED", "DECLINED", "HOSTEL_NO_RESPONSE", "CANCELLED_BY_HOSTEL", "CANCELLED_BY_PLATFORM", "NO_SHOW":
		return ended.Status
	}
	return ""
}

// announceEnding is announceEnding: the person, the hostel when somebody else
// ended it, and the superadmins when money is now owed.
func (s *Signed) announceEnding(ctx context.Context, ended *Booking, previous string) {
	cause := endCause(ended, previous)
	if cause == "" {
		return
	}
	paid := ended.PaymentVerifiedAt != nil
	var refund, share int64
	pct := 0.0
	if st := ended.Settlement; st != nil {
		if st.Refund != nil {
			refund = *st.Refund
		}
		if st.HostelShare != nil {
			share = *st.HostelShare
		}
		if st.RefundPercent != nil {
			pct = *st.RefundPercent
		}
	}
	acct := ended.RefundAccount
	refundTo := payoutLabels[acct.Method] + " " + masked(acct.NumberLast4) + " (" + acct.HolderName + ")"
	reason := ""
	if ended.EndedBy != nil && ended.EndReason != nil {
		reason = *ended.EndReason
	}
	title := statusLabels[ended.Status]
	kind := "BOOKING_" + ended.Status
	action := "booking_" + strings.ToLower(cause)
	body := "Booking " + ended.Code + " at " + ended.HostelSnapshot.Name + " has ended."
	if paid && refund > 0 {
		body = email.Rupees(refund) + " of your booking fee for " + ended.Code + " is coming back to " + refundTo + "."
	}
	m := email.BookingEnded(facts(ended), s.appURL(guestPath(ended)), cause, ended.Guest.Name, paid, reason, refund, jsNum(pct), refundTo)
	s.notifyGuest(ctx, ended, action, body, &m, nil, title, kind)

	if (previous == "AWAITING_HOSTEL" || previous == "CONFIRMED") && cause != "EXPIRED" && cause != "CANCELLED_BY_HOSTEL" {
		hostelBody := ended.Code + " (" + ended.Guest.Name + ", " + email.RoomTypeLabel(ended.RoomType) + "): " + title + "."
		if share > 0 {
			hostelBody += " Your share " + email.Rupees(share) + "."
		}
		s.notifyHostel(ctx, ended, action+"_hostel", hostelBody, func(contact string) email.Content {
			return email.BookingClosedForHostel(s.appURL(hostelPath(ended)), cause, ended.Code, ended.Guest.Name, ended.HostelSnapshot.Name, share, contact, reason, ended.RoomType)
		}, "", title, kind)
	}
	if paid && (refund > 0 || share > 0) {
		owed := []string{}
		if refund > 0 {
			owed = append(owed, "refund "+email.Rupees(refund))
		}
		if share > 0 {
			owed = append(owed, "payout "+email.Rupees(share))
		}
		var fault *email.Content
		if refund > 0 && (cause == "DECLINED" || cause == "HOSTEL_NO_RESPONSE" || cause == "CANCELLED_BY_HOSTEL") {
			f := email.BookingHostelFaultRefund(cause, ended.Code, ended.Guest.Name, ended.HostelSnapshot.Name, s.appURL(platformBookingsPath+"?tab=refunds"), reason, refund, refundTo, ended.RoomType)
			fault = &f
		}
		tab, t := "payouts", "Payout to send"
		if refund > 0 {
			tab, t = "refunds", "Refund to send"
		}
		s.notifyPlatform(ctx, ended, "booking_money_due", ended.Code+": "+strings.Join(owed, ", ")+" to send.", fault, tab, t, "BOOKING_MONEY_DUE")
	}
}

// Register mounts the signed-in routes beside the public reads.
func (s *Signed) Register(v1 *gin.RouterGroup) {
	b := v1.Group("/bookings")
	b.GET("", httpx.ETag(), s.list)
	b.POST("", s.create)
	b.GET("/quote", httpx.ETag(), s.quote)
	b.GET("/documents/:kind/:number", s.document)
	b.GET("/:id", httpx.ETag(), s.detail)
	b.POST("/:id/cancel", s.cancel)
}
