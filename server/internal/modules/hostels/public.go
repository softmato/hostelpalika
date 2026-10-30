package hostels

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"golang.org/x/sync/errgroup"

	"github.com/softmato/hostelpalika/server/internal/modules/food"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/zschema"
)

// Public is the public read path of hostel.service.ts: the listing, a
// hostel's page and compare, with the demo listings merged in.
type Public struct {
	db  *mongo.Database
	cfg *platformconfig.Service
}

func NewPublic(db *mongo.Database, cfg *platformconfig.Service) *Public { return &Public{db, cfg} }

var errNotFound = httpx.NewError(http.StatusNotFound, "HOSTEL_NOT_FOUND", "Hostel was not found.", nil)

// visible is the gate every public read shares: published and verified.
func visible(extra ...bson.E) bson.D {
	return append(bson.D{{Key: "isDeleted", Value: false}, {Key: "status", Value: "PUBLISHED"}, {Key: "verificationStatus", Value: "VERIFIED"}}, extra...)
}

var publicPhotoOrder = map[string]int{"EXTERIOR": 0, "INTERIOR": 1, "ROOM": 2}

func arrivalGuide(h hostelDoc) any {
	note := zschema.JSTrim(h.str("arrivalGuide", "note"))
	photo := zschema.JSTrim(h.str("arrivalGuide", "photoUrl"))
	if note == "" && photo == "" {
		return nil
	}
	return ordered.Map{{Key: "note", Value: note}, {Key: "photoUrl", Value: photo}}
}

func roomConfigurations(h hostelDoc) []any {
	out := []any{}
	for _, c := range h.docs("roomConfigurations") {
		out = append(out, ordered.Map{
			{Key: "bedsPerRoom", Value: or(c.val("bedsPerRoom"), 0.0)},
			{Key: "id", Value: idOf(c.val("_id"))},
			{Key: "mealInclusion", Value: or(c.val("mealInclusion"), "Included")},
			{Key: "monthlyRent", Value: or(c.val("monthlyRent"), 0.0)},
			{Key: "rooms", Value: or(c.val("rooms"), 0.0)},
			{Key: "roomType", Value: pass(c.val("roomType"))},
			{Key: "vacantBeds", Value: or(c.val("vacantBeds"), 0.0)},
		})
	}
	return out
}

// serializePublic is serializePublicHostel: phone but never email, exterior
// photos first, nearby places only where they have coordinates.
func serializePublic(h hostelDoc) ordered.Map {
	var coordinates any
	if lat, lng := h.val("location", "lat"), h.val("location", "lng"); !nullish(lat) && !nullish(lng) {
		coordinates = ordered.Map{{Key: "lat", Value: ordered.FromBSON(lat)}, {Key: "lng", Value: ordered.FromBSON(lng)}}
	}
	nearby := []any{}
	for _, p := range h.docs("nearbyPlaces") {
		lat, lng := p.val("coordinates", "lat"), p.val("coordinates", "lng")
		if nullish(lat) || nullish(lng) {
			continue
		}
		nearby = append(nearby, ordered.Map{
			{Key: "coordinates", Value: ordered.Map{{Key: "lat", Value: ordered.FromBSON(lat)}, {Key: "lng", Value: ordered.FromBSON(lng)}}},
			{Key: "distance", Value: or(p.val("distance"), 0.0)},
			{Key: "name", Value: or(p.val("name"), "")},
			{Key: "type", Value: or(p.val("type"), "other")},
		})
	}
	photos := h.docs("photos")
	kind := func(p hostelDoc) string {
		if k := p.val("kind"); !nullish(k) {
			s, _ := k.StringValueOK()
			return s
		}
		return "INTERIOR"
	}
	slices.SortStableFunc(photos, func(a, b hostelDoc) int { return publicPhotoOrder[kind(a)] - publicPhotoOrder[kind(b)] })
	photoList := []any{}
	for _, p := range photos {
		photoList = append(photoList, ordered.Map{
			{Key: "alt", Value: or(p.val("alt"), "")},
			{Key: "id", Value: idOf(p.val("_id"))},
			{Key: "kind", Value: or(p.val("kind"), "INTERIOR")},
			{Key: "mediumUrl", Value: or(p.val("mediumUrl"), "")},
			{Key: "roomType", Value: or(p.val("roomType"), "")},
			{Key: "url", Value: or(p.val("url"), "")},
		})
	}
	return ordered.Map{
		{Key: "arrivalGuide", Value: arrivalGuide(h)},
		{Key: "capacitySummary", Value: or(h.val("capacitySummary"), ordered.Map{})},
		{Key: "contact", Value: ordered.Map{{Key: "phone", Value: or(h.val("contact", "phone"), "")}}},
		{Key: "demoDataLabel", Value: or(h.val("demoDataLabel"), "")},
		{Key: "description", Value: or(h.val("description"), "")},
		{Key: "facilities", Value: or(h.val("facilities"), []any{})},
		{Key: "food", Value: or(h.val("food"), ordered.Map{})},
		{Key: "hostelType", Value: or(h.val("hostelType"), "CO_LIVING")},
		{Key: "coordinates", Value: coordinates},
		{Key: "id", Value: h.id()},
		{Key: "isDemoData", Value: zschema.Truthy(ordered.FromBSON(h.val("isDemoData")))},
		{Key: "location", Value: pass(h.val("location"))},
		{Key: "name", Value: pass(h.val("name"))},
		{Key: "nearbyPlaces", Value: nearby},
		{Key: "photos", Value: photoList},
		{Key: "pricing", Value: or(h.val("pricing"), ordered.Map{})},
		{Key: "roomConfigurations", Value: roomConfigurations(h)},
		{Key: "roomTypes", Value: or(h.val("roomTypes"), []any{})},
		{Key: "rules", Value: or(h.val("rules"), []any{})},
		{Key: "slug", Value: pass(h.val("slug"))},
		{Key: "verificationStatus", Value: pass(h.val("verificationStatus"))},
	}
}

