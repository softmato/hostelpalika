package bs

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"testing"
	"time"
)

// Vectors come from testdata/vectors/generate.ts, which runs the TS calendar.

func load(t *testing.T, name string, into any) {
	t.Helper()
	raw, err := os.ReadFile("../../../testdata/vectors/" + name)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, into); err != nil {
		t.Fatal(err)
	}
}

func iso(v time.Time) string { return v.UTC().Format("2006-01-02T15:04:05.000Z") }

func at(t *testing.T, s string) time.Time {
	v, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// check compares a Go (value, err) against a TS vector that is the value or {"error":true}.
func check[T any](t *testing.T, label string, want json.RawMessage, got T, err error) {
	t.Helper()
	var e struct{ Error bool }
	if json.Unmarshal(want, &e) == nil && e.Error {
		if err == nil {
			t.Errorf("%s: want error, got %v", label, got)
		}
		return
	}
	if err != nil {
		t.Errorf("%s: unexpected error %v", label, err)
		return
	}
	gotJSON, _ := json.Marshal(got)
	var a, b any
	_ = json.Unmarshal(want, &a)
	_ = json.Unmarshal(gotJSON, &b)
	if fmt.Sprint(a) != fmt.Sprint(b) {
		t.Errorf("%s: want %s, got %s", label, want, gotJSON)
	}
}

type boundsJSON struct {
	DaysInMonth int    `json:"daysInMonth"`
	End         string `json:"end"`
	LastDay     string `json:"lastDay"`
	Start       string `json:"start"`
}

func asJSON(b Bounds, err error) (boundsJSON, error) {
	return boundsJSON{b.DaysInMonth, iso(b.End), iso(b.LastDay), iso(b.Start)}, err
}

func isoErr(v time.Time, err error) (string, error) { return iso(v), err }

func TestInstantVectors(t *testing.T) {
	var file struct {
		Instants []struct {
			At                                         string
			ToBs                                       json.RawMessage
			CalendarDay                                string
			DayEnd                                     []string
			DayParts                                   struct{ Day, Month, Year int }
			Period                                     json.RawMessage
			MonthStart                                 json.RawMessage
			Date, Time, DateTime, DayMonth, FiscalYear string
			MonthsEnd                                  []json.RawMessage
			CyclePeriod                                []json.RawMessage
			NightKey                                   string
			NightEndsAt                                string
		}
		Pairs []struct {
			From, To    string
			DaysBetween int
			DayRange    json.RawMessage
			SameNight   bool
		}
	}
	load(t, "bs.json", &file)

	for _, c := range file.Instants {
		v := at(t, c.At)
		d, err := ToBs(v)
		check(t, c.At+" toBs", c.ToBs, d, err)
		if got := iso(CalendarDay(v)); got != c.CalendarDay {
			t.Errorf("%s calendarDay: %s != %s", c.At, got, c.CalendarDay)
		}
		for i, plus := range []int{-1, 0, 3} {
			if got := iso(DayEnd(v, plus)); got != c.DayEnd[i] {
				t.Errorf("%s dayEnd(%d): %s != %s", c.At, plus, got, c.DayEnd[i])
			}
		}
		if y, m, dd := DayParts(v); y != c.DayParts.Year || m != c.DayParts.Month || dd != c.DayParts.Day {
			t.Errorf("%s dayParts: %d-%d-%d", c.At, y, m, dd)
		}
		p, err := PeriodOf(v)
		check(t, c.At+" period", c.Period, p, err)
		ms, err := isoErr(MonthStart(v))
		check(t, c.At+" monthStart", c.MonthStart, ms, err)
		for _, pair := range [][2]string{
			{FormatDate(v), c.Date}, {FormatHostelTime(v, "—"), c.Time},
			{FormatHostelDateTime(v, "—"), c.DateTime}, {FormatDayMonth(v), c.DayMonth},
			{FiscalYear(v), c.FiscalYear}, {NightKey(v), c.NightKey},
		} {
			if pair[0] != pair[1] {
				t.Errorf("%s: %q != %q", c.At, pair[0], pair[1])
			}
		}
		for i, n := range []int{1, 3, 12} {
			got, err := isoErr(MonthsEnd(v, n))
			check(t, fmt.Sprintf("%s monthsEnd(%d)", c.At, n), c.MonthsEnd[i], got, err)
		}
		for i, day := range []int{1, 20, 32} {
			got, err := CyclePeriodOf(v, day)
			check(t, fmt.Sprintf("%s cyclePeriod(%d)", c.At, day), c.CyclePeriod[i], got, err)
		}
		end, err := NightEndsAt(c.NightKey)
		if err != nil || iso(end) != c.NightEndsAt {
			t.Errorf("%s nightEndsAt: %s %v != %s", c.At, iso(end), err, c.NightEndsAt)
		}
	}

	for _, c := range file.Pairs {
		from, to := at(t, c.From), at(t, c.To)
		if got := DaysBetween(from, to); got != c.DaysBetween {
			t.Errorf("%s→%s daysBetween: %d != %d", c.From, c.To, got, c.DaysBetween)
		}
		r, err := FormatDayRange(from, to)
		check(t, c.From+" dayRange", c.DayRange, r, err)
		if IsSameNight(from, to) != c.SameNight {
			t.Errorf("%s→%s sameNight", c.From, c.To)
		}
	}
}

func TestPeriodVectors(t *testing.T) {
	var file struct {
		Periods []struct {
			Period             string
			Bounds             json.RawMessage
			DaysInMonth        json.RawMessage
			Cycle              []json.RawMessage
			Add                []string
			Label, Month, Year string
		}
		Keys []struct {
			Key   string
			Parts *struct{ Month, Year int }
			IsBs  bool
			Label string
		}
		Between []struct {
			From, To string
			Cap      int
			Periods  json.RawMessage
		}
	}
	load(t, "bs.json", &file)

	for _, c := range file.Periods {
		b, err := asJSON(PeriodBounds(c.Period))
		check(t, c.Period+" bounds", c.Bounds, b, err)
		y, m, _ := PeriodParts(c.Period)
		n, err := DaysInMonth(y, m)
		check(t, c.Period+" daysInMonth", c.DaysInMonth, n, err)
		for i, day := range []int{1, 15, 20, 32} {
			b, err := asJSON(CycleBounds(c.Period, day))
			check(t, fmt.Sprintf("%s cycle(%d)", c.Period, day), c.Cycle[i], b, err)
		}
		for i, d := range []int{-13, -1, 1, 12, 25} {
			if got, _ := AddMonths(c.Period, d); got != c.Add[i] {
				t.Errorf("%s add(%d): %s != %s", c.Period, d, got, c.Add[i])
			}
		}
		if FormatPeriod(c.Period) != c.Label || FormatPeriodMonth(c.Period) != c.Month || FormatPeriodYear(c.Period) != c.Year {
			t.Errorf("%s labels", c.Period)
		}
	}

	for _, c := range file.Keys {
		y, m, ok := PeriodParts(c.Key)
		if ok != (c.Parts != nil) || (ok && (y != c.Parts.Year || m != c.Parts.Month)) {
			t.Errorf("%q parts: %d %d %v", c.Key, y, m, ok)
		}
		if IsBsPeriod(c.Key) != c.IsBs || FormatPeriod(c.Key) != c.Label {
			t.Errorf("%q isBs/label", c.Key)
		}
	}

	for _, c := range file.Between {
		got, err := PeriodsBetween(c.From, c.To, c.Cap)
		check(t, c.From+".."+c.To, c.Periods, got, err)
	}
}

func TestNightVectors(t *testing.T) {
	var file struct {
		Prompts []struct {
			Value        string
			Parsed       *int
			AskingEndsAt *string
		}
		Format []struct {
			Minute int
			Text   string
		}
		Repeat []struct {
			Value *int
			Every int
		}
		Rounds []struct {
			At     string
			Prompt string
			Every  int
			Round  *int
		}
		Current []struct {
			CheckedAt *string
			Now       string
			Current   bool
		}
	}
	load(t, "night.json", &file)

	for _, c := range file.Prompts {
		m, ok := ParsePromptTime(c.Value)
		if ok != (c.Parsed != nil) || (ok && m != *c.Parsed) {
			t.Errorf("parse %q: %d %v", c.Value, m, ok)
		}
		s, ok := AskingEndsAt(c.Value)
		if ok != (c.AskingEndsAt != nil) || (ok && s != *c.AskingEndsAt) {
			t.Errorf("askingEndsAt %q: %s", c.Value, s)
		}
	}
	for _, c := range file.Format {
		if got := FormatPromptTime(c.Minute); got != c.Text {
			t.Errorf("format %d: %s", c.Minute, got)
		}
	}
	for _, c := range file.Repeat {
		v := 0
		if c.Value != nil {
			v = *c.Value
		}
		if got := RepeatEveryMinutes(v); got != c.Every {
			t.Errorf("repeat %v: %d", c.Value, got)
		}
	}
	for _, c := range file.Rounds {
		r, ok := PromptRound(c.Prompt, c.Every, at(t, c.At))
		if ok != (c.Round != nil) || (ok && r != *c.Round) {
			t.Errorf("round %s %s/%d: %d %v", c.At, c.Prompt, c.Every, r, ok)
		}
	}
	for _, c := range file.Current {
		s := ""
		if c.CheckedAt != nil {
			s = *c.CheckedAt
		}
		if IsCurrentNight(s, at(t, c.Now)) != c.Current {
			t.Errorf("current %v", c.CheckedAt)
		}
	}
}

func TestNepalOnlyAnswersFromTable(t *testing.T) {
	// Bhadra 2083 runs 17 Aug to 16 Sep 2026, 31 days (the case the TS doc is built around).
	b, err := PeriodBounds("2083-05")
	if err != nil || iso(b.Start) != "2026-08-17T00:00:00.000Z" || b.DaysInMonth != 31 {
		t.Fatalf("%+v %v", b, err)
	}
	if !slices.Equal(RepeatEveryOptions, []int{15, 30, 60}) {
		t.Fatal("options")
	}
}
