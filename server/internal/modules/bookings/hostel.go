package bookings

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Hostel is the hostel admin's side of bookings: the queue, the answer, the
// short-stay settings (booking-queries, booking-answer, short-stay-settings).
type Hostel struct {
	*Signed
	// Claim holds a bed of a type (hostel-capacity claimBedForRoomType).
	Claim func(ctx context.Context, hostel bson.ObjectID, roomType string) error
}

func bookingErr(msg, code string, status int) *httpx.Error {
	return httpx.NewError(status, code, msg, nil)
}

type transferRow struct {
	Amount         int64         `bson:"amount"`
	BookingID      bson.ObjectID `bson:"bookingId"`
	DocumentNumber *string       `bson:"documentNumber"`
	SentAt         *time.Time    `bson:"sentAt"`
	Status         string        `bson:"status"`
	TransactionID  *string       `bson:"transactionId"`
}

var endedStatuses = bson.A{"CHECKED_IN", "DECLINED", "HOSTEL_NO_RESPONSE", "CANCELLED_BY_USER", "CANCELLED_BY_HOSTEL", "CANCELLED_BY_PLATFORM", "NO_SHOW"}

func isoPtr(t *time.Time) any {
	if t == nil {
		return nil
	}
	return httpx.ISO(*t)
}

func stayView(s *Stay) any {
	if s == nil {
		return nil
	}
	return ordered.Map{{Key: "amount", Value: s.Amount}, {Key: "dailyRate", Value: s.DailyRate}, {Key: "dates", Value: stayDatesText(s)}, {Key: "holdBlocks", Value: s.HoldBlocks},
		{Key: "moveIn", Value: s.MoveIn.UTC().Format("2006-01-02")}, {Key: "moveOut", Value: s.MoveOut.UTC().Format("2006-01-02")}, {Key: "nights", Value: s.Nights}}
}

// hostelView is toHostelView.
func hostelView(b *Booking, payout *transferRow, now time.Time) ordered.Map {
	var settlement, planned, pay any
	if b.Settlement != nil && b.Settlement.HostelShare != nil {
		settlement = ordered.Map{{Key: "hostelShare", Value: *b.Settlement.HostelShare}}
	}
	if b.PlannedMoveIn != nil {
		planned = b.PlannedMoveIn.UTC().Format("2006-01-02")
	}
	if payout != nil {
		var doc, tx any
		if payout.Status == "SENT" {
			if payout.DocumentNumber != nil {
				doc = *payout.DocumentNumber
			}
			if payout.TransactionID != nil {
				tx = *payout.TransactionID
			}
		}
		pay = ordered.Map{{Key: "amount", Value: payout.Amount}, {Key: "documentNumber", Value: doc}, {Key: "sentAt", Value: isoPtr(payout.SentAt)}, {Key: "status", Value: payout.Status}, {Key: "transactionId", Value: tx}}
	}
	var reason any
	if b.EndReason != nil {
		reason = *b.EndReason
	}
	kind := b.Kind
	if kind == "" {
		kind = "MONTHLY"
	}
	share := settleBooking(now, b.ConfirmedAt, "CHECKED_IN", b.Fee, b.Stay, b.Terms).HostelShare
	return ordered.Map{
		{Key: "checkedInAt", Value: isoPtr(b.CheckedInAt)}, {Key: "code", Value: b.Code}, {Key: "confirmedAt", Value: isoPtr(b.ConfirmedAt)}, {Key: "createdAt", Value: httpx.ISO(b.CreatedAt)},
		{Key: "endReason", Value: reason}, {Key: "endedAt", Value: isoPtr(b.EndedAt)},
		{Key: "guest", Value: ordered.Map{{Key: "email", Value: b.Guest.Email}, {Key: "name", Value: b.Guest.Name}, {Key: "phone", Value: b.Guest.Phone}}},
		{Key: "holdEndsAt", Value: isoPtr(b.HoldEndsAt)}, {Key: "hostelAnswerBy", Value: isoPtr(b.HostelAnswerBy)}, {Key: "hostelShareIfKept", Value: share},
		{Key: "id", Value: b.ID.Hex()}, {Key: "kind", Value: kind}, {Key: "monthlyRent", Value: b.MonthlyRent}, {Key: "payout", Value: pay}, {Key: "plannedMoveIn", Value: planned},
		{Key: "roomType", Value: b.RoomType}, {Key: "settlement", Value: settlement}, {Key: "status", Value: b.Status}, {Key: "statusLabel", Value: statusLabels[b.Status]},
		{Key: "stay", Value: stayView(b.Stay)}, {Key: "strike", Value: b.HostelStrike},
	}
}

