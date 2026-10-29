// Package bs is the hostel's calendar: the Nepal day (UTC+05:45, no daylight
// saving), Bikram Sambat months as billing periods, the platform's one date
// format, and the night window. A port of packages/shared/src/calendar/bs.ts and
// night/night-window.ts, held to the same vectors (testdata/vectors).
//
// A calendar day is UTC midnight of the Nepal day, as in TS. Off the end of the
// 2000-2090 BS table every function errors rather than guessing.
package bs

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// OffsetMinutes is Asia/Kathmandu's offset; it has never observed daylight saving.
const OffsetMinutes = 5*60 + 45

const (
	msPerMinute = int64(60 * 1000)
	msPerDay    = 24 * 60 * msPerMinute
	offsetMs    = OffsetMinutes * msPerMinute
)

// Era is printed after a BS year, because 2083 alone reads as a mistyped AD year.
const Era = "BS"

// Months is indexed 0 = Baisakh.
var Months = [12]string{
	"Baisakh", "Jestha", "Asar", "Shrawan", "Bhadra", "Aswin",
	"Kartik", "Mangsir", "Poush", "Magh", "Falgun", "Chaitra",
}

// The span the table covers, and the year from which a period key can only be BS.
const (
	YearMin         = 2000
	YearMax         = 2090
	PeriodYearFloor = 2070
)

// ErrOutOfTable is returned for any date the conversion table does not cover.
var ErrOutOfTable = errors.New("the date doesn't fall within 2000/01/01 - 2090/12/30")

// Date is a Bikram Sambat date; Month is 1-12, so 2083-05 is Bhadra.
type Date struct {
	Day   int `json:"day"`
	Month int `json:"month"`
	Year  int `json:"year"`
}

func floorDiv(a, b int64) int64 {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}

func fromMs(v int64) time.Time { return time.UnixMilli(v).UTC() }

/* The Nepal calendar day */

// CalendarDay is the Nepal day an instant falls on, as UTC midnight. Idempotent.
func CalendarDay(t time.Time) time.Time {
	return fromMs(floorDiv(t.UnixMilli()+offsetMs, msPerDay) * msPerDay)
}

// Today is CalendarDay(now).
func Today(now time.Time) time.Time { return CalendarDay(now) }

// DayEnd is the last millisecond, in Kathmandu, of the Nepal day plusDays after t's.
func DayEnd(t time.Time, plusDays int) time.Time {
	day := CalendarDay(t).UnixMilli()
	return fromMs(day + int64(plusDays+1)*msPerDay - offsetMs - 1)
}

// DaysBetween counts whole Nepal days from from's day to to's; negative if to is earlier.
func DaysBetween(from, to time.Time) int {
	return int((CalendarDay(to).UnixMilli() - CalendarDay(from).UnixMilli()) / msPerDay)
}

// DayParts is the Gregorian year/month/day of t's Nepal day.
func DayParts(t time.Time) (year, month, day int) {
	d := CalendarDay(t)
	return d.Year(), int(d.Month()), d.Day()
}

/* AD to BS, and back */

// The table's day 1 is 2000-01-01 BS = 1943-04-14 AD; day 0 is the AD epoch.
var epochAD = time.Date(1943, 4, 13, 0, 0, 0, 0, time.UTC).UnixMilli() / msPerDay

var (
	yearStart  [len(monthDays) + 1]int // days before each year, from the epoch
	monthStart [len(monthDays)][12]int // days before each month, within its year
	maxDay     int
)

func init() {
	for y, months := range monthDays {
		yearStart[y] = maxDay
		sum := 0
		for m, n := range months {
			monthStart[y][m] = sum
			sum += n
		}
		maxDay += sum
	}
	yearStart[len(monthDays)] = maxDay
}

// fromDays maps a table day count (1 = 2000-01-01) to its BS date.
func fromDays(n int) (Date, error) {
	if n < 1 || n > maxDay {
		return Date{}, ErrOutOfTable
	}
	y := 0
	for n > yearStart[y+1] {
		y++
	}
	rest := n - yearStart[y]
	m := 11
	for rest <= monthStart[y][m] {
		m--
	}
	return Date{Year: YearMin + y, Month: m + 1, Day: rest - monthStart[y][m]}, nil
}

