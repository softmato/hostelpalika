package email

import (
	"fmt"
	"time"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
)

var monthNames = []string{"January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"}

// EmailDate is emailDate: both calendars, "Kartik · 2083-07-15 (1 Nov 2026)";
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