func emptyRoutine() ordered.Map { return food.Empty() }

func (p *Public) foodRoutines(ctx context.Context, ids []bson.ObjectID) (map[string]any, error) {
	return food.Routines(ctx, p.db, ids)
}

func emptyRating() ordered.Map {
	return ordered.Map{{Key: "averageRating", Value: 0.0}, {Key: "cleanlinessRating", Value: 0.0},
		{Key: "foodRating", Value: 0.0}, {Key: "safetyRating", Value: 0.0}, {Key: "total", Value: 0.0}}
}

// ratingSummaries is ratingSummariesFor: VISIBLE reviews only, unrounded,
// one aggregation for the whole page.
func (p *Public) ratingSummaries(ctx context.Context, ids []bson.ObjectID) (map[string]ordered.Map, error) {
	out := map[string]ordered.Map{}
	if len(ids) == 0 {
		return out, nil
	}
	cur, err := p.db.Collection("ratingreviews").Aggregate(ctx, mongo.Pipeline{
		{{Key: "$match", Value: bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "status", Value: "VISIBLE"}}}},
		{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$hostelId"},
			{Key: "averageRating", Value: bson.D{{Key: "$avg", Value: "$overallRating"}}},
			{Key: "cleanlinessRating", Value: bson.D{{Key: "$avg", Value: "$cleanlinessRating"}}},
			{Key: "foodRating", Value: bson.D{{Key: "$avg", Value: "$foodRating"}}},
			{Key: "safetyRating", Value: bson.D{{Key: "$avg", Value: "$safetyRating"}}},
			{Key: "total", Value: bson.D{{Key: "$sum", Value: 1}}}}}},
	})
	if err != nil {
		return nil, err
	}
	var rows []bson.Raw
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	for _, r := range rows {
		h := hostelDoc{r}
		m := emptyRating()
		for i := range m {
			m[i].Value = or(h.val(m[i].Key), 0.0)
		}
		out[h.id()] = m
	}
	return out, nil
}

func publicRating(id string, ratings map[string]ordered.Map) ordered.Map {
	if r, ok := ratings[id]; ok {
		return r
	}
	if r := demoRating(id); r != nil {
		return r
	}
	return emptyRating()
}

// Tier is a PublicListingTier: the directory badge a paid plan carries.
type Tier struct {
	Label string `json:"label"`
	Rank  int    `json:"rank"`
	Slug  string `json:"slug"`
	Tone  string `json:"tone"`
}