// toDays is the converter's findPassedDays: month is 0-based and may overflow into later years.
func toDays(year, month, day int) (int, error) {
	y := year - YearMin
	extraYear := int(floorDiv(int64(month), 12))
	extraMonth := month - extraYear*12
	if y < 0 || y+extraYear < 0 || y+extraYear >= len(monthDays) {
		return 0, ErrOutOfTable
	}
	n := yearStart[y+extraYear] + monthStart[y+extraYear][extraMonth] + day
	if n < 1 || n > maxDay {
		return 0, ErrOutOfTable
	}
	return n, nil
}

// ToBs is the BS date of t's Nepal day.
func ToBs(t time.Time) (Date, error) {
	n := CalendarDay(t).UnixMilli()/msPerDay - epochAD
	if n < 0 {
		n = -n // ponytail: the converter takes Math.abs here; dates before 1943 mirror, as in TS
	}
	return fromDays(int(n))
}

// FromBs is the instant that opens a BS date: UTC midnight of its Gregorian day.
func FromBs(d Date) (time.Time, error) {
	n, err := toDays(d.Year, d.Month-1, d.Day)
	if err != nil {
		return time.Time{}, err
	}
	return fromMs((epochAD + int64(n)) * msPerDay), nil
}

/* Periods */

// FormatPeriodKey is 2083-05.
func FormatPeriodKey(year, month int) string { return fmt.Sprintf("%d-%02d", year, month) }

// PeriodOf is the BS month key an instant belongs to.
func PeriodOf(t time.Time) (string, error) {
	d, err := ToBs(t)
	if err != nil {
		return "", err
	}
	return FormatPeriodKey(d.Year, d.Month), nil
}

// CurrentPeriod is PeriodOf(now).
func CurrentPeriod(now time.Time) (string, error) { return PeriodOf(now) }

var periodPattern = regexp.MustCompile(`^(\d{4})-(\d{2})$`)

// PeriodParts splits a YYYY-MM key of either calendar; ok is false if it is not one.
func PeriodParts(period string) (year, month int, ok bool) {
	match := periodPattern.FindStringSubmatch(strings.TrimSpace(period))
	if match == nil {
		return 0, 0, false
	}
	year, _ = strconv.Atoi(match[1])
	month, _ = strconv.Atoi(match[2])
	if month < 1 || month > 12 {
		return 0, 0, false
	}
	return year, month, true
}

// IsBsPeriod is whether a key's year puts it in Bikram Sambat (>= 2070).
func IsBsPeriod(period string) bool {
	year, _, ok := PeriodParts(period)
	return ok && year >= PeriodYearFloor
}

// DaysInMonth is how many days a BS month runs to, 29 to 32.
func DaysInMonth(year, month int) (int, error) {
	start, err := FromBs(Date{Day: 1, Month: month, Year: year})
	if err != nil {
		return 0, err
	}
	next := Date{Day: 1, Month: month + 1, Year: year}
	if month == 12 {
		next = Date{Day: 1, Month: 1, Year: year + 1}
	}
	end, err := FromBs(next)
	if err != nil {
		return 0, err
	}
	return int((end.UnixMilli() - start.UnixMilli()) / msPerDay), nil
}

// Bounds of a BS month (or a same-day bill's span). LastDay is the one a due date
// uses; End is the last UTC millisecond, for $lte ranges over instants.
type Bounds struct {
	DaysInMonth int
	End         time.Time
	LastDay     time.Time
	Start       time.Time
}