// List is listHostelBookings.
func (h *Hostel) List(ctx context.Context, hostel bson.ObjectID, tab string, now time.Time) (ordered.Map, error) {
	statuses, sortKey, dir := bson.A{"AWAITING_HOSTEL"}, "hostelAnswerBy", 1
	switch tab {
	case "confirmed":
		statuses, sortKey, dir = bson.A{"CONFIRMED"}, "holdEndsAt", 1
	case "history":
		statuses, sortKey, dir = endedStatuses, "endedAt", -1
	}
	paid := bson.D{{Key: "hostelId", Value: hostel}, {Key: "paymentVerifiedAt", Value: bson.D{{Key: "$ne", Value: nil}}}}
	coll := h.db.Collection("bookings")
	cur, err := coll.Find(ctx, append(append(bson.D{}, paid...), bson.E{Key: "status", Value: bson.D{{Key: "$in", Value: statuses}}}), options.Find().SetSort(bson.D{{Key: sortKey, Value: dir}}).SetLimit(200))
	if err != nil {
		return nil, err
	}
	var rows []Booking
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	count := func(status string) (int64, error) {
		return coll.CountDocuments(ctx, append(append(bson.D{}, paid...), bson.E{Key: "status", Value: status}))
	}
	requests, err := count("AWAITING_HOSTEL")
	if err != nil {
		return nil, err
	}
	confirmed, err := count("CONFIRMED")
	if err != nil {
		return nil, err
	}
	tcur, err := h.db.Collection("bookingtransfers").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "kind", Value: "PAYOUT"}},
		options.Find().SetProjection(bson.D{{Key: "amount", Value: 1}, {Key: "bookingId", Value: 1}, {Key: "status", Value: 1}, {Key: "documentNumber", Value: 1}, {Key: "sentAt", Value: 1}, {Key: "transactionId", Value: 1}}).SetLimit(5000))
	if err != nil {
		return nil, err
	}
	var payouts []transferRow
	if err := tcur.All(ctx, &payouts); err != nil {
		return nil, err
	}
	by := map[bson.ObjectID]*transferRow{}
	var due, sent int64
	for i := range payouts {
		by[payouts[i].BookingID] = &payouts[i]
		switch payouts[i].Status {
		case "DUE":
			due += payouts[i].Amount
		case "SENT":
			sent += payouts[i].Amount
		}
	}
	var hs struct {
		Pause *struct {
			PausedAt *time.Time `bson:"pausedAt"`
			Reason   *string    `bson:"reason"`
		} `bson:"bookingPause"`
	}
	if err := h.db.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "bookingPause", Value: 1}})).Decode(&hs); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	var pausedAt, pauseReason any
	if hs.Pause != nil {
		pausedAt = isoPtr(hs.Pause.PausedAt)
		if hs.Pause.Reason != nil {
			pauseReason = *hs.Pause.Reason
		}
	}
	views := make([]ordered.Map, 0, len(rows))
	for i := range rows {
		views = append(views, hostelView(&rows[i], by[rows[i].ID], now))
	}
	return ordered.Map{{Key: "bookings", Value: views}, {Key: "counts", Value: ordered.Map{{Key: "confirmed", Value: confirmed}, {Key: "requests", Value: requests}}},
		{Key: "owed", Value: ordered.Map{{Key: "due", Value: due}, {Key: "sent", Value: sent}}}, {Key: "pause", Value: ordered.Map{{Key: "pausedAt", Value: pausedAt}, {Key: "reason", Value: pauseReason}}}}, nil
}

var residentIDRe = regexp.MustCompile(`^HH[A-Z0-9]{8}$`)
var nonAlnum = regexp.MustCompile(`[^A-Z0-9]`)

// NormalizeResidentID is normalizeResidentId: the card number from a typed ID or a scanned URL.
func NormalizeResidentID(value string) string {
	path := strings.TrimSpace(value)
	if i := strings.IndexAny(path, "?#"); i >= 0 {
		path = path[:i]
	}
	tail := path
	for _, part := range strings.Split(path, "/") {
		if part != "" {
			tail = part
		}
	}
	compact := nonAlnum.ReplaceAllString(strings.ToUpper(tail), "")
	if !residentIDRe.MatchString(compact) {
		return ""
	}
	return "HH-" + compact[2:6] + "-" + compact[6:10]
}

