package bs

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
)

// The night window, from packages/shared/src/night/night-window.ts. A night runs
// 17:00 → 17:00 Nepal time and is not configurable; the prompt hour is per hostel.
const (
	NightStartsAtHour         = 17
	EarliestPromptMinute      = NightStartsAtHour * 60
	LatestPromptMinute        = 23*60 + 45
	DefaultPromptTime         = "20:00"
	PromptWindowMinutes       = 5 * 60
	LastAskMinuteOfNight      = 8 * 60 // 01:00, counted from the night's start
	DefaultRepeatEveryMinutes = 30
)

// RepeatEveryOptions are the offered re-ask intervals.
var RepeatEveryOptions = []int{15, 30, 60}

var promptPattern = regexp.MustCompile(`^([01]\d|2[0-3]):([0-5]\d)$`)

// ParsePromptTime is "20:00" → minutes since midnight; ok is false for anything
// that is not a clock time inside 17:00-23:45 — that hostel is skipped, not prompted.
func ParsePromptTime(value string) (minute int, ok bool) {
	match := promptPattern.FindStringSubmatch(strings.TrimSpace(value))
	if match == nil {
		return 0, false
	}
	minute = int(match[1][0]-'0')*600 + int(match[1][1]-'0')*60 + int(match[2][0]-'0')*10 + int(match[2][1]-'0')
	if minute < EarliestPromptMinute || minute > LatestPromptMinute {
		return 0, false
	}
	return minute, true
}

// FormatPromptTime is minutes since midnight → "20:00".
func FormatPromptTime(minuteOfDay int) string {
	return fmt.Sprintf("%02d:%02d", minuteOfDay/60, minuteOfDay%60)
}

// NepalDayKey is YYYY-MM-DD in Nepal.
func NepalDayKey(t time.Time) string {
	return fromMs(t.UnixMilli() + offsetMs).Format("2006-01-02")
}

// NepalMinuteOfDay is minutes since Nepal midnight.
func NepalMinuteOfDay(t time.Time) int {
	local := fromMs(t.UnixMilli() + offsetMs)
	return local.Hour()*60 + local.Minute()
}

// NightKey is the night an instant falls in: 23:30 on the 8th and 01:00 on the 9th are both 2026-09-08.
func NightKey(t time.Time) string {
	return NepalDayKey(t.Add(-NightStartsAtHour * time.Hour))
}

// NightEndsAt is 17:00 Nepal time on the day after the night's key.
func NightEndsAt(night string) (time.Time, error) {
	day, err := time.Parse("2006-01-02", night)
	if err != nil {
		return time.Time{}, err
	}
	return day.AddDate(0, 0, 1).Add(NightStartsAtHour*time.Hour - OffsetMinutes*time.Minute), nil
}

// IsSameNight is whether two instants fall in the same night.
func IsSameNight(a, b time.Time) bool { return NightKey(a) == NightKey(b) }

// IsCurrentNight is whether a serialized checkedAt belongs to now's night;
// false for empty or unparseable.
func IsCurrentNight(checkedAt string, now time.Time) bool {
	// ponytail: RFC 3339 only — what the API serializes; JS Date also takes looser forms.
	at, err := time.Parse(time.RFC3339Nano, checkedAt)
	return err == nil && IsSameNight(at, now)
}

// RepeatEveryMinutes is the stored interval, or the default when it is not an offered one.
func RepeatEveryMinutes(value int) int {
	if slices.Contains(RepeatEveryOptions, value) {
		return value
	}
	return DefaultRepeatEveryMinutes
}

func minuteOfNight(t time.Time) int {
	return (NepalMinuteOfDay(t) - NightStartsAtHour*60 + 1440) % 1440
}

func askingEndsMinuteOfNight(promptMinute int) int {
	return min(promptMinute-NightStartsAtHour*60+PromptWindowMinutes, LastAskMinuteOfNight)
}

// AskingEndsAt is "20:00" → "01:00": when a hostel with this hour stops asking.
func AskingEndsAt(promptTime string) (string, bool) {
	promptMinute, ok := ParsePromptTime(promptTime)
	if !ok {
		return "", false
	}
	return FormatPromptTime((askingEndsMinuteOfNight(promptMinute) + NightStartsAtHour*60) % 1440), true
}

// PromptRound is which round of asking now falls in; ok is false outside the window.
func PromptRound(promptTime string, every int, now time.Time) (round int, ok bool) {
	promptMinute, ok := ParsePromptTime(promptTime)
	if !ok {
		return 0, false
	}
	start := promptMinute - NightStartsAtHour*60
	at := minuteOfNight(now)
	if at < start || at >= askingEndsMinuteOfNight(promptMinute) {
		return 0, false
	}
	return (at - start) / RepeatEveryMinutes(every), true
}