// listingTiers is publicListingTiers: billing hostel id → badge, for every
// hostel paying for a badged plan right now. A failure costs the ordering,
// never the listing.
func (p *Public) listingTiers(ctx context.Context) map[string]*Tier {
	tiers := map[string]*Tier{}
	section, err := p.cfg.Section(ctx, "plans")
	if err != nil {
		return tiers
	}
	var catalog struct {
		Plans []struct {
			ID          string `json:"id"`
			ListingTier *struct {
				Label string `json:"label"`
				Slug  string `json:"slug"`
				Tone  string `json:"tone"`
			} `json:"listingTier"`
		} `json:"plans"`
	}
	if platformconfig.Decode(section, &catalog) != nil {
		return tiers
	}
	byPlan := map[string]*Tier{}
	var planIDs []string
	for i, pl := range catalog.Plans {
		if lt := pl.ListingTier; lt != nil {
			byPlan[pl.ID] = &Tier{lt.Label, i + 1, lt.Slug, lt.Tone}
			planIDs = append(planIDs, pl.ID)
		}
	}
	if len(byPlan) == 0 {
		return tiers
	}
	cur, err := p.db.Collection("hostelsubscriptions").Find(ctx, bson.D{
		{Key: "currentPeriodEnd", Value: bson.D{{Key: "$gt", Value: time.Now()}}},
		{Key: "planId", Value: bson.D{{Key: "$in", Value: planIDs}}},
		{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "PAST_DUE"}}}},
	}, options.Find().SetProjection(bson.D{{Key: "hostelId", Value: 1}, {Key: "planId", Value: 1}}))
	if err != nil {
		return map[string]*Tier{}
	}
	var rows []struct {
		HostelID bson.ObjectID `bson:"hostelId"`
		PlanID   *string       `bson:"planId"`
	}
	if cur.All(ctx, &rows) != nil {
		return map[string]*Tier{}
	}
	for _, r := range rows {
		if r.PlanID != nil && byPlan[*r.PlanID] != nil {
			tiers[r.HostelID.Hex()] = byPlan[*r.PlanID]
		}
	}
	return tiers
}

// tierOf: a branch bills to its main hostel; a sample listing never has a badge.
func tierOf(h hostelDoc, tiers map[string]*Tier) *Tier {
	if zschema.Truthy(ordered.FromBSON(h.val("isDemoData"))) {
		return nil
	}
	if t := tiers[h.id()]; t != nil {
		return t
	}
	if parent, ok := h.oid("parentHostelId"); ok {
		return tiers[parent.Hex()]
	}
	return nil
}

func rank(t *Tier) int {
	if t == nil {
		return 0
	}
	return t.Rank
}

// ListQuery is publicHostelListQuerySchema.
type ListQuery struct {
	Area, City, Facility, Food *string
	MaxPrice, MinPrice         *float64
	Q, RoomType, Stay, Type    *string
}

func (q ListQuery) facilities() []string {
	var out []string
	if q.Facility != nil {
		for _, f := range strings.Split(*q.Facility, ",") {
			if f = zschema.JSTrim(f); f != "" {
				out = append(out, f)
			}
		}
	}
	return out
}

func ci(pattern string) bson.Regex { return bson.Regex{Pattern: pattern, Options: "i"} }