// PeriodBounds errors for anything but a BS key this product can bill (2070-2090).
func PeriodBounds(period string) (Bounds, error) {
	year, month, ok := PeriodParts(period)
	if !ok {
		return Bounds{}, fmt.Errorf("period must be YYYY-MM, received %s", period)
	}
	if year < PeriodYearFloor || year > YearMax {
		return Bounds{}, fmt.Errorf("%s is not a Bikram Sambat period this product can bill (%d-%d BS)", period, PeriodYearFloor, YearMax)
	}
	start, err := FromBs(Date{Day: 1, Month: month, Year: year})
	if err != nil {
		return Bounds{}, err
	}
	days, err := DaysInMonth(year, month)
	if err != nil {
		return Bounds{}, err
	}
	s := start.UnixMilli()
	return Bounds{
		DaysInMonth: days,
		End:         fromMs(s + int64(days)*msPerDay - 1),
		LastDay:     fromMs(s + int64(days-1)*msPerDay),
		Start:       start,
	}, nil
}

// MonthStart is the first day of t's BS month, as UTC midnight.
func MonthStart(t time.Time) (time.Time, error) {
	d, err := ToBs(t)
	if err != nil {
		return time.Time{}, err
	}
	return FromBs(Date{Day: 1, Month: d.Month, Year: d.Year})
}

// DayOfMonth is t's BS day, 1-32.
func DayOfMonth(t time.Time) (int, error) {
	d, err := ToBs(t)
	return d.Day, err
}

// AddMonths moves a key by whole months, carrying the year.
func AddMonths(period string, delta int) (string, error) {
	year, month, ok := PeriodParts(period)
	if !ok {
		return "", fmt.Errorf("period must be YYYY-MM, received %s", period)
	}
	index := int64(year*12 + month - 1 + delta)
	y := floorDiv(index, 12)
	return FormatPeriodKey(int(y), int(index-y*12)+1), nil
}

// MonthsEnd is the last instant a plan of `months` BS months from start's day covers:
// the moment before the same day `months` later, clamped to that month's last day.
func MonthsEnd(start time.Time, months int) (time.Time, error) {
	d, err := ToBs(start)
	if err != nil {
		return time.Time{}, err
	}
	index := int64(d.Year*12 + d.Month - 1 + months)
	year := int(floorDiv(index, 12))
	month := int(index-int64(year)*12) + 1
	days, err := DaysInMonth(year, month)
	if err != nil {
		return time.Time{}, err
	}
	renews, err := FromBs(Date{Day: min(d.Day, days), Month: month, Year: year})
	if err != nil {
		return time.Time{}, err
	}
	return DayEnd(renews, -1), nil
}

// CycleBounds is a same-day bill's span: day billDay of period to the day before
// that day next month. A month shorter than billDay opens on its own last day.
func CycleBounds(period string, billDay int) (Bounds, error) {
	opens := func(key string) (int64, error) {
		b, err := PeriodBounds(key)
		if err != nil {
			return 0, err
		}
		return b.Start.UnixMilli() + int64(min(billDay, b.DaysInMonth)-1)*msPerDay, nil
	}
	start, err := opens(period)
	if err != nil {
		return Bounds{}, err
	}
	nextKey, err := AddMonths(period, 1)
	if err != nil {
		return Bounds{}, err
	}
	next, err := opens(nextKey)
	if err != nil {
		return Bounds{}, err
	}
	return Bounds{
		DaysInMonth: int((next - start) / msPerDay),
		End:         fromMs(next - 1),
		LastDay:     fromMs(next - msPerDay),
		Start:       fromMs(start),
	}, nil
}

// CyclePeriodOf is the key of the same-day bill whose span holds t.
func CyclePeriodOf(t time.Time, billDay int) (string, error) {
	period, err := PeriodOf(t)
	if err != nil {
		return "", err
	}
	b, err := CycleBounds(period, billDay)
	if err != nil {
		return "", err
	}
	if CalendarDay(t).Before(b.Start) {
		return AddMonths(period, -1)
	}
	return period, nil
}

// PeriodsBetween is every key from..to inclusive, oldest first; when longer than
// limit, the oldest are dropped. Empty when from is after to.
func PeriodsBetween(from, to string, limit int) ([]string, error) {
	fy, fm, ok1 := PeriodParts(from)
	ty, tm, ok2 := PeriodParts(to)
	if !ok1 || !ok2 {
		return nil, fmt.Errorf("periods must be YYYY-MM, received %s and %s", from, to)
	}
	span := (ty*12 + tm - 1) - (fy*12 + fm - 1) + 1
	if span <= 0 {
		return []string{}, nil
	}
	length := min(span, limit)
	out := make([]string, length)
	for i := range out {
		out[i], _ = AddMonths(to, i-(length-1))
	}
	return out, nil
}

