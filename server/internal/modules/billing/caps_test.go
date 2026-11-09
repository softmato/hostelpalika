package billing

import (
	"testing"
	"time"

	"github.com/softmato/hostelpalika/server/internal/platform/plans"
)

func TestCapsFor(t *testing.T) {
	catalog, _ := plans.Defaults()
	now := time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)
	past, future := now.AddDate(0, 0, -3), now.AddDate(0, 0, 3)
	paid := catalog.Plans[0].ID
	for _, tc := range []struct {
		name string
		sub  capsSubscription
		want string // plan name, "" for no ceiling
	}{
		{"paid plan", capsSubscription{PlanID: &paid, TrialEndsAt: &past}, catalog.Plans[0].Name},
		{"unpaid trial over", capsSubscription{TrialEndsAt: &past}, "Free"},
		{"trial running", capsSubscription{TrialEndsAt: &future}, ""},
		{"no trial, no plan", capsSubscription{}, ""},
	} {
		name, caps, ok := capsFor(catalog, tc.sub, now)
		if !ok {
			name = ""
		}
		if name != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, name, tc.want)
		}
		if tc.want == "Free" && (*caps["residents"] != 10 || *caps["wardens"] != 1 || *caps["cooks"] != 1) {
			t.Errorf("free caps: %d/%d/%d", *caps["residents"], *caps["wardens"], *caps["cooks"])
		}
	}
}
