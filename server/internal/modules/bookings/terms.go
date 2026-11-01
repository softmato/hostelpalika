package bookings

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
)

// booking-terms.ts + short-stay.ts: the money of a booking. Pure.

const (
	hourMs = time.Hour
	dayMs  = 24 * time.Hour
)

// Terms is what a booking was sold under, frozen on the row.
type Terms struct {
	CancelSteps         []CancelStep `bson:"cancelSteps"`
	FeePercent          float64      `bson:"feePercent"`
	HoldDays            float64      `bson:"holdDays"`
	HostelAnswerHours   float64      `bson:"hostelAnswerHours"`
	HostelSharePercent  float64      `bson:"hostelSharePercent"`
	NoShowRefundPercent float64      `bson:"noShowRefundPercent"`
}

func termsFromConfig(c Config) Terms {
	return Terms{CancelSteps: c.CancelSteps, FeePercent: c.FeePercent, HoldDays: c.HoldDays, HostelAnswerHours: c.HostelAnswerHours,
		HostelSharePercent: c.HostelSharePercent, NoShowRefundPercent: c.NoShowRefundPercent}
}

// rupee is roundToRupee; panics where TS throws, which the recover turns into the same 500.
func rupee(v float64) int64 {
	r, err := money.RoundToRupee(v)
	if err != nil {
		panic(err)
	}
	return r
}

// Stay is BookingStay: a short stay's nights, frozen on the row. Dates are Nepal days at UTC midnight.
type Stay struct {
	Amount             int64     `bson:"amount"`
	DailyRate          int64     `bson:"dailyRate"`
	HoldBlocks         int64     `bson:"holdBlocks"`
	HostelSharePercent float64   `bson:"hostelSharePercent"`
	MoveIn             time.Time `bson:"moveIn"`
	MoveOut            time.Time `bson:"moveOut"`
	Nights             int64     `bson:"nights"`
}

// Settlement is BookingSettlement.
type Settlement struct {
	HostelShare, Kept, PlatformShare, Refund int64
	RefundPercent                            float64
	StayKept, StayRefund                     *int64
}

// jsInt is how the JS driver stores a whole number: int32 when it fits, else a
// double. An int64 would land as NumberLong, a type no TS writer produces.
func jsInt(v int64) any {
	if v >= math.MinInt32 && v <= math.MaxInt32 {
		return int32(v)
	}
	return float64(v)
}

// doc keeps the key order settleBooking builds it in.
func (s Settlement) doc() bson.D {
	d := bson.D{{Key: "kept", Value: jsInt(s.Kept)}, {Key: "refund", Value: jsInt(s.Refund)}, {Key: "refundPercent", Value: s.RefundPercent},
		{Key: "hostelShare", Value: jsInt(s.HostelShare)}, {Key: "platformShare", Value: jsInt(s.PlatformShare)}}
	if s.StayKept != nil {
		return bson.D{{Key: "hostelShare", Value: jsInt(s.HostelShare)}, {Key: "kept", Value: jsInt(s.Kept)}, {Key: "platformShare", Value: jsInt(s.PlatformShare)}, {Key: "refund", Value: jsInt(s.Refund)},
			{Key: "refundPercent", Value: s.RefundPercent}, {Key: "stayKept", Value: jsInt(*s.StayKept)}, {Key: "stayRefund", Value: jsInt(*s.StayRefund)}}
	}
	return d
}

func splitKept(kept int64, sharePercent float64) (hostel, platform int64) {
	hostel = rupee(float64(kept) * sharePercent / 100)
	return hostel, kept - hostel
}

func settlementFor(fee int64, refundPercent, sharePercent float64) Settlement {
	refund := rupee(float64(fee) * refundPercent / 100)
	kept := fee - refund
	hostel, platform := splitKept(kept, sharePercent)
	return Settlement{HostelShare: hostel, Kept: kept, PlatformShare: platform, Refund: refund, RefundPercent: refundPercent}
}