/* Display */

// MonthName is Bhadra for 5; empty outside 1-12.
func MonthName(month int) string {
	if month < 1 || month > 12 {
		return ""
	}
	return Months[month-1]
}

// FormatPeriod is "Bhadra 2083 BS"; empty for anything it cannot name.
func FormatPeriod(period string) string {
	year, month, ok := PeriodParts(period)
	if !ok || year < PeriodYearFloor {
		return ""
	}
	return fmt.Sprintf("%s %d %s", MonthName(month), year, Era)
}

// FormatPeriodMonth is "Bhadra".
func FormatPeriodMonth(period string) string {
	year, month, ok := PeriodParts(period)
	if !ok || year < PeriodYearFloor {
		return ""
	}
	return MonthName(month)
}

// FormatPeriodYear is "2083 BS".
func FormatPeriodYear(period string) string {
	year, _, ok := PeriodParts(period)
	if !ok || year < PeriodYearFloor {
		return ""
	}
	return fmt.Sprintf("%d %s", year, Era)
}

// DateSeparator sits between the month name and the numbers.
const DateSeparator = "·"

// FormatDate is the platform's one date format, "Baisakh · 2083-01-15";
// empty for the zero time or off the table.
func FormatDate(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	d, err := ToBs(t)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%s %s %d-%02d-%02d", MonthName(d.Month), DateSeparator, d.Year, d.Month, d.Day)
}

// FormatHostelDate is FormatDate with a stand-in for an empty or unreadable value.
func FormatHostelDate(t time.Time, empty string) string {
	if s := FormatDate(t); s != "" {
		return s
	}
	return empty
}

// FormatHostelTime is "2:45 pm" on Nepal's clock.
func FormatHostelTime(t time.Time, empty string) string {
	if t.IsZero() {
		return empty
	}
	local := fromMs(t.UnixMilli() + offsetMs)
	hour, minute := local.Hour(), local.Minute()
	h := hour % 12
	if h == 0 {
		h = 12
	}
	suffix := "pm"
	if hour < 12 {
		suffix = "am"
	}
	return fmt.Sprintf("%d:%02d %s", h, minute, suffix)
}

// FormatHostelDateTime is "Baisakh · 2083-01-15, 2:45 pm".
func FormatHostelDateTime(t time.Time, empty string) string {
	date := FormatHostelDate(t, "")
	if date == "" {
		return empty
	}
	return date + ", " + FormatHostelTime(t, "—")
}

// FormatDayMonth is "Bhadra 19".
func FormatDayMonth(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	d, err := ToBs(t)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%s %d", MonthName(d.Month), d.Day)
}

// FormatDayRange is "Bhadra 19–31", or "Bhadra 19 – Aswin 3" across months.
func FormatDayRange(from, to time.Time) (string, error) {
	start, err := ToBs(from)
	if err != nil {
		return "", err
	}
	end, err := ToBs(to)
	if err != nil {
		return "", err
	}
	name := MonthName(start.Month)
	if start.Year == end.Year && start.Month == end.Month {
		if start.Day == end.Day {
			return fmt.Sprintf("%s %d", name, start.Day), nil
		}
		return fmt.Sprintf("%s %d–%d", name, start.Day, end.Day), nil
	}
	return fmt.Sprintf("%s %d – %s %d", name, start.Day, MonthName(end.Month), end.Day), nil
}

// fiscalYearStartMonth is Shrawan; the fiscal year runs Shrawan 1 to the end of Asar.
const fiscalYearStartMonth = 4

// FiscalYear is "2083/84"; empty for the zero time or off the table.
func FiscalYear(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	d, err := ToBs(t)
	if err != nil {
		return ""
	}
	opening := d.Year
	if d.Month < fiscalYearStartMonth {
		opening--
	}
	return fmt.Sprintf("%d/%02d", opening, (opening+1)%100)
}
