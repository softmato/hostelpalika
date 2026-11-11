package ledger

import (
	"encoding/json"
	"os"
	"slices"
	"testing"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
)

// Go makes and reads the same personal / month codes as reference-code.ts (todo A6).
func TestRefcodeVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../testdata/vectors/refcodes.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Personal []struct {
			Prefix string
			Number int64
			Code   string
		}
		Month []struct {
			Personal, Period, Code string
		}
		Extract []struct {
			Text  string
			Codes []string
		}
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Personal) == 0 || len(v.Month) == 0 || len(v.Extract) == 0 {
		t.Fatal("vectors are missing")
	}
	for _, p := range v.Personal {
		if got := PersonalCode(p.Prefix, p.Number); got != p.Code {
			t.Errorf("PersonalCode(%s,%d) = %s, want %s", p.Prefix, p.Number, got, p.Code)
		}
	}
	for _, m := range v.Month {
		if got := MonthCode(m.Personal, m.Period); got != m.Code {
			t.Errorf("MonthCode(%s,%s) = %s, want %s", m.Personal, m.Period, got, m.Code)
		}
		if personal, period, _ := finance.ParseMonthCode(m.Code); personal != m.Personal || period != m.Period {
			t.Errorf("ParseMonthCode(%s) = %s %s", m.Code, personal, period)
		}
	}
	for _, x := range v.Extract {
		got := finance.ExtractReferenceCodes(x.Text)
		want := slices.Clone(x.Codes)
		slices.Sort(got)
		slices.Sort(want)
		if !slices.Equal(got, want) {
			t.Errorf("ExtractReferenceCodes(%q) = %v, want %v", x.Text, got, want)
		}
	}
}
