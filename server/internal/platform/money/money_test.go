package money

import (
	"encoding/json"
	"os"
	"slices"
	"testing"
)

// Vectors come from testdata/vectors/generate.ts, which runs the TS helpers.

type result[T any] struct {
	Value T
	Error bool
}

func (r *result[T]) UnmarshalJSON(raw []byte) error {
	var e struct{ Error bool }
	if json.Unmarshal(raw, &e) == nil && e.Error {
		r.Error = true
		return nil
	}
	return json.Unmarshal(raw, &r.Value)
}

func (r result[T]) matches(t *testing.T, label string, got T, err error, eq func(a, b T) bool) {
	t.Helper()
	if r.Error != (err != nil) || (err == nil && !eq(r.Value, got)) {
		t.Errorf("%s: want %+v, got %v %v", label, r, got, err)
	}
}

func same[T comparable](a, b T) bool { return a == b }

func TestVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../testdata/vectors/money.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Round []struct {
			Value  float64
			Rupees int64
		}
		Prorate []struct {
			Monthly   int64
			Days, Dim int
			Amount    result[int64]
		}
		Split []struct {
			Amount int64
			Parts  int
			Shares result[[]int64]
		}
		Sum []struct {
			Amounts []int64
			Total   result[int64]
		}
		Format []struct {
			Amount                                   int64
			Npr, Paisa, StoreNpr, Document, PlanRate string
			ToPaisa                                  int64
			ToRupees                                 result[int64]
		}
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}

	for _, c := range v.Round {
		if got, _ := RoundToRupee(c.Value); got != c.Rupees {
			t.Errorf("round %v: %d != %d", c.Value, got, c.Rupees)
		}
	}
	for _, c := range v.Prorate {
		got, err := Prorate(c.Monthly, c.Days, c.Dim)
		c.Amount.matches(t, "prorate", got, err, same)
	}
	for _, c := range v.Split {
		got, err := Split(c.Amount, c.Parts)
		c.Shares.matches(t, "split", got, err, slices.Equal)
	}
	for _, c := range v.Sum {
		got, err := Sum(c.Amounts)
		c.Total.matches(t, "sum", got, err, same)
	}
	for _, c := range v.Format {
		for _, pair := range [][2]string{
			{FormatNPR(c.Amount), c.Npr}, {FormatPaisa(c.Amount), c.Paisa},
			{FormatStoreNPR(c.Amount), c.StoreNpr}, {DocumentAmount(c.Amount), c.Document},
			{FormatPlanRate(c.Amount), c.PlanRate},
		} {
			if pair[0] != pair[1] {
				t.Errorf("%d: %q != %q", c.Amount, pair[0], pair[1])
			}
		}
		if RupeesToPaisa(c.Amount) != c.ToPaisa {
			t.Errorf("toPaisa %d", c.Amount)
		}
		got, err := PaisaToRupees(c.Amount)
		c.ToRupees.matches(t, "toRupees", got, err, same)
	}
}
