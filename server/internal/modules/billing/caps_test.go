package billing

import (
	"slices"
	"testing"
	"time"

	"github.com/softmato/hostelpalika/server/internal/platform/plans"
)

func TestPlanState(t *testing.T) {
	catalog, _ := plans.Defaults()
	now := time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)
	past, future := now.AddDate(0, 0, -3), now.AddDate(0, 0, 3)
	paid := catalog.Plans[0].ID
	for _, tc := range []struct {
		name string
		sub  *capsSubscription
		kind string
	}{
		{"live paid plan", &capsSubscription{PlanID: &paid, CurrentPeriodEnd: &future}, "paid"},
		{"lifetime plan", &capsSubscription{PlanID: &paid, LifetimeSince: &past}, "paid"},
		{"trial running, plan chosen", &capsSubscription{PlanID: &paid, TrialEndsAt: &future}, "trial"},
		{"paid period lapsed", &capsSubscription{PlanID: &paid, CurrentPeriodEnd: &past}, "free"},
		{"plan chosen, never paid", &capsSubscription{PlanID: &paid, TrialEndsAt: &past}, "free"},
		{"unpaid trial over", &capsSubscription{TrialEndsAt: &past}, "free"},
		{"no trial, no plan", &capsSubscription{}, "none"},
		{"no subscription", nil, "none"},
	} {
		if got := planState(catalog, tc.sub, now).kind; got != tc.kind {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.kind)
		}
	}

	free := planState(catalog, &capsSubscription{TrialEndsAt: &past}, now)
	if *free.caps["residents"] != 10 || *free.caps["wardens"] != 1 || *free.caps["cooks"] != 1 || free.name != "Free" {
		t.Errorf("free caps: %+v", free)
	}
	if got := seatsOver(free, map[string]int64{"residents": 34, "wardens": 2, "cooks": 1}); !slices.Equal(got, []string{"residents", "wardens"}) {
		t.Errorf("seatsOver: %v", got)
	}
}
