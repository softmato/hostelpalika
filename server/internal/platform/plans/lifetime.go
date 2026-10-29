package plans

import (
	"fmt"
	"regexp"
	"strconv"
	"time"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
)

type Offer struct {
	PlanID string `json:"planId"`
	Price  int64  `json:"price"` // whole rupees, paid once
	Seats  int    `json:"seats"`
}

// Lifetime is the `lifetime` site-config section.
type Lifetime struct {
	Badge    string  `json:"badge"`
	CtaLabel string  `json:"ctaLabel"`
	Enabled  bool    `json:"enabled"`
	EndsOn   string  `json:"endsOn"` // Nepal day YYYY-MM-DD, inclusive; blank = no end
	Note     string  `json:"note"`
	Offers   []Offer `json:"offers"`
	StartsOn string  `json:"startsOn"` // Nepal day, inclusive; blank = from now
	Subtitle string  `json:"subtitle"`
	Title    string  `json:"title"`
}

// LifetimeWindow is "off" | "upcoming" | "open" | "ended".
func LifetimeWindow(d Lifetime, now time.Time) string {
	if !d.Enabled {
		return "off"
	}
	today := bs.NepalDayKey(now)
	if d.StartsOn != "" && today < d.StartsOn {
		return "upcoming"
	}
	if d.EndsOn != "" && today > d.EndsOn {
		return "ended"
	}
	return "open"
}

// LifetimeOfferFor is the priced offer on this tier, or nil.
func LifetimeOfferFor(d Lifetime, planID string) *Offer {
	for _, o := range d.Offers {
		if o.PlanID == planID && o.Price > 0 {
			return &o
		}
	}
	return nil
}

func LifetimeSeatsLeft(seats, sold int) int { return max(0, seats-max(0, sold)) }

func LifetimeTotalSeats(d Lifetime) int {
	total := 0
	for _, o := range d.Offers {
		if o.Price > 0 {
			total += o.Seats
		}
	}
	return total
}

// LifetimeMonthsEquivalent is price in months of the monthly price, to one decimal;
// ok is false when either is not positive.
func LifetimeMonthsEquivalent(price, monthly float64) (float64, bool) {
	if !(monthly > 0) || !(price > 0) {
		return 0, false
	}
	return jsRound(price/monthly*10) / 10, true
}

// LifetimeEndsAt is the end of endsOn in Kathmandu, in epoch ms.
func LifetimeEndsAt(endsOn string) (int64, bool) {
	day, err := time.Parse("2006-01-02", endsOn)
	if err != nil {
		return 0, false
	}
	return day.UnixMilli() + 24*60*60*1000 - bs.OffsetMinutes*60*1000, true
}

var dayPattern = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})$`)

var shortMonths = [12]string{"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"}

// FormatLifetimeDay is "7 Nov 2026" from "2026-11-07".
func FormatLifetimeDay(day string) string {
	match := dayPattern.FindStringSubmatch(day)
	if match == nil {
		return ""
	}
	month, _ := strconv.Atoi(match[2])
	d, _ := strconv.Atoi(match[3])
	if month < 1 || month > 12 {
		return ""
	}
	return fmt.Sprintf("%d %s %s", d, shortMonths[month-1], match[1])
}