func (q ListQuery) filter() bson.D {
	f := visible()
	if q.Q != nil {
		re := ci(regexp.QuoteMeta(*q.Q))
		f = append(f, bson.E{Key: "$or", Value: bson.A{bson.D{{Key: "name", Value: re}}, bson.D{{Key: "location.area", Value: re}}}})
	}
	if q.Area != nil {
		f = append(f, bson.E{Key: "location.area", Value: ci(regexp.QuoteMeta(*q.Area))})
	}
	if q.City != nil {
		f = append(f, bson.E{Key: "location.city", Value: ci("^" + regexp.QuoteMeta(*q.City) + "$")})
	}
	if q.Type != nil {
		f = append(f, bson.E{Key: "hostelType", Value: *q.Type})
	}
	switch list := q.facilities(); {
	case len(list) == 1:
		f = append(f, bson.E{Key: "facilities", Value: list[0]})
	case len(list) > 1:
		f = append(f, bson.E{Key: "facilities", Value: bson.D{{Key: "$all", Value: list}}})
	}
	if q.Food != nil && *q.Food == "veg" {
		f = append(f, bson.E{Key: "food.hasVeg", Value: true})
	}
	if q.Food != nil && *q.Food == "non-veg" {
		f = append(f, bson.E{Key: "food.hasNonVeg", Value: true})
	}
	if q.RoomType != nil {
		f = append(f, bson.E{Key: "roomTypes", Value: *q.RoomType})
	}
	if q.MinPrice != nil {
		f = append(f, bson.E{Key: "pricing.monthlyRentMax", Value: bson.D{{Key: "$gte", Value: *q.MinPrice}}})
	}
	if q.MaxPrice != nil {
		f = append(f, bson.E{Key: "pricing.monthlyRentMin", Value: bson.D{{Key: "$lte", Value: *q.MaxPrice}}})
	}
	if q.Stay != nil {
		f = append(f, bson.E{Key: "shortStays.enabled", Value: true})
	}
	return f
}

func (p *Public) find(ctx context.Context, filter bson.D, opts ...options.Lister[options.FindOptions]) ([]hostelDoc, error) {
	cur, err := p.db.Collection("hostels").Find(ctx, filter, opts...)
	if err != nil {
		return nil, err
	}
	var rows []bson.Raw
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := make([]hostelDoc, len(rows))
	for i, r := range rows {
		out[i] = hostelDoc{r}
	}
	return out, nil
}

func ids(list []hostelDoc) []bson.ObjectID {
	out := make([]bson.ObjectID, len(list))
	for i, h := range list {
		out[i], _ = h.oid("_id")
	}
	return out
}

type listed struct {
	h    hostelDoc
	tier *Tier
}

// List is listPublicHostels: badged hostels first (read on their own, so the
// 60-row cap never pushes one off), then cheapest first, then the samples.
func (p *Public) List(ctx context.Context, q ListQuery) (ordered.Map, error) {
	filter := q.filter()
	tiers := p.listingTiers(ctx)
	var badgedIDs []bson.ObjectID
	for id := range tiers {
		oid, _ := bson.ObjectIDFromHex(id)
		badgedIDs = append(badgedIDs, oid)
	}
	var cheapest, badged []hostelDoc
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() (err error) {
		cheapest, err = p.find(gctx, filter, options.Find().
			SetSort(bson.D{{Key: "pricing.monthlyRentMin", Value: 1}, {Key: "createdAt", Value: -1}}).SetLimit(60))
		return err
	})
	if len(badgedIDs) > 0 {
		g.Go(func() (err error) {
			bf := append(append(bson.D{}, filter...), bson.E{Key: "$and", Value: bson.A{bson.D{{Key: "$or", Value: bson.A{
				bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: badgedIDs}}}},
				bson.D{{Key: "parentHostelId", Value: bson.D{{Key: "$in", Value: badgedIDs}}}},
			}}}}})
			badged, err = p.find(gctx, bf, options.Find().SetLimit(60))
			return err
		})
	}
	if err := g.Wait(); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var found []listed
	for _, h := range append(badged, cheapest...) {
		if id := h.id(); !seen[id] {
			seen[id] = true
			found = append(found, listed{h, tierOf(h, tiers)})
		}
	}
	slices.SortStableFunc(found, func(a, b listed) int {
		if d := rank(b.tier) - rank(a.tier); d != 0 {
			return d
		}
		return cmpNum(a.h.num("pricing", "monthlyRentMin"), b.h.num("pricing", "monthlyRentMin"))
	})
	docs := make([]hostelDoc, len(found))
	for i, f := range found {
		docs[i] = f.h
	}
	ratings, err := p.ratingSummaries(ctx, ids(docs))
	if err != nil {
		return nil, err
	}
	var demos []demoHostel
	for _, d := range demoHostels {
		if d.matches(q) {
			demos = append(demos, d)
		}
	}
	slices.SortStableFunc(demos, func(a, b demoHostel) int { return cmpNum(a.rentMin, b.rentMin) })
	for _, d := range demos {
		found = append(found, listed{hostelDoc{d.raw}, nil})
	}
	out := make([]any, len(found))
	for i, f := range found {
		out[i] = serializePublic(f.h).
			Set("listingTier", f.tier).
			Set("ratingSummary", publicRating(f.h.id(), ratings))
	}
	return ordered.Map{{Key: "hostels", Value: out}}, nil
}