// Card is findCardBooking: the held booking behind a scanned card, or nil.
func (h *Hostel) Card(ctx context.Context, hostel bson.ObjectID, card string, now time.Time) (any, error) {
	id := NormalizeResidentID(card)
	if id == "" {
		return nil, nil
	}
	var user struct {
		ID bson.ObjectID `bson:"_id"`
	}
	err := h.db.Collection("users").FindOne(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "userResidentId", Value: id}}, options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Decode(&user)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	b, err := h.FindHeld(ctx, hostel, user.ID, now)
	if err != nil || b == nil {
		return nil, err
	}
	return ordered.Map{{Key: "code", Value: b.Code}, {Key: "guestName", Value: b.Guest.Name}, {Key: "holdEndsAt", Value: isoPtr(b.HoldEndsAt)}, {Key: "roomType", Value: b.RoomType}}, nil
}

func (h *Hostel) loadFor(ctx context.Context, id string, p *authz.Principal) (*Booking, error) {
	notFound := bookingErr("Booking not found.", "BOOKING_NOT_FOUND", http.StatusNotFound)
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil || len(id) != 24 {
		return nil, notFound
	}
	var b Booking
	err = h.db.Collection("bookings").FindOne(ctx, bson.D{{Key: "_id", Value: oid}}).Decode(&b)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, notFound
	}
	if err != nil {
		return nil, err
	}
	if p.Role != authz.HostelAdmin || !authz.CanAccessHostel(p, b.HostelID.Hex()) {
		return nil, notFound
	}
	return &b, nil
}

func (h *Hostel) missedAnswer(ctx context.Context, b *Booking, now time.Time) error {
	ended, err := h.endBooking(ctx, b, endInput{from: "AWAITING_HOSTEL", status: "HOSTEL_NO_RESPONSE", strike: true}, now)
	if err == nil && ended != nil {
		h.announceEnding(ctx, ended, b.Status)
	}
	return err
}

func (h *Hostel) assertAwaiting(ctx context.Context, b *Booking, now time.Time) error {
	if b.Status != "AWAITING_HOSTEL" {
		return bookingErr("This booking is not waiting for your answer.", "BOOKING_NOT_AWAITING_HOSTEL", http.StatusConflict)
	}
	if past(b.HostelAnswerBy, now) {
		if err := h.missedAnswer(ctx, b, now); err != nil {
			return err
		}
		return bookingErr("The time to answer this booking has passed. The guest is refunded in full.", "ANSWER_WINDOW_CLOSED", http.StatusConflict)
	}
	return nil
}

var stateChanged = func() error {
	return bookingErr("This booking has just changed. Refresh to see where it stands.", "BOOKING_STATE_CHANGED", http.StatusConflict)
}

func directionsURL(loc *struct {
	Address, Area, City, Landmark, MapLink string
	Lat, Lng                               *float64
}) string {
	if loc == nil {
		return ""
	}
	if strings.HasPrefix(strings.ToLower(loc.MapLink), "https://") {
		return loc.MapLink
	}
	if loc.Lat != nil && loc.Lng != nil {
		return fmt.Sprintf("https://www.google.com/maps/search/?api=1&query=%s,%s", jsNum(*loc.Lat), jsNum(*loc.Lng))
	}
	var parts []string
	for _, v := range []string{loc.Address, loc.Area, loc.City} {
		if v != "" {
			parts = append(parts, v)
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return "https://www.google.com/maps/search/?api=1&query=" + url.QueryEscape(strings.Join(parts, ", "))
}

func (h *Hostel) announceConfirmed(ctx context.Context, b *Booking) {
	var hs struct {
		Contact  struct{ Phone string } `bson:"contact"`
		Location *struct {
			Address, Area, City, Landmark, MapLink string
			Lat, Lng                               *float64
		} `bson:"location"`
	}
	_ = h.db.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: b.HostelID}}, options.FindOne().SetProjection(bson.D{{Key: "contact", Value: 1}, {Key: "location", Value: 1}})).Decode(&hs)
	confirmed := time.Now()
	if b.ConfirmedAt != nil {
		confirmed = *b.ConfirmedAt
	}
	rows := policyRows(b.Terms, b.Fee)
	steps := make([]email.ConfirmedStep, len(rows))
	for i, r := range rows {
		steps[i] = email.ConfirmedStep{Refund: r.Refund, RefundPercent: jsNum(r.RefundPercent), Until: whenText(addDays(confirmed, r.ThroughDay))}
	}
	holdEnds := ""
	if b.HoldEndsAt != nil {
		holdEnds = whenText(*b.HoldEndsAt)
	}
	phone := hs.Contact.Phone
	if phone == "" {
		phone = b.HostelSnapshot.Phone
	}
	landmark := ""
	if hs.Location != nil {
		landmark = hs.Location.Landmark
	}
	noShow := settlementFor(b.Fee, b.Terms.NoShowRefundPercent, b.Terms.HostelSharePercent).Refund
	mail := email.BookingConfirmed(facts(b), b.HostelSnapshot.Address, h.appURL(guestPath(b)), directionsURL(hs.Location), holdEnds, phone, landmark, b.Guest.Name, noShow, steps)
	h.notifyGuest(ctx, b, "booking_confirmed", b.HostelSnapshot.Name+" confirmed "+b.Code+". Move in by "+holdEnds+".", &mail, nil, "Booking confirmed", "BOOKING_CONFIRMED")
}

