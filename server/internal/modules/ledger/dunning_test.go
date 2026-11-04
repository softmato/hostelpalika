package ledger

import "testing"

// TestNextDunningAction replays dunning.test.ts "the ladder".
func TestNextDunningAction(t *testing.T) {
	type in struct {
		chases, since, until int
		stage                string
	}
	cases := []struct {
		in   in
		want *DunningAction
	}{
		{in{0, -1, 7, "NONE"}, &DunningAction{"reminder", "REMINDED"}},
		{in{0, -1, 3, "REMINDED"}, &DunningAction{"reminder", "REMINDED_SOON"}},
		{in{0, -1, 0, "REMINDED_SOON"}, &DunningAction{"reminder", "REMINDED_DUE"}},
		{in{0, -1, 8, "NONE"}, nil},
		{in{0, -1, 5, "REMINDED"}, nil},
		{in{0, -1, 2, "REMINDED_SOON"}, nil},
		{in{0, -1, 0, "REMINDED_DUE"}, nil},
		{in{0, -1, 0, "NONE"}, &DunningAction{"reminder", "REMINDED_DUE"}},
		{in{0, -1, 1, "NONE"}, &DunningAction{"reminder", "REMINDED_SOON"}},
		{in{0, -1, -1, "REMINDED_DUE"}, nil},
		{in{0, -1, -2, "REMINDED_DUE"}, nil},
		{in{0, -1, -3, "NONE"}, &DunningAction{"overdue", "OVERDUE_FIRST"}},
		{in{0, -1, -3, "REMINDED_SOON"}, &DunningAction{"overdue", "OVERDUE_FIRST"}},
		{in{0, -1, -6, "OVERDUE_FIRST"}, nil},
		{in{0, -1, -7, "OVERDUE_FIRST"}, &DunningAction{"overdue", "OVERDUE_SECOND"}},
		{in{0, 2, -30, "OVERDUE_SECOND"}, nil},
		{in{0, 7, -30, "OVERDUE_SECOND"}, &DunningAction{"chase", "CHASING"}},
		{in{MaxChases, 9, -60, "CHASING"}, &DunningAction{"escalate", "ESCALATED"}},
		{in{0, -1, -90, "ESCALATED"}, &DunningAction{"stop", "STOPPED"}},
		{in{0, -1, -900, "STOPPED"}, nil},
	}
	for _, c := range cases {
		got := NextDunningAction(c.in.chases, c.in.since, c.in.until, 7, c.in.stage)
		if (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
			t.Errorf("%+v: got %v, want %v", c.in, got, c.want)
		}
	}
	// No starting rung loops: every one reaches STOPPED.
	for _, start := range []string{"NONE", "REMINDED", "REMINDED_SOON", "REMINDED_DUE", "OVERDUE_FIRST", "OVERDUE_SECOND", "CHASING", "ESCALATED"} {
		stage, chases := start, 0
		for steps := 0; ; steps++ {
			a := NextDunningAction(chases, 30, -365, 7, stage)
			if a == nil {
				break
			}
			if steps >= 20 {
				t.Fatalf("%s loops", start)
			}
			stage = a.Stage
			if a.Kind == "chase" {
				chases++
			}
		}
		if stage != "STOPPED" {
			t.Errorf("%s ends at %s", start, stage)
		}
	}
}
