package finance

import (
	"time"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
)

// MonthlyAmount is computeInvoiceAmount's amount for a resident who moves in on
// moveIn (nil = before the month) and never leaves: the part of the period's
// rent the days from move-in to the month's last day come to. The proration
// label is not needed by any caller yet.
func MonthlyAmount(monthly int64, moveIn *time.Time, period string) (int64, error) {
	b, err := bs.PeriodBounds(period)
	if err != nil {
		return 0, err
	}
	if moveIn != nil && moveIn.After(b.End) {
		return 0, nil
	}
	start := b.Start
	if moveIn != nil && moveIn.After(start) {
		start = *moveIn
	}
	if b.LastDay.Before(start) {
		return 0, nil
	}
	day := func(t time.Time) int64 {
		return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC).UnixMilli()
	}
	days := int((day(b.LastDay)-day(start))/(24*60*60*1000)) + 1
	return money.Prorate(monthly, days, b.DaysInMonth)
}
