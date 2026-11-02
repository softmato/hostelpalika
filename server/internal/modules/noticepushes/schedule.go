// Package noticepushes is modules/notices/notice-push.service.ts: a hostel's
// notice that goes out on its own, now, later, daily or on chosen weekdays.
package noticepushes

import (
	"fmt"
	"slices"
	"time"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
)

// nepalOffset is the one fixed offset Nepal has; no daylight saving, so a wall
// clock converts to UTC by subtracting it.
const nepalOffset = (5*60 + 45) * time.Minute

// Timing is NoticePushTiming; Repeat is NOW, LATER, DAILY or WEEKLY.
type Timing struct {
	Repeat   string
	StartsOn string
	Time     string
	Weekdays []int
}

func wallToUTC(date, clock string) (time.Time, bool) {
	d, err := time.Parse("2006-01-02", date)
	if err != nil {
		// A shape the regex let through but no calendar has ("2026-13-45"): JS Date.UTC rolls it over.
		var y, m, dd int
		if n, _ := scan3(date, &y, &m, &dd); n != 3 {
			return time.Time{}, false
		}
		d = time.Date(y, time.Month(m), dd, 0, 0, 0, 0, time.UTC)
	}
	var h, min int
	if n, _ := scan2(clock, &h, &min); n != 2 {
		return time.Time{}, false
	}
	return time.Date(d.Year(), d.Month(), d.Day(), h, min, 0, 0, time.UTC).Add(-nepalOffset), true
}

func nepalDateOf(t time.Time) string { return bs.NepalDayKey(t) }

func addDays(date string, n int) string {
	var y, m, d int
	scan3(date, &y, &m, &d)
	return time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC).AddDate(0, 0, n).Format("2006-01-02")
}

func weekdayOf(date string) int {
	var y, m, d int
	scan3(date, &y, &m, &d)
	return int(time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC).Weekday())
}

// nextOccurrence is the first run strictly after `after`, or ok=false when the
// schedule has nothing left. A backlog is never replayed.
func nextOccurrence(repeat, startsOn, clock string, weekdays []int, after time.Time) (time.Time, bool) {
	if repeat == "ONCE" {
		at, ok := wallToUTC(startsOn, clock)
		return at, ok && at.After(after)
	}
	weekly := repeat == "WEEKLY"
	if weekly && len(weekdays) == 0 {
		return time.Time{}, false
	}
	date := nepalDateOf(after)
	if startsOn > date {
		date = startsOn
	}
	// Eight days covers any weekday set; the extra one is today's time already gone.
	for range 8 {
		at, ok := wallToUTC(date, clock)
		if !ok {
			return time.Time{}, false
		}
		if at.After(after) && (!weekly || slices.Contains(weekdays, weekdayOf(date))) {
			return at, true
		}
		date = addDays(date, 1)
	}
	return time.Time{}, false
}

// NextRun is nextNoticePushRun: nil for NOW, or a LATER already gone.
func NextRun(t Timing, after time.Time) *time.Time {
	if t.Repeat == "NOW" || t.Time == "" {
		return nil
	}
	repeat, startsOn := t.Repeat, t.StartsOn
	if repeat == "LATER" {
		repeat = "ONCE"
	}
	if startsOn == "" {
		startsOn = nepalDateOf(after)
	}
	at, ok := nextOccurrence(repeat, startsOn, t.Time, t.Weekdays, after)
	if !ok {
		return nil
	}
	return &at
}

// Expiry is noticePushExpiry: a repeat's copy expires as the next one lands.
func Expiry(t Timing, sentAt time.Time) *time.Time {
	if t.Repeat != "DAILY" && t.Repeat != "WEEKLY" {
		return nil
	}
	return NextRun(t, sentAt)
}

// laterFromDelay is the Nepal date and minute `delay` minutes from now, rounded up.
func laterFromDelay(now time.Time, delayMinutes int) (startsOn, clock string) {
	ms := now.UnixMilli() + int64(delayMinutes)*60_000
	at := time.UnixMilli((ms + 59_999) / 60_000 * 60_000).UTC()
	return nepalDateOf(at), at.Add(nepalOffset).Format("15:04")
}

func scan3(s string, a, b, c *int) (int, error) { return fmt.Sscanf(s, "%d-%d-%d", a, b, c) }

func scan2(s string, a, b *int) (int, error) { return fmt.Sscanf(s, "%d:%d", a, b) }