func whenText(t time.Time) string { return email.EmailDateTime(t) }

// Confirm is confirmBooking: the bed is held and the guest told.
func (h *Hostel) Confirm(ctx context.Context, id string, p *authz.Principal, now time.Time) (ordered.Map, error) {
	b, err := h.loadFor(ctx, id, p)
	if err != nil {
		return nil, err
	}
	if err := h.assertAwaiting(ctx, b, now); err != nil {
		return nil, err
	}
	if err := h.Claim(ctx, b.HostelID, b.RoomType); err != nil {
		if c := httpx.Code(err); c == "ROOM_TYPE_FULL" || c == "ROOM_TYPE_NOT_FOUND" {
			return nil, bookingErr("No vacant "+email.RoomTypeLabel(b.RoomType)+" bed is left to hold. Free one, or decline this booking.", "ROOM_TYPE_FULL", http.StatusConflict)
		}
		return nil, err
	}
	holdEnds := now.Add(millis(b.Terms.HoldDays * 24 * 60 * 60 * 1000))
	if b.Stay != nil {
		holdEnds = bs.DayEnd(b.Stay.MoveIn, 1)
	}
	by := hostelrooms.UserID(p)
	var confirmed Booking
	err = h.db.Collection("bookings").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: b.ID}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"AWAITING_HOSTEL"}}}}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "bedHeld", Value: true}, {Key: "confirmedAt", Value: now}, {Key: "confirmedBy", Value: by}, {Key: "holdEndsAt", Value: holdEnds}, {Key: "status", Value: "CONFIRMED"},
			{Key: "isOpen", Value: true}, {Key: "updatedAt", Value: now}}}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&confirmed)
	if errors.Is(err, mongo.ErrNoDocuments) {
		if rerr := h.releaseBed(ctx, b.HostelID, b.RoomType, now); rerr != nil {
			return nil, rerr
		}
		return nil, stateChanged()
	}
	if err != nil {
		return nil, err
	}
	_ = h.Audit.Write(ctx, audit.Entry{ActorID: by, HostelID: b.HostelID, Action: "BOOKING_CONFIRMED", EntityType: "Booking", EntityID: b.ID.Hex(),
		Metadata: bson.D{{Key: "code", Value: b.Code}, {Key: "holdEndsAt", Value: httpx.ISO(holdEnds)}}})
	h.announceConfirmed(ctx, &confirmed)
	return hostelView(&confirmed, nil, now), nil
}

// Decline is declineBooking; Cancel is cancelBookingByHostel.
func (h *Hostel) Decline(ctx context.Context, id string, reason *string, p *authz.Principal, now time.Time) (ordered.Map, error) {
	b, err := h.loadFor(ctx, id, p)
	if err != nil {
		return nil, err
	}
	if err := h.assertAwaiting(ctx, b, now); err != nil {
		return nil, err
	}
	by := hostelrooms.UserID(p)
	ended, err := h.endBooking(ctx, b, endInput{actor: &by, from: "AWAITING_HOSTEL", reason: reason, status: "DECLINED"}, now)
	if err != nil {
		return nil, err
	}
	if ended == nil {
		return nil, stateChanged()
	}
	h.announceEnding(ctx, ended, b.Status)
	return hostelView(ended, nil, now), nil
}

