package email

import (
	"fmt"
	"time"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
)

var monthNames = []string{"January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"}

// EmailTime is emailTime: "3:40 PM" in Kathmandu.
func EmailTime(t time.Time) string {
	minutes := int((t.UnixMilli() + 345*60_000) / 60_000 % (24 * 60))
	h24, h12 := minutes/60, minutes/60%12
	if h12 == 0 {
		h12 = 12
	}
	suffix := "PM"
	if h24 < 12 {
		suffix = "AM"
	}
	return fmt.Sprintf("%d:%02d %s", h12, minutes%60, suffix)
}

// EmailDateTime is emailDateTime; "" for the zero time.
func EmailDateTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return EmailDate(t) + ", " + EmailTime(t)
}

// EmailDate is emailDate: both calendars, "Kartik 15, 2083 BS (1 Nov 2026)";
// "" for the zero time.
func EmailDate(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	y, m, d := bs.DayParts(t)
	gregorian := fmt.Sprintf("%d %s %d", d, monthNames[m-1][:3], y)
	if b := bs.FormatDate(t); b != "" {
		return b + " (" + gregorian + ")"
	}
	return gregorian
}
