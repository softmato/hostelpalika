// Package plans is the plans-and-pricing arithmetic and the lifetime deal, a port
// of packages/shared/src/plans/{catalog,lifetime}.ts held to
// testdata/vectors/plans.json. The catalogue itself is the `plans` site-config
// section; defaults.json is TS's DEFAULT_PLANS and DEFAULT_LIFETIME, written by
// the vector generator so the values cannot drift.
//
// Prices are float64 because the stored schema allows a fractional `monthly`;
// every figure that reaches a card goes through jsRound like Math.round in TS.
package plans

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"slices"

	"github.com/softmato/hostelpalika/server/internal/platform/money"
)

type ListingTier struct {
	Label string `json:"label"`
	Note  string `json:"note"`
	Slug  string `json:"slug"`
	Tone  string `json:"tone"`
}

type PortalAccess struct {
	Cooks   *int `json:"cooks"`
	Wardens *int `json:"wardens"`
}

type Plan struct {
	AnnualDiscountPercent     float64      `json:"annualDiscountPercent"`
	CtaHref                   string       `json:"ctaHref"`
	CtaLabel                  string       `json:"ctaLabel"`
	Description               string       `json:"description"`
	Featured                  bool         `json:"featured"`
	EventDiscountPercent      float64      `json:"eventDiscountPercent"`
	HalfYearlyDiscountPercent float64      `json:"halfYearlyDiscountPercent"`
	ID                        string       `json:"id"`
	ListingTier               *ListingTier `json:"listingTier"`
	// ListMonthly is stamped by SellingPlan during an event, never stored.
	ListMonthly  *float64     `json:"listMonthly,omitempty"`
	MaxBranches  int          `json:"maxBranches"`
	MaxResidents *int         `json:"maxResidents"`
	Monthly      float64      `json:"monthly"`
	Name         string       `json:"name"`
	PortalAccess PortalAccess `json:"portalAccess"`
}

type Module struct {
	Description string `json:"description"`
	Icon        string `json:"icon"`
	ID          string `json:"id"`
	Name        string `json:"name"`
}

type Service struct {
	Audience []string `json:"audience"`
	Blurb    string   `json:"blurb"`
	Module   string   `json:"module"`
	Name     string   `json:"name"`
	// Plan is the lowest plan that carries it; every plan above carries it too.
	Plan string `json:"plan"`
	Slug string `json:"slug"`
	Demo struct {
		MobileAssetID string `json:"mobileAssetId"`
		WebAssetID    string `json:"webAssetId"`
	} `json:"demo"`
	How  []string `json:"how"`
	What []string `json:"what"`
	Why  []string `json:"why"`
}

type Event struct {
	EndsOn string `json:"endsOn"` // BS period key, inclusive
	Label  string `json:"label"`
	Mode   string `json:"mode"` // "standard" | "event"
	Note   string `json:"note"`
}

// Catalog is the parts of the `plans` section the arithmetic reads (`page` is not one).
type Catalog struct {
	CycleLabels struct {
		Annual     string `json:"annual"`
		HalfYearly string `json:"halfYearly"`
		Monthly    string `json:"monthly"`
	} `json:"cycleLabels"`
	Event    Event     `json:"event"`
	Modules  []Module  `json:"modules"`
	Plans    []Plan    `json:"plans"`
	Services []Service `json:"services"`
}

// Cycle is "monthly" | "halfYearly" | "annual".
type Cycle string

const (
	Monthly    Cycle = "monthly"
	HalfYearly Cycle = "halfYearly"
	Annual     Cycle = "annual"
)

// Cycles in toggle order.
var Cycles = []Cycle{Monthly, HalfYearly, Annual}

//go:embed defaults.json
var defaultsJSON []byte

// Defaults is DEFAULT_PLANS and DEFAULT_LIFETIME, what a fresh database shows.
func Defaults() (Catalog, Lifetime) {
	var d struct {
		Plans    Catalog  `json:"plans"`
		Lifetime Lifetime `json:"lifetime"`
	}
	if err := json.Unmarshal(defaultsJSON, &d); err != nil {
		panic(err) // generated file; a decode failure is a build defect
	}
	return d.Plans, d.Lifetime
}

// jsRound is Math.round: half rounds toward +∞.
func jsRound(x float64) float64 {
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	return r
}

func CycleMonths(c Cycle) int {
	switch c {
	case Annual:
		return 12
	case HalfYearly:
		return 6
	}
	return 1
}