func cmpNum(a, b float64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// BySlug is getPublicHostelBySlug; a sample listing is found by slug or id.
func (p *Public) BySlug(ctx context.Context, slug string) (ordered.Map, error) {
	var raw bson.Raw
	err := p.db.Collection("hostels").FindOne(ctx, visible(bson.E{Key: "slug", Value: slug})).Decode(&raw)
	if errors.Is(err, mongo.ErrNoDocuments) {
		if d := findDemoHostel(slug); d != nil {
			h := hostelDoc{d.raw}
			return ordered.Map{{Key: "hostel", Value: serializePublic(h).
				Set("listingTier", nil).
				Set("otherBranches", []any{}).
				Set("foodRoutine", emptyRoutine()).
				Set("ratingSummary", publicRating(d.id, nil))}}, nil
		}
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	h := hostelDoc{raw}
	id, _ := h.oid("_id")
	var (
		routines map[string]any
		ratings  map[string]ordered.Map
		branches []PublicBranch
		tier     *Tier
	)
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() (err error) { routines, err = p.foodRoutines(gctx, []bson.ObjectID{id}); return })
	g.Go(func() (err error) { ratings, err = p.ratingSummaries(gctx, []bson.ObjectID{id}); return })
	g.Go(func() (err error) { branches, err = p.siblingBranches(gctx, h); return })
	g.Go(func() error { tier = tierOf(h, p.listingTiers(gctx)); return nil })
	if err := g.Wait(); err != nil {
		return nil, err
	}
	routine, ok := routines[id.Hex()]
	if !ok {
		routine = emptyRoutine()
	}
	rating, ok := ratings[id.Hex()]
	if !ok {
		rating = emptyRating()
	}
	return ordered.Map{{Key: "hostel", Value: serializePublic(h).
		Set("listingTier", tier).
		Set("otherBranches", branches).
		Set("foodRoutine", routine).
		Set("ratingSummary", rating)}}, nil
}

// PublicBranch is packages/shared/src/types/public-branch.ts.
type PublicBranch struct {
	ID       string  `json:"id"`
	Name     any     `json:"name"`
	Slug     string  `json:"slug"`
	Area     any     `json:"area"`
	City     any     `json:"city"`
	PhotoURL *string `json:"photoUrl"`
}

// siblingBranches is listPublicSiblingBranches: family membership is explicit
// (same owner, same root), never inferred.
func (p *Public) siblingBranches(ctx context.Context, h hostelDoc) ([]PublicBranch, error) {
	out := []PublicBranch{}
	owner, ok := h.oid("ownerId")
	if !ok {
		return out, nil
	}
	self, _ := h.oid("_id")
	root := self
	if parent, ok := h.oid("parentHostelId"); ok {
		root = parent
	}
	rows, err := p.find(ctx, visible(
		bson.E{Key: "_id", Value: bson.D{{Key: "$ne", Value: self}}},
		bson.E{Key: "ownerId", Value: owner},
		bson.E{Key: "$or", Value: bson.A{bson.D{{Key: "_id", Value: root}}, bson.D{{Key: "parentHostelId", Value: root}}}},
	), options.Find().
		SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "slug", Value: 1}, {Key: "location.area", Value: 1}, {Key: "location.city", Value: 1}, {Key: "photos", Value: 1}}).
		SetSort(bson.D{{Key: "name", Value: 1}, {Key: "_id", Value: 1}}).SetLimit(60))
	if err != nil {
		return nil, err
	}
	for _, b := range rows {
		slug := b.str("slug")
		if slug == "" {
			continue
		}
		out = append(out, PublicBranch{ID: b.id(), Name: pass(b.val("name")), Slug: slug,
			Area: or(b.val("location", "area"), ""), City: or(b.val("location", "city"), ""), PhotoURL: firstPhotoURL(b, "EXTERIOR")})
	}
	return out, nil
}

