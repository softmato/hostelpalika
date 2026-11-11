package finance

import (
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
)

// Same cases as credit-score.rules.test.ts (todo B5).
func TestCreditScore(t *testing.T) {
	for day, want := range map[int]int{4: 10, 5: 8, 7: 8, 8: 5, 16: 2} {
		if got := PointsForDay(day); got != want {
			t.Errorf("PointsForDay(%d) = %d, want %d", day, got, want)
		}
	}
	period := "2083-05"
	b, err := bs.PeriodBounds(period)
	if err != nil {
		t.Fatal(err)
	}
	day := func(n int) *time.Time {
		v := b.Start.Add(time.Duration(n-1)*24*time.Hour + 6*time.Hour)
		return &v
	}
	inv := bson.NewObjectID()
	invoices := []ScoreInvoice{{ID: inv, Kind: "MONTHLY_RENT", Period: &period}}
	claim := func(sent int) ScoreEvent {
		return ScoreEvent{ID: bson.NewObjectID(), CreatedAt: day(sent), Direction: "CREDIT", InvoiceID: &inv, OccurredAt: day(sent), SettledAt: day(sent + 10), Source: "RESIDENT_CLAIM", Status: "SETTLED"}
	}
	// A day-2 claim approved late still earns 10.
	if e := ScoreEntries(invoices, []ScoreEvent{claim(2)}); len(e) != 1 || e[0].Points != 10 || e[0].Day != 2 {
		t.Errorf("late approval: %+v", e)
	}
	// Desk cash counts from when the warden recorded it.
	cash := ScoreEvent{ID: bson.NewObjectID(), Direction: "CREDIT", InvoiceID: &inv, OccurredAt: day(1), SettledAt: day(6), Source: "CASH_ENTRY", Status: "SETTLED"}
	if e := ScoreEntries(invoices, []ScoreEvent{cash}); len(e) != 1 || e[0].Points != 8 {
		t.Errorf("desk cash: %+v", e)
	}
	// One award per bill, from the earliest payment.
	if e := ScoreEntries(invoices, []ScoreEvent{claim(9), claim(3)}); len(e) != 1 || e[0].Points != 10 {
		t.Errorf("one per bill: %+v", e)
	}
	rejected, reversed, feeOff := claim(2), claim(2), claim(2)
	rejected.Status = "REJECTED"
	r := bson.NewObjectID()
	reversed.ReversedBy = &r
	feeOff.Source = "OFFER_PROGRAM"
	if e := ScoreEntries(invoices, []ScoreEvent{rejected, reversed, feeOff}); len(e) != 0 {
		t.Errorf("should earn nothing: %+v", e)
	}
	if e := ScoreEntries(invoices, []ScoreEvent{claim(-3)}); len(e) != 1 || e[0].Day != 1 {
		t.Errorf("before the month is day 1: %+v", e)
	}
	pending := claim(1)
	pending.Status = "PENDING"
	if a, s := ClaimCounts([]ScoreEvent{claim(1), rejected, pending}); a != 1 || s != 3 {
		t.Errorf("counts = %d %d", a, s)
	}
}