func DiscountPercent(p Plan, c Cycle) float64 {
	switch c {
	case Annual:
		return p.AnnualDiscountPercent
	case HalfYearly:
		return p.HalfYearlyDiscountPercent
	}
	return 0
}

// CycleTotal is one payment on this cycle, to the whole rupee.
func CycleTotal(p Plan, c Cycle) float64 {
	return jsRound(p.Monthly * float64(CycleMonths(c)) * (1 - DiscountPercent(p, c)/100))
}

// MonthsTotal prices 1-12+ months at the best cycle the count reaches.
func MonthsTotal(p Plan, months int) float64 {
	if months >= 12 {
		return jsRound(CycleTotal(p, Annual) / 12 * float64(months))
	}
	if months >= 6 {
		return jsRound(CycleTotal(p, HalfYearly) / 6 * float64(months))
	}
	return CycleTotal(p, Monthly) * float64(months)
}

func CycleForMonths(months int) Cycle {
	if months >= 12 {
		return Annual
	}
	if months >= 6 {
		return HalfYearly
	}
	return Monthly
}

func MonthsLabel(c Catalog, months int) string {
	switch months {
	case 1:
		return c.CycleLabels.Monthly
	case 6:
		return c.CycleLabels.HalfYearly
	case 12:
		return c.CycleLabels.Annual
	}
	return fmt.Sprintf("%d months", months)
}

func MonthlyRateFor(p Plan, c Cycle) float64 {
	return jsRound(CycleTotal(p, c) / float64(CycleMonths(c)))
}

// ListMonthlyOf is the price outside an event.
func ListMonthlyOf(p Plan) float64 {
	if p.ListMonthly != nil {
		return *p.ListMonthly
	}
	return p.Monthly
}

func SavingFor(p Plan, c Cycle) float64 {
	return ListMonthlyOf(p)*float64(CycleMonths(c)) - CycleTotal(p, c)
}

// EventRuns is whether the catalogue is in event mode and period is inside its window.
func EventRuns(c Catalog, period string) bool {
	return c.Event.Mode == "event" && c.Event.EndsOn != "" && period <= c.Event.EndsOn
}

func eventPercent(p Plan) float64 { return math.Min(90, math.Max(0, p.EventDiscountPercent)) }

// SellingPlan is a plan at its offer price: the event discount instead of the cycle discounts.
func SellingPlan(p Plan) Plan {
	percent := eventPercent(p)
	if percent <= 0 {
		return p
	}
	list := p.Monthly
	p.AnnualDiscountPercent, p.HalfYearlyDiscountPercent = 0, 0
	p.ListMonthly = &list
	p.Monthly = jsRound(list * (1 - percent/100))
	return p
}

// SellingCatalog is the catalogue as sold in period.
func SellingCatalog(c Catalog, period string) Catalog {
	if !EventRuns(c, period) {
		return c
	}
	sold := make([]Plan, len(c.Plans))
	for i, p := range c.Plans {
		sold[i] = SellingPlan(p)
	}
	c.Plans = sold
	return c
}

func maxOver(c Catalog, f func(Plan) float64) float64 {
	best := 0.0
	for _, p := range c.Plans {
		best = math.Max(best, f(p))
	}
	return best
}

func BestEventPercent(c Catalog) float64 {
	return maxOver(c, func(p Plan) float64 {
		if p.ListMonthly == nil || *p.ListMonthly == 0 {
			return 0
		}
		return eventPercent(p)
	})
}

func BestDiscountPercent(c Catalog, cycle Cycle) float64 {
	return maxOver(c, func(p Plan) float64 { return DiscountPercent(p, cycle) })
}

func BestSaving(c Catalog, cycle Cycle) float64 {
	return maxOver(c, func(p Plan) float64 { return SavingFor(p, cycle) })
}

func GetPlan(c Catalog, id string) *Plan {
	if i := PlanRank(c, id); i >= 0 {
		return &c.Plans[i]
	}
	return nil
}

func GetServiceModule(c Catalog, id string) *Module {
	if i := slices.IndexFunc(c.Modules, func(m Module) bool { return m.ID == id }); i >= 0 {
		return &c.Modules[i]
	}
	return nil
}

func GetService(c Catalog, slug string) *Service {
	if i := slices.IndexFunc(c.Services, func(s Service) bool { return s.Slug == slug }); i >= 0 {
		return &c.Services[i]
	}
	return nil
}

