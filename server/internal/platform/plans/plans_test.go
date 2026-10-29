package plans

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"
)

// Vectors come from testdata/vectors/generate.ts, which runs the TS catalogue.

func eq(t *testing.T, label string, got, want any) {
	t.Helper()
	g, _ := json.Marshal(got)
	var a, b any
	_ = json.Unmarshal(g, &a)
	w, _ := json.Marshal(want)
	_ = json.Unmarshal(w, &b)
	if !reflect.DeepEqual(a, b) {
		t.Errorf("%s: got %s, want %s", label, g, w)
	}
}

func TestVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../testdata/vectors/plans.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Catalogs map[string]Catalog
		Lifetime Lifetime
		Cases    []struct {
			Catalog, Period  string
			EventRuns        bool
			BestEventPercent float64
			Best             []struct {
				Cycle           Cycle
				Percent, Saving float64
			}
			Plans []struct {
				ID            string
				Monthly       float64
				ListMonthly   float64
				Rank          int
				Below         *string
				ResidentRange string
				PortalAccess  []AccessLine
				NewServices   []string
				CardServices  []string
				Includes      []bool
				Cycles        []struct {
					Cycle               Cycle
					Total, Rate, Saving float64
				}
				Months []struct {
					Months int
					Total  float64
					Cycle  Cycle
					Label  string
				}
			}
		}
		LifetimeCases []struct {
			Now, NepalDay, Window, Off, Open string
		}
		LifetimeOffers []struct {
			PlanID string
			Offer  *Offer
		}
		SeatsLeft        []struct{ Seats, Sold, Left int }
		TotalSeats       int
		MonthsEquivalent []struct {
			Price, Monthly float64
			Months         *float64
		}
		EndsAt []struct {
			Day string
			At  *int64
		}
		FormatDay []struct{ Day, Text string }
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}

	for _, c := range v.Cases {
		raw := v.Catalogs[c.Catalog]
		cat := SellingCatalog(raw, c.Period)
		label := c.Catalog + " " + c.Period
		eq(t, label+" eventRuns", EventRuns(raw, c.Period), c.EventRuns)
		eq(t, label+" bestEvent", BestEventPercent(cat), c.BestEventPercent)
		for _, b := range c.Best {
			eq(t, label+" best", []float64{BestDiscountPercent(cat, b.Cycle), BestSaving(cat, b.Cycle)}, []float64{b.Percent, b.Saving})
		}
		for i, want := range c.Plans {
			p := cat.Plans[i]
			l := fmt.Sprintf("%s %s", label, p.ID)
			var below *string
			if b := PlanBelow(cat, p.ID); b != nil {
				below = &b.ID
			}
			slugs := func(s []Service) []string {
				out := []string{}
				for _, x := range s {
					out = append(out, x.Slug)
				}
				return out
			}
			includes := []bool{}
			for _, s := range cat.Services {
				includes = append(includes, PlanIncludes(cat, p.ID, s))
			}
			eq(t, l, []any{p.ID, p.Monthly, ListMonthlyOf(p), PlanRank(cat, p.ID), below, ResidentRangeLabel(cat, p)},
				[]any{want.ID, want.Monthly, want.ListMonthly, want.Rank, want.Below, want.ResidentRange})
			eq(t, l+" access", PortalAccessLines(cat, p), want.PortalAccess)
			eq(t, l+" new", slugs(NewServicesForPlan(cat, p.ID)), want.NewServices)
			eq(t, l+" card", slugs(CardServicesForPlan(cat, p.ID)), want.CardServices)
			eq(t, l+" includes", includes, want.Includes)
			for _, cy := range want.Cycles {
				eq(t, l+" "+string(cy.Cycle), []float64{CycleTotal(p, cy.Cycle), MonthlyRateFor(p, cy.Cycle), SavingFor(p, cy.Cycle)},
					[]float64{cy.Total, cy.Rate, cy.Saving})
			}
			for _, m := range want.Months {
				eq(t, fmt.Sprintf("%s %d months", l, m.Months),
					[]any{MonthsTotal(p, m.Months), CycleForMonths(m.Months), MonthsLabel(cat, m.Months)},
					[]any{m.Total, m.Cycle, m.Label})
			}
		}
	}

	for _, c := range v.LifetimeCases {
		now, _ := time.Parse(time.RFC3339Nano, c.Now)
		off, open := v.Lifetime, v.Lifetime
		off.Enabled = false
		open.StartsOn, open.EndsOn = "", ""
		eq(t, c.Now, []string{LifetimeWindow(v.Lifetime, now), LifetimeWindow(off, now), LifetimeWindow(open, now)},
			[]string{c.Window, c.Off, c.Open})
	}
	for _, c := range v.LifetimeOffers {
		eq(t, "offer "+c.PlanID, LifetimeOfferFor(v.Lifetime, c.PlanID), c.Offer)
	}
	for _, c := range v.SeatsLeft {
		eq(t, "seats", LifetimeSeatsLeft(c.Seats, c.Sold), c.Left)
	}
	eq(t, "total seats", LifetimeTotalSeats(v.Lifetime), v.TotalSeats)
	for _, c := range v.MonthsEquivalent {
		m, ok := LifetimeMonthsEquivalent(c.Price, c.Monthly)
		if ok != (c.Months != nil) || (ok && m != *c.Months) {
			t.Errorf("monthsEquivalent %v/%v: %v", c.Price, c.Monthly, m)
		}
	}
	for _, c := range v.EndsAt {
		at, ok := LifetimeEndsAt(c.Day)
		if ok != (c.At != nil) || (ok && at != *c.At) {
			t.Errorf("endsAt %q: %d", c.Day, at)
		}
	}
	for _, c := range v.FormatDay {
		eq(t, "formatDay", FormatLifetimeDay(c.Day), c.Text)
	}
}

// The embedded defaults are the standard vector catalogue.
func TestDefaults(t *testing.T) {
	raw, _ := os.ReadFile("../../../testdata/vectors/plans.json")
	var v struct {
		Catalogs map[string]Catalog
		Lifetime Lifetime
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	catalog, lifetime := Defaults()
	eq(t, "plans", catalog, v.Catalogs["standard"])
	eq(t, "lifetime", lifetime, v.Lifetime)
}
