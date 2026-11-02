package finance

import (
	"encoding/json"
	"math"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
)

// Billable is BillableResident (fee-schedule.service.ts).
type Billable struct {
	ID           bson.ObjectID `bson:"_id"`
	BedType      *string       `bson:"bedType"`
	BillingCycle *string       `bson:"billingCycle"`
	MonthlyFee   *float64      `bson:"monthlyFee"`
	MoveInDate   *time.Time    `bson:"moveInDate"`
	MoveOutDate  *time.Time    `bson:"moveOutDate"`
	RoomType     *string       `bson:"roomType"`
}

// Charge is ResolvedCharge.
type Charge struct {
	Amount, FullAmount int64
	Basis              string // OVERRIDE | SCHEDULE | MANUAL
	BedType            string
	ConcessionPercent  int64
	FeeScheduleID      *bson.ObjectID
}

// ListedRates is listedRoomRates: the public listing's rent per room type.
func ListedRates(configs []bson.D) map[string]float64 {
	out := map[string]float64{}
	for _, c := range configs {
		var rt string
		var rent float64
		var has bool
		for _, e := range c {
			switch e.Key {
			case "roomType":
				rt, _ = e.Value.(string)
			case "monthlyRent":
				switch n := e.Value.(type) {
				case int32:
					rent, has = float64(n), true
				case int64:
					rent, has = float64(n), true
				case float64:
					rent, has = n, true
				}
			}
		}
		if rt != "" && has && rent > 0 {
			out[rt] = rent
		}
	}
	return out
}

