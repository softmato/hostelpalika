package bs

import (
	"fmt"
	"strconv"
	"time"
)

var (
	documentZone = time.FixedZone("NPT", 345*60)
	enGBMonths   = []string{"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"}
)

// EnGBDay is toLocaleDateString("en-GB", { day, month: "short", year }) for the date t already holds.
func EnGBDay(t time.Time) string {
	return strconv.Itoa(t.Day()) + " " + enGBMonths[t.Month()-1] + " " + strconv.Itoa(t.Year())
}

// DocumentBsDate is documentBsDate: `2 Bhadra 2083 BS`, empty when it cannot be named.
func DocumentBsDate(t time.Time) string {
	d, err := ToBs(t)
	if err != nil {
		return ""
	}
	month := MonthName(d.Month)
	if month == "" {
		return ""
	}
	return fmt.Sprintf("%d %s %d BS", d.Day, month, d.Year)
}

// DocumentAdDate is documentAdDate: the day in Nepal.
func DocumentAdDate(t time.Time) string { return EnGBDay(t.In(documentZone)) }

// DocumentInstant is documentInstant: `2 Sept 2026, 10:00 am NPT`.
func DocumentInstant(t time.Time) string {
	l := t.In(documentZone)
	h, suffix := l.Hour()%12, "am"
	if h == 0 {
		h = 12
	}
	if l.Hour() >= 12 {
		suffix = "pm"
	}
	return fmt.Sprintf("%s, %d:%02d %s NPT", DocumentAdDate(t), h, l.Minute(), suffix)
}