// PlanRank is cheapest-first; -1 when absent.
func PlanRank(c Catalog, id string) int {
	return slices.IndexFunc(c.Plans, func(p Plan) bool { return p.ID == id })
}

// PlanBelow is the plan one step cheaper, or nil on the entry plan.
func PlanBelow(c Catalog, id string) *Plan {
	if rank := PlanRank(c, id); rank > 0 {
		return &c.Plans[rank-1]
	}
	return nil
}

// PlanIncludes: an unknown service tier is carried by none, never read as free.
func PlanIncludes(c Catalog, planID string, s Service) bool {
	rank := PlanRank(c, s.Plan)
	return rank >= 0 && rank <= PlanRank(c, planID)
}

func NewServicesForPlan(c Catalog, planID string) []Service {
	out := []Service{}
	for _, s := range c.Services {
		if s.Plan == planID {
			out = append(out, s)
		}
	}
	return out
}

// namedByASeatLine are services a card's seat lines already name.
var namedByASeatLine = []string{"cook-portal", "warden-roles"}

func CardServicesForPlan(c Catalog, planID string) []Service {
	return slices.DeleteFunc(NewServicesForPlan(c, planID), func(s Service) bool {
		return slices.Contains(namedByASeatLine, s.Slug)
	})
}

func capLabel(capacity, capBelow *int, plural, singular string) string {
	if capacity != nil && *capacity == 1 {
		return "1 " + singular
	}
	if capacity != nil {
		return "Up to " + money.GroupIN(int64(*capacity)) + " " + plural
	}
	if capBelow == nil {
		return "Unlimited " + plural
	}
	return "More than " + money.GroupIN(int64(*capBelow)) + " " + plural
}

func ResidentRangeLabel(c Catalog, p Plan) string {
	var below *int
	if b := PlanBelow(c, p.ID); b != nil {
		below = b.MaxResidents
	}
	return capLabel(p.MaxResidents, below, "residents", "resident")
}

// AccessLine is one seat line on a plan card; Slug is nil when that service was removed.
type AccessLine struct {
	ID    string  `json:"id"`
	Label string  `json:"label"`
	Slug  *string `json:"slug"`
}

func PortalAccessLines(c Catalog, p Plan) []AccessLine {
	var below PortalAccess
	var belowResidents *int
	if b := PlanBelow(c, p.ID); b != nil {
		below, belowResidents = b.PortalAccess, b.MaxResidents
	}
	linkTo := func(slug string) *string {
		if GetService(c, slug) == nil {
			return nil
		}
		return &slug
	}
	lines := []AccessLine{
		{"resident", capLabel(p.MaxResidents, belowResidents, "resident portal accounts", "resident portal account"), linkTo("resident-directory")},
		{"warden", capLabel(p.PortalAccess.Wardens, below.Wardens, "warden portal accounts", "warden portal account"), linkTo("warden-roles")},
		{"cook", capLabel(p.PortalAccess.Cooks, below.Cooks, "cook portal accounts", "cook portal account"), linkTo("cook-portal")},
	}
	if p.MaxBranches > 0 {
		lines = append(lines, AccessLine{"branch", "Add branches of your hostel", linkTo("multi-property-control")})
	}
	return lines
}

type ModuleServices struct {
	Module   Module
	Services []Service
}

func ServicesByModule(c Catalog) []ModuleServices {
	out := make([]ModuleServices, len(c.Modules))
	for i, m := range c.Modules {
		out[i].Module = m
		out[i].Services = []Service{}
		for _, s := range c.Services {
			if s.Module == m.ID {
				out[i].Services = append(out[i].Services, s)
			}
		}
	}
	return out
}

func OrphanedServices(c Catalog) []Service {
	out := []Service{}
	for _, s := range c.Services {
		if GetServiceModule(c, s.Module) == nil {
			out = append(out, s)
		}
	}
	return out
}

type TierEntry struct {
	Plan Plan
	Tier ListingTier
}

func ListingTiers(c Catalog) []TierEntry {
	out := []TierEntry{}
	for _, p := range c.Plans {
		if p.ListingTier != nil {
			out = append(out, TierEntry{p, *p.ListingTier})
		}
	}
	return out
}

func GetListingTier(c Catalog, slug string) *TierEntry {
	for _, e := range ListingTiers(c) {
		if e.Tier.Slug == slug {
			return &e
		}
	}
	return nil
}

func ListingTierHref(slug string) string { return "/plans-pricing/badge/" + slug }

func ServiceHref(slug string) string { return "/plans-pricing/" + slug }
