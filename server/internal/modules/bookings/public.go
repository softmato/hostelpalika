// Package bookings: so far the public reads — the guide, the refund policy and
// a hostel's Book-button states (booking-guide/-policy.service.ts,
// booking-availability.ts). Booking itself lands with Phases 5 and 8.
package bookings

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/bytedance/sonic"
	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/hostels"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/zschema"
)

const platformName = "HostelPalika" // PLATFORM_NAME

type CancelStep struct {
	RefundPercent float64 `json:"refundPercent"`
	ThroughDay    float64 `json:"throughDay"`
}

// Config is BookingConfig (the `bookings` platformsettings row).
type Config struct {
	Enabled                     bool         `json:"enabled"`
	FeePercent                  float64      `json:"feePercent"`
	HostelSharePercent          float64      `json:"hostelSharePercent"`
	HoldDays                    float64      `json:"holdDays"`
	HostelAnswerHours           float64      `json:"hostelAnswerHours"`
	PaymentCheckHours           float64      `json:"paymentCheckHours"`
	UnpaidWindowHours           float64      `json:"unpaidWindowHours"`
	CancelSteps                 []CancelStep `json:"cancelSteps"`
	NoShowRefundPercent         float64      `json:"noShowRefundPercent"`
	StrikeLimit                 float64      `json:"strikeLimit"`
	StrikeWindowDays            float64      `json:"strikeWindowDays"`
	HostelReminderHoursLeft     []float64    `json:"hostelReminderHoursLeft"`
	MoveInReminderHoursLeft     []float64    `json:"moveInReminderHoursLeft"`
	ShortStayMinMarkupPercent   float64      `json:"shortStayMinMarkupPercent"`
	ShortStayHostelSharePercent float64      `json:"shortStayHostelSharePercent"`
	ShortStayMaxNights          float64      `json:"shortStayMaxNights"`
	ShortStayMaxAdvanceDays     float64      `json:"shortStayMaxAdvanceDays"`
}

type Service struct {
	db  *mongo.Database
	cfg *platformconfig.Service
}

func NewService(db *mongo.Database, cfg *platformconfig.Service) *Service { return &Service{db, cfg} }

// BookingConfig is getBookingConfig: any failure is the shipped defaults.
func (s *Service) BookingConfig(ctx context.Context) Config {
	var c Config
	v, err := s.cfg.Section(ctx, "bookings")
	if err != nil {
		v = platformconfig.Default("bookings")
	}
	if platformconfig.Decode(v, &c) != nil {
		_ = platformconfig.Decode(platformconfig.Default("bookings"), &c)
	}
	return c
}