func holdDayAt(confirmedAt, at time.Time) float64 {
	elapsed := at.Sub(confirmedAt)
	if elapsed < 0 {
		return 1
	}
	return math.Floor(float64(elapsed.Milliseconds())/float64(dayMs.Milliseconds())) + 1
}

func cancelRefundPercent(t Terms, confirmedAt, at time.Time) float64 {
	day := holdDayAt(confirmedAt, at)
	for _, s := range t.CancelSteps {
		if day <= s.ThroughDay {
			return s.RefundPercent
		}
	}
	return t.NoShowRefundPercent
}

// stayRefund is stayRefund: what of the nights goes back.
func stayRefund(s *Stay, ending string, at time.Time) int64 {
	oneNight := min(s.DailyRate, s.Amount)
	switch {
	case ending == "CHECKED_IN":
		return 0
	case ending == "NO_SHOW":
		return s.Amount - oneNight
	case ending == "CANCELLED_BY_USER" && !bs.Today(at).Before(bs.CalendarDay(s.MoveIn)):
		return s.Amount - oneNight
	}
	return s.Amount
}

func settleFee(at time.Time, confirmedAt *time.Time, ending string, fee int64, t Terms) Settlement {
	switch ending {
	case "CANCELLED_BEFORE_CONFIRMATION", "DECLINED", "HOSTEL_NO_RESPONSE", "CANCELLED_BY_HOSTEL", "CANCELLED_BY_PLATFORM":
		return settlementFor(fee, 100, t.HostelSharePercent)
	case "CHECKED_IN":
		return settlementFor(fee, 0, t.HostelSharePercent)
	case "NO_SHOW":
		return settlementFor(fee, t.NoShowRefundPercent, t.HostelSharePercent)
	}
	if confirmedAt == nil {
		panic(httpx.NewError(409, "BOOKING_STATE_INVALID", "A confirmed booking has no confirmation time, so its refund cannot be worked out.", nil))
	}
	return settlementFor(fee, cancelRefundPercent(t, *confirmedAt, at), t.HostelSharePercent)
}

func settleBooking(at time.Time, confirmedAt *time.Time, ending string, fee int64, stay *Stay, t Terms) Settlement {
	f := settleFee(at, confirmedAt, ending, fee, t)
	if stay == nil {
		return f
	}
	refund := stayRefund(stay, ending, at)
	kept := stay.Amount - refund
	hostel, platform := splitKept(kept, stay.HostelSharePercent)
	return Settlement{HostelShare: f.HostelShare + hostel, Kept: f.Kept + kept, PlatformShare: f.PlatformShare + platform, Refund: f.Refund + refund,
		RefundPercent: f.RefundPercent, StayKept: &kept, StayRefund: &refund}
}

// PolicyRow is PolicyRow.
type PolicyRow struct {
	FromDay       float64 `json:"fromDay"`
	Refund        int64   `json:"refund"`
	RefundPercent float64 `json:"refundPercent"`
	ThroughDay    float64 `json:"throughDay"`
}

func policyRows(t Terms, fee int64) []PolicyRow {
	from := 1.0
	rows := make([]PolicyRow, len(t.CancelSteps))
	for i, s := range t.CancelSteps {
		rows[i] = PolicyRow{from, settlementFor(fee, s.RefundPercent, t.HostelSharePercent).Refund, s.RefundPercent, s.ThroughDay}
		from = s.ThroughDay + 1
	}
	return rows
}

// PolicySummary is policySummary.
type PolicySummary struct {
	HoldDays            float64     `json:"holdDays"`
	HostelAnswerHours   float64     `json:"hostelAnswerHours"`
	NoShowRefund        int64       `json:"noShowRefund"`
	NoShowRefundPercent float64     `json:"noShowRefundPercent"`
	Rows                []PolicyRow `json:"rows"`
}

func policySummary(t Terms, fee int64) PolicySummary {
	return PolicySummary{t.HoldDays, t.HostelAnswerHours, settlementFor(fee, t.NoShowRefundPercent, t.HostelSharePercent).Refund, t.NoShowRefundPercent, policyRows(t, fee)}
}

func millis(f float64) time.Duration { return time.Duration(f * float64(time.Millisecond)) }

