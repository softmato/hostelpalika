package food

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// The announce window around a meal's serving time (shared/food/meal-window.ts).
const (
	announceLeadMinutes   = 30
	announceLateMinutes   = 60
	defaultServiceMinutes = 60
	dayMinutes            = 24 * 60
)

var (
	dashes      = regexp.MustCompile(`[–—−]`)
	joinerWords = regexp.MustCompile(`\b(?:to|till|until)\b`)
	dottedAmPm  = regexp.MustCompile(`([ap])\.m\.?`)
	spacedAmPm  = regexp.MustCompile(`(\d)\s+([ap]m)\b`)
	clockTime   = regexp.MustCompile(`(\d{1,2})(?::(\d{2}))?(am|pm)?`)
)

type reading struct {
	hour, minute int
	meridiem     byte // 'a', 'p', 0
}

func readings(timing string) []reading {
	s := strings.ToLower(timing)
	s = dashes.ReplaceAllString(s, " ")
	s = joinerWords.ReplaceAllString(s, " ")
	s = dottedAmPm.ReplaceAllString(s, "${1}m")
	s = spacedAmPm.ReplaceAllString(s, "$1$2")
	out := []reading{}
	for _, m := range clockTime.FindAllStringSubmatch(s, -1) {
		if m[2] == "" && m[3] == "" {
			continue
		}
		hour, _ := strconv.Atoi(m[1])
		minute := 0
		if m[2] != "" {
			minute, _ = strconv.Atoi(m[2])
		}
		if hour > 23 || minute > 59 {
			continue
		}
		var meridiem byte
		if m[3] != "" {
			meridiem = m[3][0]
		}
		out = append(out, reading{hour, minute, meridiem})
	}
	return out
}

func (r reading) minutes() int {
	if r.meridiem == 0 {
		return r.hour*60 + r.minute
	}
	base := r.hour % 12
	if r.meridiem == 'p' {
		base += 12
	}
	return base*60 + r.minute
}

// window is parseMealWindow; ok is false when the text holds no clock time.
func window(timing string) (start int, end *int, ok bool) {
	found := readings(timing)
	if len(found) == 0 {
		return 0, nil, false
	}
	first := found[0]
	if len(found) == 1 {
		return first.minutes(), nil, true
	}
	second := found[1]
	e := second.minutes()
	borrowed := first
	if first.meridiem == 0 && second.meridiem != 0 {
		borrowed.meridiem = second.meridiem
	}
	if c := borrowed.minutes(); c <= e {
		return c, &e, true
	}
	return first.minutes(), &e, true
}

// OpensAt is mealOpensAtMinute.
func OpensAt(timing string) (int, bool) {
	start, _, ok := window(timing)
	if !ok {
		return 0, false
	}
	return max(0, start-announceLeadMinutes), true
}

// ClosesAt is mealClosesAtMinute.
func ClosesAt(timing string) (int, bool) {
	start, end, ok := window(timing)
	if !ok {
		return 0, false
	}
	ends := start + defaultServiceMinutes
	if end != nil {
		ends = *end
	}
	return min(dayMinutes-1, ends+announceLateMinutes), true
}

// AnnounceState is mealAnnounceState: ANY when the text names no time.
func AnnounceState(timing string, minuteOfDay int) string {
	opens, ok := OpensAt(timing)
	closes, ok2 := ClosesAt(timing)
	switch {
	case !ok || !ok2:
		return "ANY"
	case minuteOfDay < opens:
		return "EARLY"
	case minuteOfDay > closes:
		return "MISSED"
	}
	return "OPEN"
}

// FormatMinute is formatMinuteOfDay: "7:05 PM".
func FormatMinute(minuteOfDay int) string {
	wrapped := ((int(math.Round(float64(minuteOfDay))) % dayMinutes) + dayMinutes) % dayMinutes
	h24, m := wrapped/60, wrapped%60
	h12 := h24 % 12
	if h12 == 0 {
		h12 = 12
	}
	suffix := "AM"
	if h24 >= 12 {
		suffix = "PM"
	}
	return fmt.Sprintf("%d:%02d %s", h12, m, suffix)
}
