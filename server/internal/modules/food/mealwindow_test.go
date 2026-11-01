package food

import "testing"

// Cases from packages/shared/src/food/meal-window: "8 - 10 pm" borrows pm unless
// that would put the start after the end, and text with no clock time is ANY.
func TestAnnounceState(t *testing.T) {
	cases := []struct {
		timing string
		minute int
		want   string
	}{
		{"", 600, "ANY"},
		{"after the rush", 600, "ANY"},
		{"6:00 AM - 7:00 AM", 5*60 + 29, "EARLY"},
		{"6:00 AM - 7:00 AM", 5*60 + 30, "OPEN"},
		{"6:00 AM - 7:00 AM", 8 * 60, "OPEN"},
		{"6:00 AM - 7:00 AM", 8*60 + 1, "MISSED"},
		{"7 - 9 pm", 18*60 + 29, "EARLY"},
		{"7 - 9 pm", 22 * 60, "OPEN"},
		{"11 - 1 pm", 10*60 + 30, "EARLY"}, // a bare 11 is no clock time: only 1 pm counts
		{"11am to 1 p.m.", 14 * 60, "OPEN"},
		{"19:00", 21*60 + 1, "MISSED"}, // one time: an hour of service, an hour late
		{"23:30", 23*60 + 59, "OPEN"},
	}
	for _, c := range cases {
		if got := AnnounceState(c.timing, c.minute); got != c.want {
			t.Errorf("%q at %d: got %s, want %s", c.timing, c.minute, got, c.want)
		}
	}
	if got := FormatMinute(0); got != "12:00 AM" {
		t.Errorf("FormatMinute(0) = %s", got)
	}
	if got := FormatMinute(19*60 + 5); got != "7:05 PM" {
		t.Errorf("FormatMinute = %s", got)
	}
}