func addDays(t time.Time, days float64) time.Time {
	return t.Add(millis(days * float64(dayMs.Milliseconds())))
}

var dayShape = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})$`)

// parseDay is `new Date(value + "T00:00:00.000Z")` behind the date regex. V8 rolls
// an impossible day over (Feb 30 is Mar 2) and refuses only day 32 and month 13.
func parseDay(value string) *time.Time {
	m := dayShape.FindStringSubmatch(value)
	if m == nil {
		return nil
	}
	y, _ := strconv.Atoi(m[1])
	mo, _ := strconv.Atoi(m[2])
	d, _ := strconv.Atoi(m[3])
	if mo < 1 || mo > 12 || d > 31 || d < 1 {
		return nil
	}
	t := time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.UTC)
	return &t
}

func quoteStay(dailyRate int64, holdDays, sharePercent, maxAdvanceDays, maxNights, minNights float64, moveInRaw, moveOutRaw string, now time.Time) (*Stay, error) {
	moveIn, moveOut := parseDay(moveInRaw), parseDay(moveOutRaw)
	today := bs.Today(now)
	if moveIn == nil || moveOut == nil || !moveOut.After(*moveIn) {
		return nil, httpx.NewError(422, "SHORT_STAY_DATES_INVALID", "Pick a move-in date and a later move-out date.", nil)
	}
	if moveIn.Before(today) || moveIn.After(addDays(today, maxAdvanceDays)) {
		return nil, httpx.NewError(422, "SHORT_STAY_DATES_INVALID", "Pick a move-in date between today and "+jsNum(maxAdvanceDays)+" days from now.", nil)
	}
	nights := int64(moveOut.Sub(*moveIn) / dayMs)
	if float64(nights) < minNights {
		return nil, httpx.NewError(422, "SHORT_STAY_TOO_SHORT", "This hostel takes stays of at least "+jsNum(minNights)+" nights.", nil)
	}
	if float64(nights) > maxNights {
		return nil, httpx.NewError(422, "SHORT_STAY_TOO_LONG", "A short stay is at most "+jsNum(maxNights)+" nights. Book monthly for longer.", nil)
	}
	blocks := int64(max(1, math.Ceil(max(0, float64(bs.DaysBetween(today, *moveIn)))/holdDays)))
	return &Stay{Amount: nights * dailyRate, DailyRate: dailyRate, HoldBlocks: blocks, HostelSharePercent: sharePercent, MoveIn: *moveIn, MoveOut: *moveOut, Nights: nights}, nil
}

var enGBMonths = []string{"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"}

// enGBDay is en-GB `{day:"numeric", month:"short", year:"numeric"}`, which says "Sept".
func enGBDay(t time.Time) string {
	return strconv.Itoa(t.Day()) + " " + enGBMonths[t.Month()-1] + " " + strconv.Itoa(t.Year())
}

// stayDatesText is stayDatesText: AD first, the hostel's BS days beside it.
func stayDatesText(s *Stay) string {
	text := enGBDay(s.MoveIn.UTC()) + " – " + enGBDay(s.MoveOut.UTC())
	if r, _ := bs.FormatDayRange(s.MoveIn, s.MoveOut); r != "" {
		text += " (" + r + ")"
	}
	return text
}

var payoutLabels = map[string]string{"BANK": "Bank account", "ESEWA": "eSewa", "KHALTI": "Khalti"}

// normalizePayoutNumber is normalizePayoutNumber: `/[\s-]/g` dropped, upper-cased.
func normalizePayoutNumber(v string) string {
	return strings.ToUpper(strings.Map(func(r rune) rune {
		if r == '-' || jsSpace(r) {
			return -1
		}
		return r
	}, v))
}

func jsSpace(r rune) bool {
	switch r {
	case ' ', '\t', '\n', '\v', '\f', '\r', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

var (
	walletNumber = regexp.MustCompile(`^9[678]\d{8}$`)
	bankNumber   = regexp.MustCompile(`^[A-Z0-9]{6,24}$`)
)
