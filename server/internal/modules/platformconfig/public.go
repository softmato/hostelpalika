package platformconfig

import (
	"context"
	"math"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/plans"
)

// SellingCatalog is sellingCatalog over the stored plans section: during a
// running event each plan carries its offer price and keeps the list price in
// `listMonthly`, keys placed as the TS spread places them.
func SellingCatalog(catalog any, period string) any {
	c, ok := catalog.(ordered.Map)
	if !ok {
		return catalog
	}
	event, _ := c.Get("event")
	ev, _ := event.(ordered.Map)
	mode, endsOn := "standard", ""
	if v, ok := ev.Get("mode"); ok {
		mode, _ = v.(string)
	}
	if v, ok := ev.Get("endsOn"); ok {
		endsOn, _ = v.(string)
	}
	if mode != "event" || endsOn == "" || period > endsOn {
		return c
	}
	list, _ := c.Get("plans")
	sold := []any{}
	for _, p := range list.([]any) {
		plan := p.(ordered.Map)
		pct, _ := plan.Get("eventDiscountPercent")
		percent := math.Min(90, math.Max(0, num(pct)))
		if percent > 0 {
			monthly, _ := plan.Get("monthly")
			m := num(monthly)
			plan = append(ordered.Map{}, plan...).
				Set("annualDiscountPercent", 0.0).
				Set("halfYearlyDiscountPercent", 0.0).
				Set("listMonthly", m).
				Set("monthly", plans.JSRound(m*(1-percent/100)))
		}
		sold = append(sold, plan)
	}
	return append(ordered.Map{}, c...).Set("plans", sold)
}

func num(v any) float64 { f, _ := v.(float64); return f }

type PlatformStat struct {
	Label string `json:"label"`
	Value int64  `json:"value"`
}

// minPublicCount: "1 hostel on the platform" argues against itself.
const minPublicCount = 10

var stats struct {
	sync.Mutex
	at  time.Time
	out []PlatformStat
}

// PublicPlatformStats is getPublicPlatformStats, memoised per instance for
// five minutes like TS.
func PublicPlatformStats(ctx context.Context, db *mongo.Database) ([]PlatformStat, error) {
	stats.Lock()
	if stats.out != nil && time.Since(stats.at) < 5*time.Minute {
		out := stats.out
		stats.Unlock()
		return out, nil
	}
	stats.Unlock()
	count := func(coll string, f bson.D) (int64, error) { return db.Collection(coll).CountDocuments(ctx, f) }
	hostels, err := count("hostels", bson.D{{Key: "isDeleted", Value: false}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"APPROVED", "PUBLISHED"}}}}})
	if err != nil {
		return nil, err
	}
	residents, err := count("residents", bson.D{{Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}})
	if err != nil {
		return nil, err
	}
	enquiries, err := count("inquiries", bson.D{{Key: "isDeleted", Value: false}})
	if err != nil {
		return nil, err
	}
	out := []PlatformStat{}
	for _, s := range []PlatformStat{{"Hostels on the platform", hostels}, {"Residents living in them", residents}, {"Enquiries sent to hostels", enquiries}} {
		if s.Value >= minPublicCount {
			out = append(out, s)
		}
	}
	stats.Lock()
	stats.out, stats.at = out, time.Now()
	stats.Unlock()
	return out, nil
}

type leaveHold struct {
	Max float64 `json:"max"`
	Min float64 `json:"min"`
}

// Public is getPublicSiteConfig: the projection every page reads. `email` is
// absent on purpose (deployment plumbing, not website content).
func (s *Service) Public(ctx context.Context) (ordered.Map, error) {
	config, err := s.SiteConfig(ctx)
	if err != nil {
		return nil, err
	}
	ops := s.Operations(ctx)
	get := func(k string) any { v, _ := config.Get(k); return v }
	filterEnabled := func(k string) any {
		out := []any{}
		for _, e := range get(k).([]any) {
			if en, _ := e.(ordered.Map).Get("enabled"); en == true {
				out = append(out, e)
			}
		}
		return out
	}
	var appNotice any
	if n := get("appNotice").(ordered.Map); n != nil {
		if en, _ := n.Get("enabled"); en == true {
			appNotice = n
		}
	}
	var platformStats any = []PlatformStat{}
	if st, err := PublicPlatformStats(ctx, s.db); err == nil {
		platformStats = st
	}
	minDays, _ := ops.Get("leaveHoldMinDays")
	maxDays, _ := ops.Get("leaveHoldMaxDays")
	period, err := bs.CurrentPeriod(time.Now())
	if err != nil {
		return nil, err
	}
	return ordered.Map{
		{Key: "announcement", Value: get("announcement")},
		{Key: "appNotice", Value: appNotice},
		{Key: "apps", Value: get("apps")},
		{Key: "content", Value: get("content")},
		{Key: "facilities", Value: filterEnabled("facilities")},
		{Key: "platformStats", Value: platformStats},
		{Key: "features", Value: get("features")},
		{Key: "hero", Value: get("hero")},
		{Key: "identity", Value: get("identity")},
		{Key: "legal", Value: get("legal")},
		{Key: "lifetime", Value: get("lifetime")},
		{Key: "leaveHold", Value: leaveHold{Max: num(maxDays), Min: num(minDays)}},
		{Key: "locations", Value: filterEnabled("locations")},
		{Key: "plans", Value: SellingCatalog(get("plans"), period)},
		{Key: "questionCall", Value: get("questionCall")},
		{Key: "seo", Value: get("seo")},
		{Key: "social", Value: get("social")},
		{Key: "stats", Value: get("stats")},
		{Key: "trustPoints", Value: get("trustPoints")},
	}, nil
}