func strOf(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// assertRupees is assertWholeRupees: a fraction or overflow is a fault, not a price.
func assertRupees(v float64) (int64, error) {
	if v != math.Trunc(v) || math.Abs(v) > 9007199254740991 {
		return 0, Err("AMOUNT_OUT_OF_BOUNDS", "Amount must be a whole number of rupees.")
	}
	return int64(v), nil
}

// MonthlyCharge is resolveMonthlyCharge: the resident's own fee, then the rate
// card, then the listing's rent, less the month's discount.
func MonthlyCharge(r *Billable, s *Schedule, listed map[string]float64, percentOff int64) (Charge, error) {
	bed := strOf(r.BedType)
	if bed == "" {
		bed = NormalizeBedType(strOf(r.RoomType))
	}
	var ch Charge
	switch rate := RateForRoomTypeBed(s, strOf(r.RoomType), bed); {
	case r.MonthlyFee != nil:
		amt, err := assertRupees(*r.MonthlyFee)
		if err != nil {
			return ch, err
		}
		ch = Charge{Amount: amt, FullAmount: amt, Basis: "OVERRIDE", BedType: bed}
	case rate != nil && rate.MonthlyAmount != nil:
		amt, err := assertRupees(*rate.MonthlyAmount)
		if err != nil {
			return ch, err
		}
		id := s.ID
		ch = Charge{Amount: amt, FullAmount: amt, Basis: "SCHEDULE", BedType: bed, FeeScheduleID: &id}
	default:
		if listed, ok := listed[strOf(r.RoomType)]; ok && strOf(r.RoomType) != "" {
			amt, err := assertRupees(listed)
			if err != nil {
				return ch, err
			}
			ch = Charge{Amount: amt, FullAmount: amt, Basis: "MANUAL", BedType: bed}
			break
		}
		if s == nil {
			return ch, Err("FEE_SCHEDULE_MISSING", "No fee schedule covers this period, and this room type has no listed rent.")
		}
		name := "null"
		if r.RoomType != nil {
			b, _ := json.Marshal(*r.RoomType)
			name = string(b)
		}
		return ch, Err("BED_TYPE_NOT_PRICED", "The rate card has no rate for room type "+name+", and it has no listed rent.")
	}
	if percentOff > 0 {
		ch.Amount = ch.Amount - (ch.Amount*percentOff)/100
		ch.ConcessionPercent = percentOff
	}
	return ch, nil
}

// RateForRoomTypeBed is rateForRoomType with the resident's own bed type.
func RateForRoomTypeBed(s *Schedule, roomType, bedType string) *Rate {
	if s == nil {
		return nil
	}
	for i := range s.Rates {
		if s.Rates[i].RoomType != nil && SameRoomType(*s.Rates[i].RoomType, roomType) {
			return &s.Rates[i]
		}
	}
	if bedType == "" {
		bedType = NormalizeBedType(roomType)
	}
	if bedType == "" {
		return nil
	}
	for i := range s.Rates {
		if strOf(s.Rates[i].RoomType) == "" && strOf(s.Rates[i].BedType) == bedType {
			return &s.Rates[i]
		}
	}
	return nil
}

// BillDay is billDayOf: the move-in BS day for a SAME_DAY cycle, else 0.
func BillDay(r *Billable) int {
	if strOf(r.BillingCycle) != "SAME_DAY" || r.MoveInDate == nil {
		return 0
	}
	d, _ := bs.DayOfMonth(*r.MoveInDate)
	return d
}

// ResidentBounds is residentPeriodBounds.
func ResidentBounds(r *Billable, period string) (bs.Bounds, error) {
	if day := BillDay(r); day > 0 {
		return bs.CycleBounds(period, day)
	}
	b, err := bs.PeriodBounds(period)
	if err != nil {
		return b, Err("FEE_SCHEDULE_MISSING", err.Error())
	}
	return b, nil
}

// NotYetDue is notYetDue: a SAME_DAY cycle that has not reached its bill day.
func NotYetDue(r *Billable, b bs.Bounds, today time.Time) bool {
	return BillDay(r) > 0 && r.MoveInDate != nil && b.Start.After(today) && b.Start.After(bs.CalendarDay(*r.MoveInDate))
}

// InvoiceAmount is computeInvoiceAmount's result.
type InvoiceAmount struct {
	Amount      int64
	Days        int
	Proration   *string
	NotResident bool // "not yet resident"
	MovedOut    bool // "already moved out"
}

// ComputeInvoiceAmount is computeInvoiceAmount: the month's rent prorated to the
// days the resident lives there inside b.
func ComputeInvoiceAmount(monthly int64, moveIn, moveOut *time.Time, b bs.Bounds) (InvoiceAmount, error) {
	label := func(s string) *string { return &s }
	if moveIn != nil && moveIn.After(b.End) {
		return InvoiceAmount{Proration: label("not yet resident"), NotResident: true}, nil
	}
	if moveOut != nil && moveOut.Before(b.Start) {
		return InvoiceAmount{Proration: label("already moved out"), MovedOut: true}, nil
	}
	start, end := b.Start, b.LastDay
	if moveIn != nil && moveIn.After(start) {
		start = *moveIn
	}
	if moveOut != nil && moveOut.Before(b.End) {
		end = *moveOut
	}
	if end.Before(start) {
		return InvoiceAmount{Proration: label("no billable days")}, nil
	}
	day := func(t time.Time) int64 {
		return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC).UnixMilli()
	}
	days := int((day(end)-day(start))/(24*60*60*1000)) + 1
	amount, err := money.Prorate(monthly, days, b.DaysInMonth)
	if err != nil {
		return InvoiceAmount{}, err
	}
	if days >= b.DaysInMonth {
		return InvoiceAmount{Amount: amount, Days: days}, nil
	}
	fraction := strconv.Itoa(days) + " of " + strconv.Itoa(b.DaysInMonth) + " days"
	if span, err := bs.FormatDayRange(start, end); err == nil && span != "" {
		fraction = span + " · " + fraction
	}
	return InvoiceAmount{Amount: amount, Days: days, Proration: &fraction}, nil
}

// PaidBeforeJoining is paidBeforeJoining: a month the resident settled before the
// hostel joined the platform.
func PaidBeforeJoining(paidTill *string, period string) bool {
	return paidTill != nil && *paidTill != "" && period <= *paidTill
}

// ResidentPeriodOf is residentPeriodOf: the period the date falls in on this
// resident's cycle (their bill day, else the calendar BS month).
func ResidentPeriodOf(r *Billable, t time.Time) (string, error) {
	if d := BillDay(r); d > 0 {
		return bs.CyclePeriodOf(t, d)
	}
	return bs.PeriodOf(t)
}