func (h *Hostel) Cancel(ctx context.Context, id string, reason string, p *authz.Principal, now time.Time) (ordered.Map, error) {
	b, err := h.loadFor(ctx, id, p)
	if err != nil {
		return nil, err
	}
	if b.Status != "CONFIRMED" {
		return nil, bookingErr("Only a booking you confirmed can be cancelled. Decline one that is waiting for your answer.", "BOOKING_NOT_CONFIRMED", http.StatusConflict)
	}
	if past(b.HoldEndsAt, now) {
		if err := h.EndAsNoShow(ctx, b, now); err != nil {
			return nil, err
		}
		return nil, bookingErr("The hold on this booking has already ended.", "HOLD_ENDED", http.StatusConflict)
	}
	by := hostelrooms.UserID(p)
	ended, err := h.endBooking(ctx, b, endInput{actor: &by, from: "CONFIRMED", reason: &reason, status: "CANCELLED_BY_HOSTEL", strike: true}, now)
	if err != nil {
		return nil, err
	}
	if ended == nil {
		return nil, stateChanged()
	}
	h.announceEnding(ctx, ended, b.Status)
	return hostelView(ended, nil, now), nil
}

// Register mounts the /hostel-admin/bookings routes.
func (h *Hostel) Register(v1 *gin.RouterGroup) {
	admin := authz.Use(h.Guards.RequireHostelAdmin)
	g := v1.Group("/hostel-admin/bookings")
	g.GET("", admin, httpx.ETag(), h.list)
	g.GET("/card", hostelrooms.Cap(h.Guards, "registerResidents"), httpx.ETag(), h.card)
	g.GET("/documents/:number", admin, h.HostelDocument)
	g.GET("/short-stays", admin, httpx.ETag(), h.getShortStays)
	g.PUT("/short-stays", admin, h.putShortStays)
	g.POST("/:id/:action", admin, h.answer)
}

func (h *Hostel) list(c *gin.Context) {
	q := valid.Query(c)
	hostel, ok := hostelrooms.HostelOf(c, q["hostelId"])
	if !ok {
		return
	}
	out, err := h.List(c, hostel, q["tab"], time.Now().UTC())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Bookings")
}

func (h *Hostel) card(c *gin.Context) {
	q := valid.Query(c)
	hostel, ok := hostelrooms.HostelOf(c, q["hostelId"])
	if !ok {
		return
	}
	b, err := h.Card(c, hostel, q["card"], time.Now().UTC())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	msg := "No booking on this card"
	if b != nil {
		msg = "This card holds a booking"
	}
	httpx.OK(c, ordered.Map{{Key: "booking", Value: b}}, msg)
}

func (h *Hostel) answer(c *gin.Context) {
	p := authz.From(c)
	var body any
	if b, err := valid.Body(c); err == nil {
		body = b
	}
	action := c.Param("action")
	if action != "confirm" && action != "decline" && action != "cancel" {
		c.Data(http.StatusNotFound, "text/plain;charset=UTF-8", []byte("Not found"))
		return
	}
	now := time.Now().UTC()
	var out ordered.Map
	var err error
	var msg string
	switch action {
	case "confirm":
		out, err = h.Confirm(c, c.Param("id"), p, now)
		msg = "Booking confirmed. The bed is held."
	case "decline":
		f := valid.NewForm(bodyMap(body))
		var reason *string
		if s, ok := f.Str("reason", valid.S{Opt: true, Trim: true, Max: 500}); ok {
			reason = &s
		}
		if err = f.Err(); err == nil {
			out, err = h.Decline(c, c.Param("id"), reason, p, now)
		}
		msg = "Booking declined. The guest is refunded in full."
	default:
		f := valid.NewForm(bodyMap(body))
		reason, _ := f.Str("reason", valid.S{Trim: true, Min: 1, MinMsg: "Say why.", Max: 500})
		if err = f.Err(); err == nil {
			out, err = h.Cancel(c, c.Param("id"), reason, p, now)
		}
		msg = "Booking cancelled. The guest is refunded in full."
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "booking", Value: out}}, msg)
}

// bodyMap is `rawInput ?? {}`: a missing or non-object body reads as empty.
func bodyMap(b any) any {
	if m, ok := b.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}
