package reports

import (
	"bytes"
	"testing"

	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

func TestChangeLabelAndRupees(t *testing.T) {
	for _, c := range []struct {
		cur, prev float64
		want      string
	}{{0, 0, "-"}, {5, 0, "New"}, {5, 5, "No change"}, {6, 5, "+20%"}, {4, 5, "-20%"}} {
		if got := changeLabel(c.cur, c.prev); got != c.want {
			t.Errorf("changeLabel(%v,%v) = %q, want %q", c.cur, c.prev, got, c.want)
		}
	}
	if got := pdfRupees(120000.4); got != "Rs 1,20,000" {
		t.Errorf("pdfRupees = %q", got)
	}
}

// A hundred expenses must paginate rather than run off the page or panic.
func TestPerformancePDFRenders(t *testing.T) {
	rows := make([]ordered.Map, 100)
	for i := range rows {
		rows[i] = ordered.Map{{Key: "amount", Value: 100}, {Key: "categoryLabel", Value: "Gas"}, {Key: "paidBy", Value: "CASH"}, {Key: "spentOn", Value: "2026-09-01"}, {Key: "recordedBy", Value: ordered.Map{{Key: "name", Value: "Ram"}}}}
	}
	body, name, err := RenderPerformancePDF(ordered.Map{
		{Key: "generatedAt", Value: "2026-10-01T00:00:00.000Z"}, {Key: "hostelName", Value: "Test"},
		{Key: "period", Value: ordered.Map{{Key: "month", Value: "2083-05"}, {Key: "previousMonth", Value: "2083-04"}, {Key: "start", Value: "2026-08-17T00:00:00.000Z"}, {Key: "end", Value: "2026-09-16T00:00:00.000Z"}}},
		{Key: "moneyOut", Value: ordered.Map{{Key: "out", Value: 10000}, {Key: "rows", Value: rows}}},
	})
	if err != nil || name != "performance-2083-05.pdf" || !bytes.HasPrefix(body, []byte("%PDF")) {
		t.Fatalf("name %q, err %v", name, err)
	}
}
