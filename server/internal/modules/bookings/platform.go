package bookings

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"golang.org/x/sync/errgroup"

	"github.com/softmato/hostelpalika/server/internal/modules/hostels"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Platform is the superadmin's booking desk, /platform/bookings/*: the queues
// (booking-queries), checking screenshots (booking-review), cancelling and
// pausing (booking-answer), sending money (booking-transfer), payout accounts
// and the booking terms. Booking money is superadmin-only, moderators included.
type Platform struct {
	*Signed
	// Payouts holds the payout-account review; it needs the finance keys.
	Payouts *hostels.Admin
	// Settings runs the email-confirmed change of the booking terms.
	Settings *platformconfig.Admin
}

// Register mounts /platform/bookings.
func (p *Platform) Register(v1 *gin.RouterGroup) {
	sa := authz.Use(p.Guards.RequireSuperadmin)
	g := v1.Group("/platform/bookings")
	g.GET("", sa, httpx.ETag(), p.list)
	g.GET("/documents/:kind/:number", p.document)
	g.POST("/hostels/:hostelId/pause", sa, p.pause)
	g.GET("/payments", sa, httpx.ETag(), p.payments)
	g.POST("/payments/:id", sa, p.reviewPayment)
	g.GET("/payout-accounts", sa, httpx.ETag(), p.payoutAccounts)
	g.POST("/payout-accounts/:hostelId/reveal", sa, p.revealPayout)
	g.POST("/payout-accounts/:hostelId/review", sa, p.reviewPayout)
	g.GET("/settings", sa, httpx.ETag(), p.settings)
	g.POST("/settings", sa, p.requestSettings)
	g.GET("/transfers", sa, httpx.ETag(), p.transfers)
	g.POST("/transfers/:id/:action", sa, p.transferAction)
	g.GET("/:id", sa, httpx.ETag(), p.detail)
	g.DELETE("/:id", sa, p.cancel)
}

/* ── The platform's view of a booking ── */

// platformTransfer is a BookingTransfer row with what the platform reads beside Transfer.
type platformTransfer struct {
	Transfer  `bson:",inline"`
	CreatedAt *time.Time     `bson:"createdAt"`
	HostelID  *bson.ObjectID `bson:"hostelId"`
	Kind      string         `bson:"kind"`
}

type guestOut struct {
	Email string `json:"email"`
	Name  string `json:"name"`
	Phone string `json:"phone"`
}

type platformSettlementOut struct {
	HostelShare   int64 `json:"hostelShare"`
	Kept          int64 `json:"kept"`
	PlatformShare int64 `json:"platformShare"`
	Refund        int64 `json:"refund"`
}

type transferOut struct {
	Amount         int64   `json:"amount"`
	DocumentNumber *string `json:"documentNumber"`
	ID             string  `json:"id"`
	Kind           string  `json:"kind"`
	SentAt         *string `json:"sentAt"`
	Status         string  `json:"status"`
	TransactionID  *string `json:"transactionId"`
}

// PlatformView is PlatformBookingView.
type PlatformView struct {
	GuestView
	Guest              guestOut               `json:"guest"`
	HostelShareIfKept  int64                  `json:"hostelShareIfKept"`
	PlatformSettlement *platformSettlementOut `json:"platformSettlement"`
	Strike             bool                   `json:"strike"`
	Transfers          []transferOut          `json:"transfers"`
	UserID             string                 `json:"userId"`
}

// platformBooking is a Booking with settlement.platformShare, which only the platform reads.
type platformBooking struct {
	Booking
	platformShare *int64
}

func decodePlatformBooking(raw bson.Raw) (*platformBooking, error) {
	var pb platformBooking
	if err := bson.Unmarshal(raw, &pb.Booking); err != nil {
		return nil, err
	}
	var extra struct {
		Settlement *struct {
			PlatformShare *int64 `bson:"platformShare"`
		} `bson:"settlement"`
	}
	if err := bson.Unmarshal(raw, &extra); err != nil {
		return nil, err
	}
	if extra.Settlement != nil {
		pb.platformShare = extra.Settlement.PlatformShare
	}
	return &pb, nil
}

func orZero(v *int64) int64 {
	if v == nil {
		return 0
	}
	return *v
}

// toPlatformView is toPlatformView.
func toPlatformView(pb *platformBooking, transfers []platformTransfer, now time.Time) PlatformView {
	b := &pb.Booking
	var refund *Transfer
	for i := range transfers {
		if transfers[i].Kind == "REFUND" {
			refund = &transfers[i].Transfer
			break
		}
	}
	v := PlatformView{GuestView: toGuestView(b, now, refund), Guest: guestOut{b.Guest.Email, b.Guest.Name, b.Guest.Phone},
		HostelShareIfKept: settleBooking(now, b.ConfirmedAt, "CHECKED_IN", b.Fee, b.Stay, b.Terms).HostelShare, Strike: b.HostelStrike,
		Transfers: make([]transferOut, 0, len(transfers)), UserID: b.UserID.Hex()}
	if st := b.Settlement; st != nil && st.Refund != nil {
		v.PlatformSettlement = &platformSettlementOut{orZero(st.HostelShare), orZero(st.Kept), orZero(pb.platformShare), *st.Refund}
	}
	for _, t := range transfers {
		v.Transfers = append(v.Transfers, transferOut{t.Amount, t.DocumentNumber, t.ID.Hex(), t.Kind, isoOf(t.SentAt), t.Status, t.TransactionID})
	}
	return v
}