var photoFallback = map[string][]string{
	"EXTERIOR": {"EXTERIOR", "INTERIOR", "ROOM"},
	"INTERIOR": {"INTERIOR", "EXTERIOR", "ROOM"},
	"ROOM":     {"ROOM", "INTERIOR", "EXTERIOR"},
}

// firstPhotoURL is resolveHostelPhotoUrls(photos, surface)[0] ?? null.
func firstPhotoURL(h hostelDoc, surface string) *string {
	photos := h.docs("photos")
	for _, kind := range photoFallback[surface] {
		for _, p := range photos {
			k := p.str("kind")
			if k != "EXTERIOR" && k != "ROOM" {
				k = "INTERIOR"
			}
			if url := p.str("url"); url != "" && k == kind {
				return &url
			}
		}
	}
	return nil
}

// CompareQuery holds the ids, already split, trimmed and checked as ObjectIds.
func (p *Public) Compare(ctx context.Context, idList []string) (ordered.Map, error) {
	hostelIDs := make([]bson.ObjectID, len(idList))
	for i, s := range idList {
		hostelIDs[i], _ = bson.ObjectIDFromHex(s)
	}
	found, err := p.find(ctx, visible(bson.E{Key: "_id", Value: bson.D{{Key: "$in", Value: hostelIDs}}}))
	if err != nil {
		return nil, err
	}
	for _, s := range idList {
		if d := findDemoHostel(s); d != nil {
			found = append(found, hostelDoc{d.raw})
		}
	}
	if len(found) != len(hostelIDs) {
		return nil, httpx.NewError(http.StatusNotFound, "PUBLIC_HOSTEL_COMPARE_NOT_FOUND", "One or more hostels are not available for public comparison.", nil)
	}
	var (
		ratings  map[string]ordered.Map
		routines map[string]any
	)
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() (err error) { ratings, err = p.ratingSummaries(gctx, hostelIDs); return })
	g.Go(func() (err error) { routines, err = p.foodRoutines(gctx, hostelIDs); return })
	if err := g.Wait(); err != nil {
		return nil, err
	}
	byID := map[string]hostelDoc{}
	for _, h := range found {
		byID[h.id()] = h
	}
	out := []any{}
	for _, s := range idList {
		h, ok := byID[s]
		if !ok {
			continue
		}
		rating := publicRating(s, ratings)
		rv := func(k string) any { v, _ := rating.Get(k); return v }
		routine, ok := routines[s]
		if !ok {
			routine = emptyRoutine()
		}
		var parts []string
		for _, k := range []string{"address", "area", "city"} {
			if v := h.str("location", k); v != "" {
				parts = append(parts, v)
			}
		}
		out = append(out, serializePublic(h).
			Set("foodRoutine", routine).
			Set("ratingSummary", rating).
			Set("comparison", ordered.Map{
				{Key: "facilities", Value: or(h.val("facilities"), []any{})},
				{Key: "foodScore", Value: rv("foodRating")},
				{Key: "locationText", Value: strings.Join(parts, ", ")},
				{Key: "monthlyFee", Value: ordered.Map{
					{Key: "currency", Value: or(h.val("pricing", "currency"), "NPR")},
					{Key: "max", Value: or(h.val("pricing", "monthlyRentMax"), 0.0)},
					{Key: "min", Value: or(h.val("pricing", "monthlyRentMin"), 0.0)},
				}},
				{Key: "ratingSummary", Value: ordered.Map{
					{Key: "averageRating", Value: rv("averageRating")},
					{Key: "cleanlinessRating", Value: rv("cleanlinessRating")},
					{Key: "safetyRating", Value: rv("safetyRating")},
					{Key: "total", Value: rv("total")},
				}},
				{Key: "roomTypes", Value: or(h.val("roomTypes"), []any{})},
				{Key: "vacancy", Value: or(h.val("capacitySummary", "vacantBeds"), 0.0)},
				{Key: "verificationStatus", Value: pass(h.val("verificationStatus"))},
			}))
	}
	return ordered.Map{{Key: "hostels", Value: out}}, nil
}