func jsNum(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

func hoursText(v float64) string {
	if v == 1 {
		return "1 hour"
	}
	return jsNum(v) + " hours"
}

func daysText(v float64) string {
	if v == 1 {
		return "1 day"
	}
	return jsNum(v) + " days"
}

type Section struct {
	Body  []string `json:"body"`
	Icon  string   `json:"icon"`
	Title string   `json:"title"`
}

type Guide struct {
	Enabled  bool      `json:"enabled"`
	Intro    []string  `json:"intro"`
	Sections []Section `json:"sections"`
}

func guideIntro() []string {
	return []string{
		"Booking a room on " + platformName + " holds one bed for you at a real hostel while you get there. This page is the whole process: what you pay, who decides what, and every deadline on the way.",
		"How much money comes back if a booking ends early is set out in the refund policy.",
	}
}

func moveInReminder(c Config) string {
	held := "The bed is held for " + daysText(c.HoldDays) + " from the moment the hostel confirms"
	if len(c.MoveInReminderHoursLeft) == 0 {
		return held + "."
	}
	reminders := append([]float64{}, c.MoveInReminderHoursLeft...)
	for i := range reminders { // descending, as `.sort((a, b) => b - a)`
		for j := i + 1; j < len(reminders); j++ {
			if reminders[j] > reminders[i] {
				reminders[i], reminders[j] = reminders[j], reminders[i]
			}
		}
	}
	parts := make([]string, len(reminders))
	for i, r := range reminders {
		parts[i] = hoursText(r)
	}
	return held + ", and we remind you " + strings.Join(parts, " and ") + " before the hold runs out."
}

func guideSections(c Config) []Section {
	return []Section{
		{Body: []string{
			"You pay a booking fee to " + platformName + ", not to the hostel, and we ask the hostel to hold one bed of that room type for you.",
			"The fee is " + jsNum(c.FeePercent) + "% of one month's rent for that room type. You see the exact amount in rupees before you pay anything.",
			"It is not rent, admission fee or deposit. The hostel charges those in the ordinary way when you move in.",
			"One booking at a time: finish or cancel the one you have before you start another.",
		}, Icon: "bed", Title: "What a booking is"},
		{Body: []string{
			"The hostel has to be live here, taking bookings, and have a free bed of the room type you want. If it does not, the Book button says so instead of taking your money.",
			"You sign in with your own account and it needs an email address: the invoice, the receipt and every step below are emailed to you.",
			"You give the eSewa, Khalti or bank account a refund should go to, and accept the refund policy.",
			"Someone already living at a hostel cannot book a bed at that same hostel.",
		}, Icon: "user-check", Title: "Before you can book"},
		{Body: []string{
			"Pick the room type and book. We raise your invoice straight away and email it to you.",
			"Pay the fee to our collection QR and send the screenshot. A booking with no screenshot closes after " + hoursText(c.UnpaidWindowHours) + ", and it owes nothing and holds nothing.",
			"We check the screenshot within " + hoursText(c.PaymentCheckHours) + " and email you the receipt. If something is wrong with it we say why, and you can send another.",
			"The hostel then has " + hoursText(c.HostelAnswerHours) + " to confirm or decline. We tell you either way.",
			"Once it confirms, one bed is held for you for " + daysText(c.HoldDays) + ", counted in 24-hour blocks from that moment.",
			"Move in inside that window. The hostel scans your " + platformName + " ID card, the held bed becomes yours, and the booking is finished.",
		}, Icon: "receipt", Title: "Step by step"},
		{Body: []string{
			"Send your screenshot within " + hoursText(c.UnpaidWindowHours) + " of booking.",
			"We answer it within " + hoursText(c.PaymentCheckHours) + ".",
			"The hostel answers within " + hoursText(c.HostelAnswerHours) + " of our check. If it never answers, the booking ends and you get the whole fee back.",
			moveInReminder(c),
			"If you have not moved in when the hold ends, the booking ends as a no-show and the bed goes back to the hostel.",
		}, Icon: "alert-triangle", Title: "The deadlines"},
		{Body: []string{
			"Cancel from My bookings whenever you like. The screen shows exactly what comes back before you press anything.",
			"Cancel before the hostel confirms and the whole fee comes back.",
			"After it confirms, what comes back depends on which day of the hold you cancel on. The refund policy lists every step.",
			"Refunds go to the account you gave when you booked. We send them by hand and email you the amount and the transaction ID.",
		}, Icon: "credit-card", Title: "Changing your mind"},
		{Body: []string{
			"The Book button appears on your listing once bookings are switched on, your listing is live and the account we pay you into is verified. Add it under Bookings → Settings; we check it before any payout.",
			"Every request waits for you under Bookings. You have " + hoursText(c.HostelAnswerHours) + " from our payment check to confirm or decline, and we remind you before it runs out.",
			"Confirming holds one bed of that room type for " + daysText(c.HoldDays) + ". Admit the person the normal way, by scanning their ID card in Register a new resident, and the held bed becomes theirs.",
			"Whatever is not refunded is shared: " + jsNum(c.HostelSharePercent) + "% to the hostel, the rest to " + platformName + ". We send your share by hand and email a payout advice with the transaction ID.",
			"Missing an answer, or cancelling a booking you had confirmed, counts as a missed booking. " + jsNum(c.StrikeLimit) + " of them inside " + daysText(c.StrikeWindowDays) + " pauses the Book button on your hostel until we turn it back on.",
			"Declining a request in time costs you nothing.",
		}, Icon: "building", Title: "If you run a hostel"},
	}
}

func (s *Service) Guide(ctx context.Context) Guide {
	c := s.BookingConfig(ctx)
	return Guide{Enabled: c.Enabled, Intro: guideIntro(), Sections: guideSections(c)}
}

func policyValues(c Config) map[string]string {
	return map[string]string{
		"feePercent":          jsNum(c.FeePercent) + "%",
		"holdDays":            daysText(c.HoldDays),
		"hostelAnswerHours":   hoursText(c.HostelAnswerHours),
		"noShowRefundPercent": jsNum(c.NoShowRefundPercent) + "%",
		"paymentCheckHours":   hoursText(c.PaymentCheckHours),
		"siteName":            platformName,
		"unpaidWindowHours":   hoursText(c.UnpaidWindowHours),
	}
}

// fillPolicyText replaces {name} tokens it knows and leaves the rest (`/\{(\w+)\}/g`).
func fillPolicyText(text string, values map[string]string) string {
	var b strings.Builder
	for i := 0; i < len(text); {
		if text[i] == '{' {
			j := i + 1
			for j < len(text) && isWord(text[j]) {
				j++
			}
			if j > i+1 && j < len(text) && text[j] == '}' {
				if v, ok := values[text[i+1:j]]; ok {
					b.WriteString(v)
				} else {
					b.WriteString(text[i : j+1])
				}
				i = j + 1
				continue
			}
		}
		b.WriteByte(text[i])
		i++
	}
	return b.String()
}

func isWord(c byte) bool {
	return c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

func policySections(c Config) []Section {
	from := 1.0
	var steps []string
	for _, st := range c.CancelSteps {
		span := "days " + jsNum(from) + "–" + jsNum(st.ThroughDay)
		if from == st.ThroughDay {
			span = "day " + jsNum(from)
		}
		from = st.ThroughDay + 1
		steps = append(steps, "Cancel on "+span+" of the hold: "+jsNum(st.RefundPercent)+"% back.")
	}
	after := append([]string{"One bed is held for you for " + daysText(c.HoldDays) + ", counted in 24-hour blocks from the moment the hostel confirms."}, steps...)
	after = append(after, "Not moved in when the hold ends: "+jsNum(c.NoShowRefundPercent)+"% back.",
		"When the hostel scans your ID card and admits you, the booking is complete and nothing is refunded.")
	return []Section{
		{Body: []string{
			"The booking fee is " + jsNum(c.FeePercent) + "% of one month's rent for the room type, shown before you book.",
			"You pay it to " + platformName + ", not to the hostel. It does not count towards rent, admission fee or deposit.",
			"We check your payment screenshot within " + hoursText(c.PaymentCheckHours) + ". A booking with no screenshot closes after " + hoursText(c.UnpaidWindowHours) + " and owes nothing.",
		}, Icon: "credit-card", Title: "The booking fee"},
		{Body: []string{
			"You cancel before the hostel confirms.",
			"The hostel declines, or does not answer within " + hoursText(c.HostelAnswerHours) + " of our payment check.",
			"The hostel cancels after confirming.",
			platformName + " cancels the booking.",
		}, Icon: "badge-check", Title: "Full refund"},
		{Body: after, Icon: "alert-triangle", Title: "After the hostel confirms"},
		{Body: []string{
			"A short stay is a few nights, paid upfront with the booking fee. The fee is charged once for every started week between booking and move-in.",
			"Cancelled before the move-in day, declined, or not answered by the hostel: every night is refunded.",
			"Cancelled on the move-in day, or not checked in by the end of the next day: one night is kept and the rest refunded.",
			"Leaving before the move-out date: nights not stayed are not refunded.",
		}, Icon: "calendar", Title: "Short stays"},
		{Body: []string{
			"Refunds go to the eSewa, Khalti or bank account you give when you book.",
			"When we send a refund, we email you the amount and the transaction ID.",
			"Whatever is not refunded is shared between the hostel and " + platformName + ".",
		}, Icon: "shield-check", Title: "How refunds are sent"},
	}
}

type shortStay struct {
	HostelSharePercent float64 `json:"hostelSharePercent"`
	MaxAdvanceDays     float64 `json:"maxAdvanceDays"`
	MaxNights          float64 `json:"maxNights"`
	MinMarkupPercent   float64 `json:"minMarkupPercent"`
}

type Policy struct {
	CustomBody *string   `json:"customBody"`
	Intro      []string  `json:"intro"`
	Sections   []Section `json:"sections"`
	ShortStay  shortStay `json:"shortStay"`
	UpdatedAt  string    `json:"updatedAt"`
	Version    string    `json:"version"`
}

// PolicyVersion is bookingPolicyVersion: what the checkout sends back, so a
// screen can tell the policy moved.
func PolicyVersion(c Config, body, updatedAt string) string {
	bodyHash := sha256.Sum256([]byte(body))
	steps := make([][2]float64, len(c.CancelSteps))
	for i, s := range c.CancelSteps {
		steps[i] = [2]float64{s.ThroughDay, s.RefundPercent}
	}
	material, _ := sonic.ConfigDefault.Marshal(ordered.Map{
		{Key: "body", Value: hex.EncodeToString(bodyHash[:])},
		{Key: "cancelSteps", Value: steps},
		{Key: "feePercent", Value: c.FeePercent},
		{Key: "holdDays", Value: c.HoldDays},
		{Key: "hostelAnswerHours", Value: c.HostelAnswerHours},
		{Key: "noShowRefundPercent", Value: c.NoShowRefundPercent},
		{Key: "updatedAt", Value: updatedAt},
	})
	sum := sha256.Sum256(material)
	return hex.EncodeToString(sum[:])[:16]
}

func (s *Service) RefundPolicy(ctx context.Context) (*Policy, error) {
	c := s.BookingConfig(ctx)
	legalRaw, err := s.cfg.Section(ctx, "legal")
	if err != nil {
		return nil, err
	}
	var legal struct {
		Refund struct {
			Body      string `json:"body"`
			UpdatedAt string `json:"updatedAt"`
		} `json:"refund"`
	}
	if err := platformconfig.Decode(legalRaw, &legal); err != nil {
		return nil, err
	}
	p := &Policy{
		Intro:    []string{"This policy covers rooms booked on " + platformName + ". A booking keeps the terms in force on the day it is made, and its invoice prints them."},
		Sections: policySections(c),
		ShortStay: shortStay{HostelSharePercent: c.ShortStayHostelSharePercent, MaxAdvanceDays: c.ShortStayMaxAdvanceDays,
			MaxNights: c.ShortStayMaxNights, MinMarkupPercent: c.ShortStayMinMarkupPercent},
		UpdatedAt: legal.Refund.UpdatedAt,
		Version:   PolicyVersion(c, legal.Refund.Body, legal.Refund.UpdatedAt),
	}
	if body := zschema.JSTrim(legal.Refund.Body); body != "" {
		filled := fillPolicyText(body, policyValues(c))
		p.CustomBody = &filled
	}
	return p, nil
}

// bookableHostel is the projection loadBookableHostel reads.
type bookableHostel struct {
	ID           bson.ObjectID `bson:"_id"`
	BookingPause *struct {
		PausedAt *time.Time `bson:"pausedAt"`
	} `bson:"bookingPause"`
	IsDeleted bool `bson:"isDeleted"`
	Photos    []struct {
		Kind     string `bson:"kind"`
		RoomType string `bson:"roomType"`
		URL      string `bson:"url"`
	} `bson:"photos"`
	RoomConfigurations []struct {
		RoomType   string   `bson:"roomType"`
		VacantBeds *float64 `bson:"vacantBeds"`
	} `bson:"roomConfigurations"`
	Status             string            `bson:"status"`
	Suspension         *authz.Suspension `bson:"suspension"`
	VerificationStatus string            `bson:"verificationStatus"`
}

func (s *Service) loadBookable(ctx context.Context, ref string) (*bookableHostel, error) {
	filter := bson.D{{Key: "slug", Value: ref}}
	if id, err := bson.ObjectIDFromHex(ref); err == nil {
		filter = bson.D{{Key: "_id", Value: id}}
	}
	var h bookableHostel
	err := s.db.Collection("hostels").FindOne(ctx, filter, options.FindOne().SetProjection(bson.D{
		{Key: "bookingPause", Value: 1}, {Key: "contact", Value: 1}, {Key: "hostelType", Value: 1}, {Key: "isDeleted", Value: 1},
		{Key: "location", Value: 1}, {Key: "name", Value: 1}, {Key: "photos", Value: 1}, {Key: "roomConfigurations", Value: 1},
		{Key: "shortStays", Value: 1}, {Key: "slug", Value: 1}, {Key: "status", Value: 1}, {Key: "suspension", Value: 1},
		{Key: "verificationStatus", Value: 1},
	})).Decode(&h)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return &h, err
}

// hostelReason is hostelUnavailableReason: the hostel-wide refusal, before any room.
func (s *Service) hostelReason(ctx context.Context, h *bookableHostel, c Config, now time.Time) (*string, error) {
	reason := func(r string) (*string, error) { return &r, nil }
	switch {
	case !c.Enabled:
		return reason("BOOKINGS_OFF")
	case h.IsDeleted || h.Status != "PUBLISHED" || h.VerificationStatus != "VERIFIED":
		return reason("HOSTEL_NOT_LIVE")
	case h.Suspension.Stage(now) != "":
		return reason("HOSTEL_SUSPENDED")
	case h.BookingPause != nil && h.BookingPause.PausedAt != nil:
		return reason("BOOKINGS_PAUSED")
	}
	n, err := s.db.Collection("hostelpayoutaccounts").CountDocuments(ctx, bson.D{{Key: "hostelId", Value: h.ID}, {Key: "status", Value: "VERIFIED"}}, options.Count().SetLimit(1))
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return reason("NO_PAYOUT_ACCOUNT")
	}
	return nil, nil
}

type room struct {
	Bookable bool     `json:"bookable"`
	Fee      *int64   `json:"fee"`
	Photos   []string `json:"photos"`
	Reason   *string  `json:"reason"`
	RoomType string   `json:"roomType"`
}

type availability struct {
	HostelReason *string `json:"hostelReason"`
	Rooms        []room  `json:"rooms"`
}

// bookingFee is a room's fee: never under one rupee.
func bookingFee(rent, feePercent float64) (int64, error) {
	if rent != math.Trunc(rent) || math.Abs(rent) > 1<<53-1 {
		return 0, fmt.Errorf("monthly rent must be whole rupees, got %v", rent)
	}
	r, err := money.RoundToRupee(rent * feePercent / 100)
	return max(1, r), err
}

// Availability is the route's projection of hostelAvailability.
func (s *Service) Availability(ctx context.Context, ref string) (*availability, error) {
	if hostels.IsDemoRef(ref) {
		r := "BOOKINGS_PAUSED"
		return &availability{HostelReason: &r, Rooms: []room{}}, nil
	}
	var h *bookableHostel
	if ref != "" {
		var err error
		if h, err = s.loadBookable(ctx, ref); err != nil {
			return nil, err
		}
	}
	if h == nil || h.IsDeleted {
		r := "HOSTEL_NOT_LIVE"
		return &availability{HostelReason: &r, Rooms: []room{}}, nil
	}
	now := time.Now()
	c := s.BookingConfig(ctx)
	hostelReason, err := s.hostelReason(ctx, h, c, now)
	if err != nil {
		return nil, err
	}
	period, err := bs.PeriodOf(now)
	if err != nil {
		return nil, err
	}
	schedule, err := finance.EffectiveSchedule(ctx, s.db, h.ID, period)
	if err != nil {
		return nil, err
	}
	out := &availability{HostelReason: hostelReason, Rooms: []room{}}
	for _, rc := range h.RoomConfigurations {
		var rent *float64
		if r := finance.RateForRoomType(schedule, rc.RoomType); r != nil {
			rent = r.MonthlyAmount
		}
		vacant := 0.0
		if rc.VacantBeds != nil {
			vacant = math.Max(0, *rc.VacantBeds)
		}
		priced := rent != nil && *rent > 0
		reason := hostelReason
		if reason == nil {
			if !priced {
				r := "NOT_PRICED"
				reason = &r
			} else if vacant <= 0 {
				r := "FULL"
				reason = &r
			}
		}
		rm := room{Bookable: reason == nil, Photos: []string{}, Reason: reason, RoomType: rc.RoomType}
		if priced {
			fee, err := bookingFee(*rent, c.FeePercent)
			if err != nil {
				return nil, err
			}
			rm.Fee = &fee
		}
		for _, p := range h.Photos {
			kind := p.Kind
			if kind != "EXTERIOR" && kind != "ROOM" {
				kind = "INTERIOR"
			}
			if p.URL != "" && kind == "ROOM" && (rc.RoomType == "" || p.RoomType == rc.RoomType) && len(rm.Photos) < 6 {
				rm.Photos = append(rm.Photos, p.URL)
			}
		}
		out.Rooms = append(out.Rooms, rm)
	}
	return out, nil
}

type Handler struct{ svc *Service }

func NewHandler(svc *Service) *Handler { return &Handler{svc} }

func (h *Handler) Register(v1 *gin.RouterGroup) {
	b := v1.Group("/bookings")
	b.GET("/guide", h.guide)
	b.GET("/policy", h.policy)
	b.GET("/availability", httpx.ETag(), h.availability)
}

func (h *Handler) guide(c *gin.Context) {
	httpx.OK(c, gin.H{"guide": h.svc.Guide(c)}, "How booking works")
}

func (h *Handler) policy(c *gin.Context) {
	p, err := h.svc.RefundPolicy(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"policy": p}, "Refund policy")
}

func (h *Handler) availability(c *gin.Context) {
	a, err := h.svc.Availability(c, c.Query("hostel"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"availability": a}, "Booking availability")
}
