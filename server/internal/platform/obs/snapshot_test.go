package obs

import (
	"math"
	"testing"
)

func TestQuantile(t *testing.T) {
	b := map[float64]uint64{0.1: 50, 0.5: 94, 1: 99, math.Inf(1): 100}
	if got := quantile(b, 100, 0.95); got != 1 {
		t.Fatalf("p95 = %v, want 1", got)
	}
	if got := quantile(b, 100, 0.5); got != 0.1 {
		t.Fatalf("p50 = %v, want 0.1", got)
	}
	if got := quantile(map[float64]uint64{0.1: 0, math.Inf(1): 3}, 3, 0.95); got != 0.1 {
		t.Fatalf("all slow = %v, want the last finite bound", got)
	}
	if got := quantile(nil, 0, 0.95); got != 0 {
		t.Fatalf("empty = %v", got)
	}
}
