package gateway

import (
	"testing"
	"time"
)

func TestVerdict(t *testing.T) {
	week := 8 * 24 * time.Hour
	for _, c := range []struct {
		counts healthCounts
		open   int64
		status string
	}{
		{healthCounts{attempts: 3, unconfirmed: 3}, 0, "FAILING"},
		{healthCounts{attempts: 4}, 0, "FAILING"},
		{healthCounts{attempts: 5, succeeded: 2}, 0, "DEGRADED"},
		{healthCounts{attempts: 4, succeeded: 3, unconfirmed: 1}, 0, "DEGRADED"},
		{healthCounts{attempts: 2, succeeded: 2}, 0, "HEALTHY"},
		{healthCounts{}, 3, "QUIET"},
		{healthCounts{}, 0, "HEALTHY"},
	} {
		if _, got := verdict(c.counts, week, c.open); got != c.status {
			t.Errorf("%+v open=%d: %s, want %s", c.counts, c.open, got, c.status)
		}
	}
	if _, got := verdict(healthCounts{}, 24*time.Hour, 3); got != "HEALTHY" {
		t.Errorf("a gateway switched on yesterday is not QUIET yet: %s", got)
	}
	if d, _ := verdict(healthCounts{}, week, 1); d != "No resident has used this to pay in the last 7 days, and 1 invoice is unpaid. That may be normal, or the button may not be reaching them." {
		t.Errorf("detail: %s", d)
	}
}
