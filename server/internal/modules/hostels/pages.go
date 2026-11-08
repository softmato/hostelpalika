package hostels

import (
	"context"
	"regexp"
	"slices"
	"strings"
	"unicode"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"golang.org/x/sync/errgroup"
	"golang.org/x/text/unicode/norm"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/zschema"
)

// The reads behind the web's server-rendered public pages (PARITY §9): the
// sitemap, the /hostels/in index and the /hostels/near pages. Same visibility
// gate as the listing.

func (h *Handler) sitemap(c *gin.Context) {
	out, err := h.public.Sitemap(c, c.Query("slug"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.PublicCache(c)
	httpx.OK(c, out, "Published hostels loaded")
}

func (h *Handler) locations(c *gin.Context) {
	out, err := h.public.Locations(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.PublicCache(c)
	httpx.OK(c, out, "Hostel locations loaded")
}

func (h *Handler) near(c *gin.Context) {
	out, err := h.public.Near(c, c.Query("place"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.PublicCache(c)
	httpx.OK(c, out, "Nearby places loaded")
}

// Sitemap is listPublishedHostelSlugs with each hostel's first ten photos as
// absolute public media URLs; `slug` narrows it to one hostel.
func (p *Public) Sitemap(ctx context.Context, slug string) (ordered.Map, error) {
	filter := visible()
	if slug != "" {
		filter = visible(bson.E{Key: "slug", Value: slug})
	}
	rows, err := p.find(ctx, filter, options.Find().SetSort(bson.D{{Key: "updatedAt", Value: -1}}).SetLimit(5000).
		SetProjection(bson.D{{Key: "slug", Value: 1}, {Key: "updatedAt", Value: 1}, {Key: "photos.url", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var all []string
	photos := make([][]string, len(rows))
	for i, h := range rows {
		for _, ph := range h.docs("photos") {
			if u := ph.str("url"); u != "" && len(photos[i]) < 10 {
				photos[i] = append(photos[i], u)
			}
		}
		all = append(all, photos[i]...)
	}
	resolved, err := p.searchImages(ctx, all)
	if err != nil {
		return nil, err
	}
	out := []any{}
	for i, h := range rows {
		if h.str("slug") == "" {
			continue
		}
		images := []any{}
		for _, u := range photos[i] {
			if abs, ok := resolved[u]; ok {
				images = append(images, abs)
			}
		}
		out = append(out, ordered.Map{
			{Key: "images", Value: images},
			{Key: "slug", Value: h.str("slug")},
			{Key: "updatedAt", Value: ordered.FromBSON(h.val("updatedAt"))},
		})
	}
	return ordered.Map{{Key: "hostels", Value: out}}, nil
}

var fileRoute = regexp.MustCompile(`(?i)^/api/v1/files/([a-f0-9]{24})/url(?:\?.*)?$`)

// searchImages is resolveSearchImageUrls: a stored `/api/v1/files/<id>/url`
// photo becomes its PUBLIC, ACTIVE asset's media URL (the LARGE rendition when
// there is one); an https URL passes through; anything else is left out.
func (p *Public) searchImages(ctx context.Context, urls []string) (map[string]string, error) {
	resolved := map[string]string{}
	byAsset := map[bson.ObjectID][]string{}
	for _, u := range urls {
		if strings.HasPrefix(strings.ToLower(u), "https://") {
			resolved[u] = u
			continue
		}
		if m := fileRoute.FindStringSubmatch(zschema.JSTrim(u)); m != nil {
			if id, err := bson.ObjectIDFromHex(strings.ToLower(m[1])); err == nil {
				byAsset[id] = append(byAsset[id], u)
			}
		}
	}
	base := strings.TrimRight(p.MediaURL, "/")
	if len(byAsset) == 0 || base == "" {
		return resolved, nil
	}
	ids := make([]bson.ObjectID, 0, len(byAsset))
	for id := range byAsset {
		ids = append(ids, id)
	}
	cur, err := p.db.Collection("fileassets").Find(ctx, bson.D{
		{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}},
		{Key: "accessLevel", Value: "PUBLIC"},
		{Key: "isDeleted", Value: false},
		{Key: "status", Value: "ACTIVE"},
	}, options.Find().SetProjection(bson.D{{Key: "key", Value: 1}, {Key: "variants", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var assets []struct {
		ID       bson.ObjectID `bson:"_id"`
		Key      string        `bson:"key"`
		Variants []struct {
			Key     string `bson:"key"`
			Variant string `bson:"variant"`
		} `bson:"variants"`
	}
	if err := cur.All(ctx, &assets); err != nil {
		return nil, err
	}
	for _, a := range assets {
		key := a.Key
		for _, v := range a.Variants {
			if v.Variant == "LARGE" {
				key = v.Key
				break
			}
		}
		for _, u := range byAsset[a.ID] {
			resolved[u] = base + "/" + strings.TrimLeft(key, "/")
		}
	}
	return resolved, nil
}

// Locations is listPublicHostelLocations: published hostels counted by city,
// area and type. Sorted, so the answer does not depend on $group's order.
func (p *Public) Locations(ctx context.Context) (ordered.Map, error) {
	cur, err := p.db.Collection("hostels").Aggregate(ctx, bson.A{
		bson.D{{Key: "$match", Value: visible()}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: bson.D{{Key: "area", Value: "$location.area"}, {Key: "city", Value: "$location.city"}, {Key: "type", Value: "$hostelType"}}},
			{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
			{Key: "updatedAt", Value: bson.D{{Key: "$max", Value: "$updatedAt"}}},
		}}},
		bson.D{{Key: "$sort", Value: bson.D{{Key: "_id.city", Value: 1}, {Key: "_id.area", Value: 1}, {Key: "_id.type", Value: 1}}}},
	})
	if err != nil {
		return nil, err
	}
	var rows []bson.Raw
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := []any{}
	for _, r := range rows {
		h := hostelDoc{r}
		hostelType := h.str("_id", "type")
		if hostelType == "" {
			hostelType = "CO_LIVING"
		}
		out = append(out, ordered.Map{
			{Key: "area", Value: zschema.JSTrim(h.str("_id", "area"))},
			{Key: "city", Value: zschema.JSTrim(h.str("_id", "city"))},
			{Key: "count", Value: h.num("count")},
			{Key: "hostelType", Value: hostelType},
			{Key: "updatedAt", Value: ordered.FromBSON(h.val("updatedAt"))},
		})
	}
	return ordered.Map{{Key: "locations", Value: out}}, nil
}

// NearRadiusMeters is NEAR_RADIUS_METERS: the radius the nearby-places refresh searches.
const NearRadiusMeters = 1500

var (
	campusName = regexp.MustCompile(`(?i)\b(campus|college|university|institute|vidyapith|vidhyapith|vidyapeeth)\b`)
	schoolOnly = regexp.MustCompile(`(?i)\b(school|montessori|kindergarten|pre-?school|boarding)\b`)
	collegeish = regexp.MustCompile(`(?i)\b(college|campus)\b`)
)

// isCampusName: "… Secondary School and College" is a college; "… Boarding School" is not.
func isCampusName(name string) bool {
	clean := zschema.JSTrim(name)
	if len([]rune(clean)) < 4 || !campusName.MatchString(clean) {
		return false
	}
	return !schoolOnly.MatchString(clean) || collegeish.MatchString(clean)
}

// locationSlug is lib/hostel-locations.ts locationSlug: accents dropped, "&" read as "and".
func locationSlug(v string) string {
	var b strings.Builder
	for _, r := range norm.NFKD.String(v) {
		if !unicode.Is(unicode.Mn, r) {
			b.WriteRune(r)
		}
	}
	return Slugify(strings.ReplaceAll(strings.ToLower(b.String()), "&", " and "))
}

// mostCommon: most frequent first, ties alphabetical, blanks dropped.
func mostCommon(values []string) []string {
	counts := map[string]int{}
	for _, v := range values {
		if v != "" {
			counts[v]++
		}
	}
	out := make([]string, 0, len(counts))
	for v := range counts {
		out = append(out, v)
	}
	slices.SortFunc(out, func(a, b string) int {
		if d := counts[b] - counts[a]; d != 0 {
			return d
		}
		return strings.Compare(a, b)
	})
	return out
}

type nearPlace struct {
	areas, cities, names []string
	coordinates          any
	distances            map[string]float64
	order                []string // hostel ids, first seen first
	slug                 string
}

// nearPlaces is listPublicNearbyPlaces + buildNearPlaceIndex: every campus a
// published hostel found within the radius, merged by slug, most hostels first.
// A hostel counts once per campus, at its shortest distance.
func (p *Public) nearPlaces(ctx context.Context) ([]*nearPlace, error) {
	rows, err := p.find(ctx, visible(
		bson.E{Key: "isDemoData", Value: bson.D{{Key: "$ne", Value: true}}},
		bson.E{Key: "nearbyPlaces.type", Value: "college"},
	), options.Find().SetProjection(bson.D{{Key: "location.city", Value: 1}, {Key: "location.area", Value: 1}, {Key: "nearbyPlaces", Value: 1}}))
	if err != nil {
		return nil, err
	}
	bySlug := map[string]*nearPlace{}
	var slugs []string
	for _, h := range rows {
		for _, pl := range h.docs("nearbyPlaces") {
			name := strings.Join(strings.Fields(pl.str("name")), " ")
			if pl.str("type") != "college" || !isCampusName(name) {
				continue
			}
			slug := locationSlug(name)
			dv := pl.val("distance")
			distance, isNum := dv.AsFloat64OK()
			if slug == "" || !isNum || distance < 0 || distance > NearRadiusMeters {
				continue
			}
			e := bySlug[slug]
			if e == nil {
				e = &nearPlace{distances: map[string]float64{}, slug: slug}
				bySlug[slug] = e
				slugs = append(slugs, slug)
			}
			e.names = append(e.names, name)
			if city := zschema.JSTrim(h.str("location", "city")); city != "" {
				e.cities = append(e.cities, city)
			}
			if area := zschema.JSTrim(h.str("location", "area")); area != "" {
				e.areas = append(e.areas, area)
			}
			lat, lng := pl.val("coordinates", "lat"), pl.val("coordinates", "lng")
			if e.coordinates == nil && !nullish(lat) && !nullish(lng) {
				e.coordinates = ordered.Map{{Key: "lat", Value: ordered.FromBSON(lat)}, {Key: "lng", Value: ordered.FromBSON(lng)}}
			}
			id := h.id()
			prev, seen := e.distances[id]
			if !seen {
				e.order = append(e.order, id)
			}
			if !seen || distance < prev {
				e.distances[id] = float64(jsRound(distance))
			}
		}
	}
	out := make([]*nearPlace, 0, len(slugs))
	for _, s := range slugs {
		out = append(out, bySlug[s])
	}
	slices.SortStableFunc(out, func(a, b *nearPlace) int {
		if d := len(b.distances) - len(a.distances); d != 0 {
			return d
		}
		return strings.Compare(a.name(), b.name())
	})
	return out, nil
}

func (e *nearPlace) name() string {
	if n := mostCommon(e.names); len(n) > 0 {
		return n[0]
	}
	return e.slug
}

// Near is listPublicHostelsNearAll, or listPublicHostelsNear for one `place`
// (an empty list when nothing is near it): each campus with its published
// hostels, badge first, then nearest.
func (p *Public) Near(ctx context.Context, place string) (ordered.Map, error) {
	places, err := p.nearPlaces(ctx)
	if err != nil {
		return nil, err
	}
	if place != "" {
		places = slices.DeleteFunc(places, func(e *nearPlace) bool { return e.slug != place })
	}
	var ids []bson.ObjectID
	seen := map[string]bool{}
	for _, e := range places {
		for _, id := range e.order {
			if oid, err := bson.ObjectIDFromHex(id); err == nil && !seen[id] {
				seen[id] = true
				ids = append(ids, oid)
			}
		}
	}
	var (
		found   []hostelDoc
		tiers   map[string]*Tier
		ratings map[string]ordered.Map
	)
	if len(ids) > 0 {
		g, gctx := errgroup.WithContext(ctx)
		g.Go(func() (err error) {
			found, err = p.find(gctx, visible(bson.E{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}), options.Find().SetProjection(cardFields))
			return err
		})
		g.Go(func() error { tiers = p.listingTiers(gctx); return nil })
		if err := g.Wait(); err != nil {
			return nil, err
		}
		if ratings, err = p.ratingSummaries(ctx, ids); err != nil {
			return nil, err
		}
	}
	byID := map[string]hostelDoc{}
	for _, h := range found {
		byID[h.id()] = h
	}
	out := []any{}
	for _, e := range places {
		type row struct {
			h        hostelDoc
			tier     *Tier
			distance float64
		}
		var list []row
		for _, id := range e.order {
			if h, ok := byID[id]; ok {
				list = append(list, row{h, tierOf(h, tiers), e.distances[id]})
			}
		}
		slices.SortStableFunc(list, func(a, b row) int {
			if d := rank(b.tier) - rank(a.tier); d != 0 {
				return d
			}
			return cmpNum(a.distance, b.distance)
		})
		hostels := make([]any, len(list))
		for i, r := range list {
			hostels[i] = serializePublic(r.h).
				Set("listingTier", r.tier).
				Set("ratingSummary", publicRating(r.h.id(), ratings)).
				Set("distanceMeters", r.distance)
		}
		city := ""
		if c := mostCommon(e.cities); len(c) > 0 {
			city = c[0]
		}
		areas := mostCommon(e.areas)
		out = append(out, ordered.Map{
			{Key: "hostels", Value: hostels},
			{Key: "place", Value: ordered.Map{
				{Key: "areas", Value: areas},
				{Key: "city", Value: city},
				{Key: "coordinates", Value: e.coordinates},
				{Key: "name", Value: e.name()},
				{Key: "slug", Value: e.slug},
			}},
		})
	}
	return ordered.Map{{Key: "places", Value: out}}, nil
}