// transfersByBooking is transfersByBooking: every transfer of these bookings, oldest first.
func (p *Platform) transfersByBooking(ctx context.Context, ids bson.A) (map[bson.ObjectID][]platformTransfer, error) {
	out := map[bson.ObjectID][]platformTransfer{}
	if len(ids) == 0 {
		return out, nil
	}
	cur, err := p.db.Collection("bookingtransfers").Find(ctx, bson.D{{Key: "bookingId", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetSort(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []platformTransfer
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	for _, t := range rows {
		out[t.BookingID] = append(out[t.BookingID], t)
	}
	return out, nil
}

// view reads one booking's transfers and builds its platform view.
func (p *Platform) view(ctx context.Context, pb *platformBooking, now time.Time) (PlatformView, error) {
	transfers, err := p.transfersByBooking(ctx, bson.A{pb.ID})
	if err != nil {
		return PlatformView{}, err
	}
	return toPlatformView(pb, transfers[pb.ID], now), nil
}

func (p *Platform) loadPlatformBooking(ctx context.Context, id string) (*platformBooking, error) {
	notFound := httpx.NewError(http.StatusNotFound, "BOOKING_NOT_FOUND", "Booking not found.", nil)
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return nil, notFound
	}
	raw, err := p.db.Collection("bookings").FindOne(ctx, bson.D{{Key: "_id", Value: oid}}).Raw()
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, notFound
	}
	if err != nil {
		return nil, err
	}
	return decodePlatformBooking(raw)
}

func (p *Platform) reload(ctx context.Context, b *Booking, now time.Time) (PlatformView, error) {
	pb, err := p.loadPlatformBooking(ctx, b.ID.Hex())
	if err != nil {
		return PlatformView{}, err
	}
	return p.view(ctx, pb, now)
}

/* ── GET /platform/bookings, GET /platform/bookings/:id ── */

type countsOut struct {
	Holds      int64 `json:"holds"`
	Payments   int64 `json:"payments"`
	PayoutsDue int64 `json:"payoutsDue"`
	RefundsDue int64 `json:"refundsDue"`
	Waiting    int64 `json:"waiting"`
}

type pausedOut struct {
	Automatic bool    `json:"automatic"`
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	PausedAt  *string `json:"pausedAt"`
	Reason    *string `json:"reason"`
	Slug      string  `json:"slug"`
}

type listOut struct {
	Bookings      []PlatformView `json:"bookings"`
	Counts        countsOut      `json:"counts"`
	PausedHostels *[]pausedOut   `json:"pausedHostels,omitempty"`
}

var hexID = regexp.MustCompile(`^[a-fA-F0-9]{24}$`)

// List is listPlatformBookings (+ listPausedHostels on the paused tab).
func (p *Platform) List(ctx context.Context, tab, status, hostelID string, now time.Time) (*listOut, error) {
	filter, sort := bson.D{}, bson.D{{Key: "createdAt", Value: -1}}
	switch tab {
	case "waiting":
		filter, sort = append(filter, bson.E{Key: "status", Value: "AWAITING_HOSTEL"}), bson.D{{Key: "hostelAnswerBy", Value: 1}}
	case "holds":
		filter, sort = append(filter, bson.E{Key: "status", Value: "CONFIRMED"}), bson.D{{Key: "holdEndsAt", Value: 1}}
	default:
		if _, ok := statusLabels[status]; ok {
			filter = append(filter, bson.E{Key: "status", Value: status})
		}
	}
	if oid, err := bson.ObjectIDFromHex(hostelID); err == nil && hexID.MatchString(hostelID) {
		filter = append(filter, bson.E{Key: "hostelId", Value: oid})
	}
	var raws []bson.Raw
	var counts countsOut
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		cur, err := p.db.Collection("bookings").Find(gctx, filter, options.Find().SetSort(sort).SetLimit(200))
		if err != nil {
			return err
		}
		return cur.All(gctx, &raws)
	})
	count := func(into *int64, coll string, f bson.D) {
		g.Go(func() (err error) {
			*into, err = p.db.Collection(coll).CountDocuments(gctx, f)
			return err
		})
	}
	count(&counts.Payments, "bookingpayments", bson.D{{Key: "status", Value: "IN_REVIEW"}})
	count(&counts.Waiting, "bookings", bson.D{{Key: "status", Value: "AWAITING_HOSTEL"}})
	count(&counts.Holds, "bookings", bson.D{{Key: "status", Value: "CONFIRMED"}})
	count(&counts.RefundsDue, "bookingtransfers", bson.D{{Key: "kind", Value: "REFUND"}, {Key: "status", Value: "DUE"}})
	count(&counts.PayoutsDue, "bookingtransfers", bson.D{{Key: "kind", Value: "PAYOUT"}, {Key: "status", Value: "DUE"}})
	if err := g.Wait(); err != nil {
		return nil, err
	}
	bookings := make([]*platformBooking, 0, len(raws))
	ids := bson.A{}
	for _, raw := range raws {
		pb, err := decodePlatformBooking(raw)
		if err != nil {
			return nil, err
		}
		bookings = append(bookings, pb)
		ids = append(ids, pb.ID)
	}
	transfers, err := p.transfersByBooking(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := &listOut{Bookings: make([]PlatformView, 0, len(bookings)), Counts: counts}
	for _, pb := range bookings {
		out.Bookings = append(out.Bookings, toPlatformView(pb, transfers[pb.ID], now))
	}
	if tab == "paused" {
		paused, err := p.pausedHostels(ctx)
		if err != nil {
			return nil, err
		}
		out.PausedHostels = &paused
	}
	return out, nil
}

// pausedHostels is listPausedHostels: newest pause first.
func (p *Platform) pausedHostels(ctx context.Context) ([]pausedOut, error) {
	cur, err := p.db.Collection("hostels").Find(ctx, bson.D{{Key: "bookingPause.pausedAt", Value: bson.D{{Key: "$ne", Value: nil}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
		options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}, {Key: "bookingPause", Value: 1}, {Key: "name", Value: 1}, {Key: "slug", Value: 1}}).
			SetSort(bson.D{{Key: "bookingPause.pausedAt", Value: -1}}).SetLimit(200))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID    bson.ObjectID `bson:"_id"`
		Pause struct {
			PausedAt *time.Time     `bson:"pausedAt"`
			PausedBy *bson.ObjectID `bson:"pausedBy"`
			Reason   *string        `bson:"reason"`
		} `bson:"bookingPause"`
		Name string `bson:"name"`
		Slug string `bson:"slug"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := make([]pausedOut, 0, len(rows))
	for _, h := range rows {
		out = append(out, pausedOut{h.Pause.PausedBy == nil, h.ID.Hex(), h.Name, isoOf(h.Pause.PausedAt), h.Pause.Reason, h.Slug})
	}
	return out, nil
}

func (p *Platform) list(c *gin.Context) {
	q := valid.Query(c)
	tab := q["tab"]
	if tab != "waiting" && tab != "holds" && tab != "paused" {
		tab = "all"
	}
	out, err := p.List(c, tab, q["status"], q["hostelId"], time.Now().UTC())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Bookings")
}

func (p *Platform) detail(c *gin.Context) {
	pb, err := p.loadPlatformBooking(c, c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	v, err := p.view(c, pb, time.Now().UTC())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"booking": v}, "Booking")
}

/* ── DELETE /platform/bookings/:id, POST hostels/:hostelId/pause ── */

// Cancel is cancelBookingByPlatform: disputes, fraud, mistakes; a paid open
// booking ends refunded in full.
func (p *Platform) Cancel(ctx context.Context, id, reason string, actor bson.ObjectID, now time.Time) (PlatformView, error) {
	pb, err := p.loadPlatformBooking(ctx, id)
	if err != nil {
		return PlatformView{}, err
	}
	b := &pb.Booking
	if b.Status != "AWAITING_HOSTEL" && b.Status != "CONFIRMED" {
		return PlatformView{}, bookingErr("Only a paid booking that is still open can be cancelled. Reject an unchecked payment instead.", "BOOKING_NOT_PAID_OPEN", http.StatusConflict)
	}
	ended, err := p.endBooking(ctx, b, endInput{actor: &actor, from: b.Status, reason: &reason, status: "CANCELLED_BY_PLATFORM"}, now)
	if err != nil {
		return PlatformView{}, err
	}
	if ended == nil {
		return PlatformView{}, stateChanged()
	}
	p.announceEnding(ctx, ended, b.Status)
	return p.reload(ctx, ended, now)
}

func (p *Platform) cancel(c *gin.Context) {
	var body any
	if b, err := valid.Body(c); err == nil {
		body = b
	}
	f := valid.NewForm(bodyMap(body))
	reason, _ := f.Str("reason", valid.S{Trim: true, Min: 1, MinMsg: "Say why.", Max: 500})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := httpx.OID(authz.From(c).UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	v, err := p.Cancel(c, c.Param("id"), reason, actor, time.Now().UTC())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"booking": v}, "Booking cancelled. The refund is due.")
}

type pauseOut struct {
	PausedAt  *string `json:"pausedAt"`
	Reason    *string `json:"reason"`
	ResumedAt *string `json:"resumedAt"`
}

// SetPause is setHostelBookingPause: the Book button off with a reason the
// hostel is shown, or back on, which forgives the strikes so far (resumedAt).
func (p *Platform) SetPause(ctx context.Context, hostelID string, paused bool, reason string, actor bson.ObjectID) (pauseOut, error) {
	if paused && reason == "" {
		return pauseOut{}, bookingErr("Say why, so the hostel knows.", "VALIDATION_ERROR", http.StatusUnprocessableEntity)
	}
	notFound := bookingErr("Hostel not found.", "HOSTEL_NOT_FOUND", http.StatusNotFound)
	oid, err := bson.ObjectIDFromHex(hostelID)
	if err != nil {
		return pauseOut{}, notFound
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	var reasonVal any
	if reason != "" {
		reasonVal = reason
	}
	set := bson.D{{Key: "bookingPause.pausedAt", Value: nil}, {Key: "bookingPause.pausedBy", Value: nil}, {Key: "bookingPause.reason", Value: nil}, {Key: "bookingPause.resumedAt", Value: now}}
	if paused {
		set = bson.D{{Key: "bookingPause.pausedAt", Value: now}, {Key: "bookingPause.pausedBy", Value: actor}, {Key: "bookingPause.reason", Value: reasonVal}}
	}
	var h struct {
		Pause struct {
			PausedAt  *time.Time `bson:"pausedAt"`
			Reason    *string    `bson:"reason"`
			ResumedAt *time.Time `bson:"resumedAt"`
		} `bson:"bookingPause"`
	}
	err = p.db.Collection("hostels").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: oid}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
		bson.D{{Key: "$set", Value: append(set, bson.E{Key: "updatedAt", Value: now})}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&h)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return pauseOut{}, notFound
	}
	if err != nil {
		return pauseOut{}, err
	}
	action, title, body, priority, kind := "HOSTEL_BOOKINGS_RESUMED", "Bookings back on", "People can book your hostel again.", "NORMAL", "BOOKINGS_RESUMED"
	if paused {
		action, title, body, priority, kind = "HOSTEL_BOOKINGS_PAUSED", "Bookings paused", "People can no longer book your hostel. "+reason, "HIGH", "BOOKINGS_PAUSED"
	}
	if err := p.Audit.Write(ctx, audit.Entry{Action: action, ActorID: actor, EntityID: hostelID, EntityType: "Hostel", HostelID: oid,
		Metadata: bson.D{{Key: "reason", Value: reasonVal}}}); err != nil {
		slog.WarnContext(ctx, "booking pause audit failed", "hostelId", hostelID, "error", err)
	}
	if contacts, err := residents.HostelAdminContacts(ctx, p.db, oid); err == nil {
		for _, ct := range contacts {
			if ct.UserID == "" {
				continue
			}
			_, _ = p.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/hostel-admin/bookings", Body: body, Category: "BOOKING",
				Data: ordered.Map{{Key: "audience", Value: "HOSTEL"}, {Key: "type", Value: kind}}, HostelID: hostelID, Priority: priority, Title: title, UserID: ct.UserID})
		}
	}
	return pauseOut{isoOf(h.Pause.PausedAt), h.Pause.Reason, isoOf(h.Pause.ResumedAt)}, nil
}

func (p *Platform) pause(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	paused, _ := f.Bool("paused", false, nil)
	reason, _ := f.Str("reason", valid.S{Opt: true, Trim: true, Max: 500})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := httpx.OID(authz.From(c).UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := p.SetPause(c, c.Param("hostelId"), paused, reason, actor)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	msg := "Bookings back on."
	if paused {
		msg = "Bookings paused."
	}
	httpx.OK(c, gin.H{"pause": out}, msg)
}

/* ── Payments: GET payments, POST payments/:id ── */

type paymentRow struct {
	ID           bson.ObjectID `bson:"_id"`
	Amount       int64         `bson:"amount"`
	BookingID    bson.ObjectID `bson:"bookingId"`
	Note         *string       `bson:"note"`
	ProofAssetID bson.ObjectID `bson:"proofAssetId"`
	Reference    *string       `bson:"reference"`
	Status       string        `bson:"status"`
	SubmittedAt  time.Time     `bson:"submittedAt"`
}

type paymentOut struct {
	Amount       int64    `json:"amount"`
	BookingCode  string   `json:"bookingCode"`
	BookingID    string   `json:"bookingId"`
	CheckBy      string   `json:"checkBy"`
	Guest        guestOut `json:"guest"`
	HostelName   string   `json:"hostelName"`
	ID           string   `json:"id"`
	Note         *string  `json:"note"`
	ProofAssetID string   `json:"proofAssetId"`
	Reference    *string  `json:"reference"`
	RoomType     string   `json:"roomType"`
	SubmittedAt  string   `json:"submittedAt"`
}

// Payments is listBookingPaymentsToCheck: screenshots waiting on a person, oldest first.
func (p *Platform) Payments(ctx context.Context) ([]paymentOut, error) {
	cur, err := p.db.Collection("bookingpayments").Find(ctx, bson.D{{Key: "status", Value: "IN_REVIEW"}}, options.Find().SetSort(bson.D{{Key: "submittedAt", Value: 1}}).SetLimit(200))
	if err != nil {
		return nil, err
	}
	var rows []paymentRow
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := make([]paymentOut, 0, len(rows))
	if len(rows) == 0 {
		return out, nil
	}
	ids := bson.A{}
	for _, r := range rows {
		ids = append(ids, r.BookingID)
	}
	byID, err := p.bookingsByID(ctx, ids)
	if err != nil {
		return nil, err
	}
	check := time.Duration(p.BookingConfig(ctx).PaymentCheckHours * float64(time.Hour))
	for _, r := range rows {
		b, ok := byID[r.BookingID]
		if !ok {
			continue
		}
		out = append(out, paymentOut{r.Amount, b.Code, b.ID.Hex(), httpx.ISO(r.SubmittedAt.Add(check)), guestOut{b.Guest.Email, b.Guest.Name, b.Guest.Phone}, b.HostelSnapshot.Name,
			r.ID.Hex(), r.Note, r.ProofAssetID.Hex(), r.Reference, b.RoomType, httpx.ISO(r.SubmittedAt)})
	}
	return out, nil
}

func (p *Platform) bookingsByID(ctx context.Context, ids bson.A) (map[bson.ObjectID]*Booking, error) {
	cur, err := p.db.Collection("bookings").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}})
	if err != nil {
		return nil, err
	}
	var rows []Booking
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := make(map[bson.ObjectID]*Booking, len(rows))
	for i := range rows {
		out[rows[i].ID] = &rows[i]
	}
	return out, nil
}

func (p *Platform) payments(c *gin.Context) {
	out, err := p.Payments(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"payments": out}, "Payments to check")
}

var errNotInReview = bookingErr("This booking is not waiting for a payment check.", "BOOKING_NOT_IN_REVIEW", http.StatusConflict)

// ReviewPayment is reviewBookingPayment: the only path that turns a
// screenshot into a paid booking. The payment row and the booking move
// together (P7-31): TS claimed the row, then moved the booking, so a booking
// that had changed in between left a payment marked checked on a booking that
// never took it.
func (p *Platform) ReviewPayment(ctx context.Context, id string, approve bool, note string, actor bson.ObjectID, now time.Time) (PlatformView, error) {
	notFound := bookingErr("Payment not found.", "PAYMENT_NOT_FOUND", http.StatusNotFound)
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return PlatformView{}, notFound
	}
	payments := p.db.Collection("bookingpayments")
	var pay paymentRow
	err = payments.FindOne(ctx, bson.D{{Key: "_id", Value: oid}}).Decode(&pay)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return PlatformView{}, notFound
	}
	if err != nil {
		return PlatformView{}, err
	}
	reviewed := bookingErr("This payment has already been checked.", "PAYMENT_ALREADY_REVIEWED", http.StatusConflict)
	if pay.Status != "IN_REVIEW" {
		return PlatformView{}, reviewed
	}
	var b Booking
	err = p.db.Collection("bookings").FindOne(ctx, bson.D{{Key: "_id", Value: pay.BookingID}}).Decode(&b)
	if errors.Is(err, mongo.ErrNoDocuments) || (err == nil && b.Status != "PAYMENT_IN_REVIEW") {
		return PlatformView{}, errNotInReview
	}
	if err != nil {
		return PlatformView{}, err
	}
	if !approve && note == "" {
		return PlatformView{}, bookingErr("Say why, so the person knows what to fix.", "VALIDATION_ERROR", http.StatusUnprocessableEntity)
	}
	status := "REJECTED"
	if approve {
		status = "APPROVED"
	}
	var noteVal any
	if note != "" {
		noteVal = note
	}
	stamp := now.Truncate(time.Millisecond)
	claim := func(ctx context.Context) error {
		res, err := payments.UpdateOne(ctx, bson.D{{Key: "_id", Value: pay.ID}, {Key: "status", Value: "IN_REVIEW"}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "reviewNote", Value: noteVal}, {Key: "reviewedAt", Value: stamp}, {Key: "reviewedBy", Value: actor}, {Key: "status", Value: status}, {Key: "updatedAt", Value: stamp}}}})
		if err != nil {
			return err
		}
		if res.ModifiedCount == 0 {
			return reviewed
		}
		return nil
	}
	var result *Booking
	if approve {
		// MarkPaid notifies as it goes, so it cannot sit inside a transaction: the
		// claim is won first and given back if the booking's move is lost.
		if err := claim(ctx); err != nil {
			return PlatformView{}, err
		}
		paid, err := p.MarkPaid(ctx, &b, &actor, now, "PAYMENT_IN_REVIEW", nil)
		if err == nil && paid == nil {
			err = errNotInReview
		}
		if err != nil {
			if paid == nil {
				if _, uerr := payments.UpdateOne(ctx, bson.D{{Key: "_id", Value: pay.ID}, {Key: "status", Value: status}, {Key: "reviewedBy", Value: actor}},
					bson.D{{Key: "$set", Value: bson.D{{Key: "reviewNote", Value: nil}, {Key: "reviewedAt", Value: nil}, {Key: "reviewedBy", Value: nil}, {Key: "status", Value: "IN_REVIEW"}}}}); uerr != nil {
					slog.ErrorContext(ctx, "Booking payment claim could not be given back.", "paymentId", pay.ID.Hex(), "error", uerr)
				}
			}
			return PlatformView{}, err
		}
		result = paid
	} else {
		dueBy := stamp.Add(time.Duration(p.BookingConfig(ctx).UnpaidWindowHours * float64(time.Hour)))
		var waiting Booking
		err := appmongo.InTx(ctx, p.db, func(ctx context.Context) error {
			if err := claim(ctx); err != nil {
				return err
			}
			err := p.db.Collection("bookings").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: b.ID}, {Key: "status", Value: "PAYMENT_IN_REVIEW"}},
				bson.D{{Key: "$set", Value: bson.D{{Key: "paymentDueBy", Value: dueBy}, {Key: "paymentRejection", Value: bson.D{{Key: "at", Value: stamp}, {Key: "reason", Value: note}}},
					{Key: "paymentSubmittedAt", Value: nil}, {Key: "status", Value: "AWAITING_PAYMENT"}, {Key: "isOpen", Value: true}, {Key: "updatedAt", Value: stamp}}}},
				options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&waiting)
			if errors.Is(err, mongo.ErrNoDocuments) {
				return errNotInReview
			}
			return err
		})
		if err != nil {
			return PlatformView{}, err
		}
		m := email.BookingPaymentRejected(facts(&waiting), p.appURL(guestPath(&waiting)), waiting.Guest.Name, whenText(dueBy), note)
		p.notifyGuest(ctx, &waiting, "booking_payment_rejected", "We could not confirm your payment for "+waiting.Code+": "+note, &m, nil, "Payment not confirmed", "BOOKING_PAYMENT_REJECTED")
		result = &waiting
	}
	action := "BOOKING_PAYMENT_REJECTED"
	if approve {
		action = "BOOKING_PAYMENT_APPROVED"
	}
	if err := p.Audit.Write(ctx, audit.Entry{Action: action, ActorID: actor, EntityID: pay.ID.Hex(), EntityType: "BookingPayment", HostelID: b.HostelID,
		Metadata: bson.D{{Key: "amount", Value: pay.Amount}, {Key: "code", Value: b.Code}, {Key: "note", Value: noteVal}}}); err != nil {
		slog.WarnContext(ctx, "booking payment audit failed", "paymentId", pay.ID.Hex(), "error", err)
	}
	// TS answered with the raw booking row, sealed refund account included; the platform view is what every other route sends.
	return p.reload(ctx, result, now)
}

func (p *Platform) reviewPayment(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	approve, _ := f.Bool("approve", false, nil)
	note, _ := f.Str("note", valid.S{Opt: true, Trim: true, Max: 500})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := httpx.OID(authz.From(c).UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	v, err := p.ReviewPayment(c, c.Param("id"), approve, note, actor, time.Now().UTC())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"booking": v}, "Payment checked.")
}

/* ── Money out: GET transfers, POST transfers/:id/sent|reveal ── */

type account struct {
	BankName    string `bson:"bankName"`
	HolderName  string `bson:"holderName"`
	Method      string `bson:"method"`
	NumberLast4 string `bson:"numberLast4"`
}

type payoutAccountRow struct {
	Acct     account       `bson:",inline"`
	HostelID bson.ObjectID `bson:"hostelId"`
	Status   string        `bson:"status"`
}

type destinationOut struct {
	BankName     string `json:"bankName"`
	HolderName   string `json:"holderName"`
	MaskedNumber string `json:"maskedNumber"`
	Method       string `json:"method"`
	MethodLabel  string `json:"methodLabel"`
}

// describe is describeDestination: nil without a method.
func (a account) describe() *destinationOut {
	if a.Method == "" {
		return nil
	}
	return &destinationOut{a.BankName, a.HolderName, masked(a.NumberLast4), a.Method, payoutLabels[a.Method]}
}

func (a account) text() string {
	method := a.Method
	return destinationText(&Destination{BankName: a.BankName, HolderName: a.HolderName, Method: &method, NumberLast4: a.NumberLast4})
}

type TransferView struct {
	Amount         int64           `json:"amount"`
	Blocked        *string         `json:"blocked"`
	BookingCode    string          `json:"bookingCode"`
	BookingID      string          `json:"bookingId"`
	Destination    *destinationOut `json:"destination"`
	DocumentNumber *string         `json:"documentNumber"`
	DueSince       *string         `json:"dueSince"`
	GuestName      string          `json:"guestName"`
	HostelName     string          `json:"hostelName"`
	ID             string          `json:"id"`
	Kind           string          `json:"kind"`
	RoomType       string          `json:"roomType"`
	SentAt         *string         `json:"sentAt"`
	Status         string          `json:"status"`
	TransactionID  *string         `json:"transactionId"`
}

// payoutBlock is payoutBlock: why a payout cannot go, or nil.
func payoutBlock(acc *payoutAccountRow) *string {
	block := ""
	switch {
	case acc == nil:
		block = "NO_PAYOUT_ACCOUNT"
	case acc.Status != "VERIFIED":
		block = "PAYOUT_ACCOUNT_NOT_VERIFIED"
	default:
		return nil
	}
	return &block
}

// toTransferView is toTransferView: sent shows where it went, due where it would go today.
func toTransferView(t *platformTransfer, b *Booking, acc *payoutAccountRow) TransferView {
	var dest *destinationOut
	switch {
	case t.Status == "SENT":
		if d := t.Destination; d != nil && d.Method != nil {
			dest = account{d.BankName, d.HolderName, *d.Method, d.NumberLast4}.describe()
		}
	case t.Kind == "REFUND":
		dest = account{b.RefundAccount.BankName, b.RefundAccount.HolderName, b.RefundAccount.Method, b.RefundAccount.NumberLast4}.describe()
	case acc != nil:
		dest = acc.Acct.describe()
	}
	v := TransferView{Amount: t.Amount, BookingCode: b.Code, BookingID: b.ID.Hex(), Destination: dest, DocumentNumber: t.DocumentNumber, DueSince: isoOf(t.CreatedAt),
		GuestName: b.Guest.Name, HostelName: b.HostelSnapshot.Name, ID: t.ID.Hex(), Kind: t.Kind, RoomType: b.RoomType, SentAt: isoOf(t.SentAt), Status: t.Status, TransactionID: t.TransactionID}
	if t.Status == "DUE" && t.Kind == "PAYOUT" {
		v.Blocked = payoutBlock(acc)
	}
	return v
}

// Transfers is listTransfersDue: money owed, oldest first; payouts to an
// unverified account are listed, marked blocked.
func (p *Platform) Transfers(ctx context.Context, kind string) ([]TransferView, error) {
	filter := bson.D{{Key: "status", Value: "DUE"}}
	if kind != "" {
		filter = append(filter, bson.E{Key: "kind", Value: kind})
	}
	cur, err := p.db.Collection("bookingtransfers").Find(ctx, filter, options.Find().SetSort(bson.D{{Key: "createdAt", Value: 1}}).SetLimit(200))
	if err != nil {
		return nil, err
	}
	var rows []platformTransfer
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := make([]TransferView, 0, len(rows))
	if len(rows) == 0 {
		return out, nil
	}
	ids := bson.A{}
	for _, t := range rows {
		ids = append(ids, t.BookingID)
	}
	byID, err := p.bookingsByID(ctx, ids)
	if err != nil {
		return nil, err
	}
	hostelIDs := bson.A{}
	for _, b := range byID {
		hostelIDs = append(hostelIDs, b.HostelID)
	}
	cur, err = p.db.Collection("hostelpayoutaccounts").Find(ctx, bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: hostelIDs}}}})
	if err != nil {
		return nil, err
	}
	var accounts []payoutAccountRow
	if err := cur.All(ctx, &accounts); err != nil {
		return nil, err
	}
	byHostel := make(map[bson.ObjectID]*payoutAccountRow, len(accounts))
	for i := range accounts {
		byHostel[accounts[i].HostelID] = &accounts[i]
	}
	for i := range rows {
		if b, ok := byID[rows[i].BookingID]; ok {
			out = append(out, toTransferView(&rows[i], b, byHostel[b.HostelID]))
		}
	}
	return out, nil
}

func (p *Platform) transfers(c *gin.Context) {
	kind := c.Query("kind")
	if kind != "REFUND" && kind != "PAYOUT" {
		kind = ""
	}
	out, err := p.Transfers(c, kind)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"transfers": out}, "Money to send")
}

func (p *Platform) loadTransfer(ctx context.Context, id string) (*platformTransfer, error) {
	notFound := bookingErr("Transfer not found.", "TRANSFER_NOT_FOUND", http.StatusNotFound)
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return nil, notFound
	}
	var t platformTransfer
	err = p.db.Collection("bookingtransfers").FindOne(ctx, bson.D{{Key: "_id", Value: oid}}).Decode(&t)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, notFound
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

var errBookingMissing = bookingErr("The booking behind this transfer is missing.", "BOOKING_NOT_FOUND", http.StatusNotFound)

// documentKinds is allocate's prefix and width for a transfer's paper.
var documentKinds = map[string][2]string{"REFUND": {"BOOKING_REFUND", "HH-BRF"}, "PAYOUT": {"BOOKING_PAYOUT", "HH-BPO"}}

// MarkSent is markTransferSent: the money has left in a banking app; record it
// with where it went, number its paper, tell the person or the hostel. A
// payout never goes to an account we have not verified.
func (p *Platform) MarkSent(ctx context.Context, id, transactionID, note, proofID string, actor bson.ObjectID, now time.Time) (TransferView, error) {
	t, err := p.loadTransfer(ctx, id)
	if err != nil {
		return TransferView{}, err
	}
	alreadySent := bookingErr("This has already been marked sent.", "TRANSFER_ALREADY_SENT", http.StatusConflict)
	if t.Status != "DUE" {
		return TransferView{}, alreadySent
	}
	var b Booking
	err = p.db.Collection("bookings").FindOne(ctx, bson.D{{Key: "_id", Value: t.BookingID}}).Decode(&b)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return TransferView{}, errBookingMissing
	}
	if err != nil {
		return TransferView{}, err
	}
	var acc *payoutAccountRow
	source := account{b.RefundAccount.BankName, b.RefundAccount.HolderName, b.RefundAccount.Method, b.RefundAccount.NumberLast4}
	if t.Kind == "PAYOUT" {
		var row payoutAccountRow
		switch err := p.db.Collection("hostelpayoutaccounts").FindOne(ctx, bson.D{{Key: "hostelId", Value: b.HostelID}}).Decode(&row); {
		case err == nil:
			acc = &row
		case !errors.Is(err, mongo.ErrNoDocuments):
			return TransferView{}, err
		}
		if payoutBlock(acc) != nil {
			return TransferView{}, bookingErr("Verify this hostel's payout account before sending it money.", "PAYOUT_ACCOUNT_NOT_VERIFIED", http.StatusConflict)
		}
		source = acc.Acct
	}
	var proof any
	if proofID != "" {
		oid, _ := bson.ObjectIDFromHex(proofID)
		var asset struct {
			HostelID *bson.ObjectID `bson:"hostelId"`
			Kind     string         `bson:"kind"`
			OwnerID  bson.ObjectID  `bson:"ownerId"`
		}
		err := p.db.Collection("fileassets").FindOne(ctx, bson.D{{Key: "_id", Value: oid}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&asset)
		if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
			return TransferView{}, err
		}
		if err != nil || asset.OwnerID != actor || asset.Kind != "BOOKING_TRANSFER_PROOF" || asset.HostelID != nil {
			return TransferView{}, bookingErr("Attach the screenshot of the transfer you sent.", "PROOF_NOT_OWNED", http.StatusUnprocessableEntity)
		}
		proof = oid
	}
	var noteVal any
	if note != "" {
		noteVal = note
	}
	var method any
	if source.Method != "" {
		method = source.Method
	}
	stamp := now.Truncate(time.Millisecond)
	transfers := p.db.Collection("bookingtransfers")
	var sent platformTransfer
	err = transfers.FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: t.ID}, {Key: "status", Value: "DUE"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "destination", Value: bson.D{{Key: "bankName", Value: source.BankName}, {Key: "holderName", Value: source.HolderName}, {Key: "method", Value: method}, {Key: "numberLast4", Value: source.NumberLast4}}},
			{Key: "note", Value: noteVal}, {Key: "proofAssetId", Value: proof}, {Key: "sentAt", Value: stamp}, {Key: "sentBy", Value: actor}, {Key: "status", Value: "SENT"}, {Key: "transactionId", Value: transactionID},
			{Key: "updatedAt", Value: stamp}}}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&sent)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return TransferView{}, alreadySent
	}
	if err != nil {
		return TransferView{}, err
	}
	// Numbered once the money is recorded as gone, so a lost race never burns a number.
	doc := documentKinds[sent.Kind]
	var docNumber any
	if number, err := p.allocate(ctx, doc[0], doc[1], now); err != nil {
		slog.ErrorContext(ctx, "Booking transfer was marked sent but could not be numbered.", "transferId", sent.ID.Hex(), "error", err)
	} else if _, err := transfers.UpdateOne(ctx, bson.D{{Key: "_id", Value: sent.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "documentNumber", Value: number}}}}); err != nil {
		slog.ErrorContext(ctx, "Booking transfer was marked sent but could not be numbered.", "transferId", sent.ID.Hex(), "error", err)
	} else {
		sent.DocumentNumber, docNumber = &number, number
	}
	if err := p.Audit.Write(ctx, audit.Entry{Action: "BOOKING_TRANSFER_SENT", ActorID: actor, EntityID: sent.ID.Hex(), EntityType: "BookingTransfer", HostelID: b.HostelID,
		Metadata: bson.D{{Key: "amount", Value: sent.Amount}, {Key: "code", Value: b.Code}, {Key: "documentNumber", Value: docNumber}, {Key: "kind", Value: sent.Kind}, {Key: "transactionId", Value: transactionID}}}); err != nil {
		slog.WarnContext(ctx, "booking transfer audit failed", "transferId", sent.ID.Hex(), "error", err)
	}
	sentTo, sentOn, number := source.text(), whenText(now), ""
	if sent.DocumentNumber != nil {
		number = *sent.DocumentNumber
	}
	if sent.Kind == "REFUND" {
		m := email.BookingRefundSent(sent.Amount, facts(&b), p.appURL(guestPath(&b)), number, b.Guest.Name, sentTo, sentOn, transactionID)
		p.notifyGuest(ctx, &b, "booking_refund_sent", fmt.Sprintf("%s refunded to %s. Transaction %s.", email.Rupees(sent.Amount), sentTo, transactionID), &m, nil, "Refund sent", "BOOKING_REFUND_SENT")
	} else {
		p.notifyHostel(ctx, &b, "booking_payout_sent", fmt.Sprintf("%s for booking %s sent to %s. Transaction %s.", email.Rupees(sent.Amount), b.Code, sentTo, transactionID),
			func(name string) email.Content {
				return email.BookingPayoutSent(sent.Amount, p.appURL(hostelPath(&b)), b.Code, number, b.Guest.Name, b.HostelSnapshot.Name, name, sentTo, b.RoomType, sentOn, transactionID)
			}, "", "Payout sent", "BOOKING_PAYOUT_SENT")
	}
	return toTransferView(&sent, &b, acc), nil
}

type revealedRefund struct {
	destinationOut
	Branch string `json:"branch"`
	Number string `json:"number"`
}

// RevealRefundAccount is revealTransferDestination for a refund: the full
// number to type into a banking app, written to the audit log before it is shown.
func (p *Platform) RevealRefundAccount(ctx context.Context, t *platformTransfer, actor bson.ObjectID) (any, error) {
	var b struct {
		ID            bson.ObjectID `bson:"_id"`
		Code          string        `bson:"code"`
		HostelID      bson.ObjectID `bson:"hostelId"`
		RefundAccount struct {
			Acct   account         `bson:",inline"`
			Branch string          `bson:"branch"`
			Number crypto.Envelope `bson:"number"`
		} `bson:"refundAccount"`
	}
	err := p.db.Collection("bookings").FindOne(ctx, bson.D{{Key: "_id", Value: t.BookingID}}).Decode(&b)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, errBookingMissing
	}
	if err != nil {
		return nil, err
	}
	keys, err := p.FinanceKeys()
	if err != nil {
		return nil, err
	}
	number, err := crypto.DecryptSecret(b.RefundAccount.Number, refundScope(b.ID), keys)
	if err != nil {
		return nil, err
	}
	if err := p.Audit.Write(ctx, audit.Entry{Action: "BOOKING_REFUND_ACCOUNT_REVEALED", ActorID: actor, EntityID: b.ID.Hex(), EntityType: "Booking", HostelID: b.HostelID,
		Metadata: bson.D{{Key: "code", Value: b.Code}, {Key: "last4", Value: b.RefundAccount.Acct.NumberLast4}}}); err != nil {
		return nil, err
	}
	out := revealedRefund{Branch: b.RefundAccount.Branch, Number: number}
	if d := b.RefundAccount.Acct.describe(); d != nil {
		out.destinationOut = *d
		return out, nil
	}
	// No method on file: TS spread null, leaving only the branch and number.
	return gin.H{"branch": out.Branch, "number": out.Number}, nil
}

func (p *Platform) transferAction(c *gin.Context) {
	action := c.Param("action")
	if action != "sent" && action != "reveal" {
		notFoundPlain(c)
		return
	}
	actor, err := httpx.OID(authz.From(c).UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if action == "sent" {
		body, err := valid.Body(c)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		f := valid.NewForm(body)
		note, _ := f.Str("note", valid.S{Opt: true, Trim: true, Max: 500})
		proof, hasProof := f.Str("proofAssetId", valid.S{Opt: true, Trim: true})
		if hasProof && !hexID.MatchString(proof) {
			f.Is.Add("proofAssetId", "Not a valid id.")
		}
		tx, _ := f.Str("transactionId", valid.S{Trim: true, Min: 3, MinMsg: "Enter the transaction ID.", Max: 64})
		if err := f.Err(); err != nil {
			httpx.Fail(c, err)
			return
		}
		v, err := p.MarkSent(c, c.Param("id"), tx, note, proof, actor, time.Now().UTC())
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		httpx.OK(c, gin.H{"transfer": v}, "Marked sent.")
		return
	}
	t, err := p.loadTransfer(c, c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var acct any
	if t.Kind == "PAYOUT" {
		hostelID := ""
		if t.HostelID != nil {
			hostelID = t.HostelID.Hex()
		} else {
			var b struct {
				HostelID bson.ObjectID `bson:"hostelId"`
			}
			if err := p.db.Collection("bookings").FindOne(c, bson.D{{Key: "_id", Value: t.BookingID}}).Decode(&b); err == nil {
				hostelID = b.HostelID.Hex()
			} else if !errors.Is(err, mongo.ErrNoDocuments) {
				httpx.Fail(c, err)
				return
			}
		}
		acct, err = p.Payouts.RevealPayout(c, hostelID, actor)
	} else {
		acct, err = p.RevealRefundAccount(c, t, actor)
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	// A full account number is never cached (TS sent none on this route).
	c.Header("Cache-Control", "no-store")
	httpx.OK(c, gin.H{"account": acct, "kind": t.Kind}, "Account number")
}

/* ── Payout accounts ── */

func (p *Platform) payoutAccounts(c *gin.Context) {
	status, hostel := c.Query("status"), c.Query("hostelId")
	if !slices.Contains([]string{"PENDING_REVIEW", "VERIFIED", "REJECTED"}, status) {
		status = ""
	}
	var hostelID *bson.ObjectID
	if hexID.MatchString(hostel) {
		oid, _ := bson.ObjectIDFromHex(hostel)
		hostelID = &oid
	}
	out, err := p.Payouts.ListPayouts(c, status, hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"accounts": out}, "Payout accounts")
}

func (p *Platform) revealPayout(c *gin.Context) {
	actor, err := httpx.OID(authz.From(c).UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	acct, err := p.Payouts.RevealPayout(c, c.Param("hostelId"), actor)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	httpx.OK(c, gin.H{"account": acct}, "Payout account")
}

func (p *Platform) reviewPayout(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	approve, _ := f.Bool("approve", false, nil)
	note, _ := f.Str("note", valid.S{Opt: true, Trim: true, Max: 500})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := httpx.OID(authz.From(c).UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	acct, err := p.Payouts.ReviewPayout(c, c.Param("hostelId"), approve, note, actor)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	msg := "Payout account sent back"
	if approve {
		msg = "Payout account verified"
	}
	httpx.OK(c, gin.H{"account": acct}, msg)
}

/* ── Settings, documents ── */

func (p *Platform) settings(c *gin.Context) {
	var config, pending any
	g, gctx := errgroup.WithContext(c)
	g.Go(func() (err error) { config, err = p.cfg.Section(gctx, "bookings"); return err })
	g.Go(func() (err error) { pending, err = p.Settings.PendingChange(gctx, "bookings"); return err })
	if err := g.Wait(); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "config", Value: config}, {Key: "pending", Value: pending}}, "Booking settings loaded")
}

// requestSettings is mergeBookingConfig + requestSettingChange: nothing is
// saved here; the merged terms are checked whole and a confirm link is emailed.
func (p *Platform) requestSettings(c *gin.Context) {
	body, err := valid.OrderedBody(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	current, err := p.cfg.Section(c, "bookings")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	merged, _ := current.(ordered.Map)
	merged = append(ordered.Map{}, merged...)
	if in, ok := body.(ordered.Map); ok {
		for _, kv := range in {
			merged = merged.Set(kv.Key, kv.Value)
		}
	}
	pending, err := p.Settings.RequestChange(c, "bookings", merged, authz.From(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	sentTo, _ := pending.Get("sentTo")
	httpx.OK(c, ordered.Map{{Key: "pending", Value: pending}}, fmt.Sprintf("Check your email. We sent a confirm link to %v.", sentTo))
}

// document is GET /platform/bookings/documents/:kind/:number: any booking
// paper, for a superadmin; a moderator gets the 404 a missing number gets.
func (p *Platform) document(c *gin.Context) {
	pr, err := p.Guards.RequirePlatform(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if pr.Role != authz.Superadmin {
		notFoundPlain(c)
		return
	}
	number, err := url.PathUnescape(c.Param("number"))
	if err != nil {
		notFoundPlain(c)
		return
	}
	p.serveDocument(c, c.Param("kind"), number, func(string, *Booking) bool { return true })
}
