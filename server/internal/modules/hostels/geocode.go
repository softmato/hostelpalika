package hostels

import (
	"context"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/maps"
	"github.com/softmato/hostelpalika/server/internal/platform/ratelimit"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// GeocodeQuery is hostelAdminGeocodeQuerySchema, parsed.
type GeocodeQuery struct {
	Lat, Lng *float64
	Limit    int
	Near     string
	Q        string
}

// ParseGeocodeQuery reads the schema from the query string: lat/lng/limit are
// z.coerce.number() (so "" is 0), q and near are trimmed strings, and one of
// q or the lat/lng pair is required.
func ParseGeocodeQuery(q map[string]string) (GeocodeQuery, error) {
	var is valid.Issues
	var out GeocodeQuery
	aborted := false // a type issue stops the object's .refine from running
	num := func(key string, min, max float64) *float64 {
		raw, ok := q[key]
		if !ok {
			return nil
		}
		f := valid.JSNumber(raw)
		switch {
		case math.IsNaN(f):
			is.Add(key, valid.Type("number", "NaN"))
			aborted = true
			return nil
		case math.IsInf(f, 0):
			is.Add(key, valid.Type("number", "Infinity"))
			aborted = true
			return nil
		case f < min:
			is.Add(key, valid.TooSmall("number", min, true))
		case f > max:
			is.Add(key, valid.TooBig("number", max, true))
		}
		return &f
	}
	out.Lat = num("lat", -90, 90)
	out.Limit = 5
	if raw, ok := q["limit"]; ok {
		f := valid.JSNumber(raw)
		switch {
		case math.IsNaN(f):
			is.Add("limit", valid.Type("number", "NaN"))
			aborted = true
		case f != math.Trunc(f):
			is.Add("limit", valid.Type("int", "number"))
			aborted = true
		case f < 1:
			is.Add("limit", valid.TooSmall("number", 1, true))
		case f > 8:
			is.Add("limit", valid.TooBig("number", 8, true))
		default:
			out.Limit = int(f)
		}
	}
	out.Lng = num("lng", -180, 180)
	if s := valid.QueryString(q, "near", 0, 200, &is); s != nil {
		out.Near = *s
	}
	if s := valid.QueryString(q, "q", 2, 2000, &is); s != nil {
		out.Q = *s
	}
	// An over-short q still counts as given: the check failed, the value passed.
	qGiven := valid.Trim(q["q"]) != ""
	if !aborted && !qGiven && (out.Lat == nil || out.Lng == nil) {
		is.Add("q", "Provide a search query, or a lat/lng pair to look up.")
	}
	return out, is.Err()
}

type GeocodeResults struct {
	Results []maps.GeocodeResult `json:"results"`
}

// Geocoder is hostel-geocode.service.ts: the one location lookup every map
// picker shares, in both directions.
type Geocoder struct{ Maps *maps.Client }

func (g *Geocoder) LookupLocation(ctx context.Context, in GeocodeQuery) GeocodeResults {
	if in.Q == "" {
		at := maps.Coordinates{Lat: *in.Lat, Lng: *in.Lng}
		addr, label, ok := g.Maps.Reverse(ctx, at)
		if !ok {
			return GeocodeResults{[]maps.GeocodeResult{}}
		}
		r := maps.GeocodeResult{Address: addr, Coordinates: at, Precision: "exact"}
		if label != "" {
			r.Label = &label
		}
		return GeocodeResults{[]maps.GeocodeResult{r}}
	}
	link := maps.ParseMapLink(in.Q)
	if link != nil && link.Kind == "shortLink" {
		link = g.Maps.ResolveShortLink(ctx, link.URL)
	}
	if link != nil && link.Kind == "coordinates" {
		// A pasted pin is the exact spot: one result, but it still needs an address.
		r := maps.GeocodeResult{Coordinates: link.Coordinates, Precision: "exact"}
		addr, label, ok := g.Maps.Reverse(ctx, link.Coordinates)
		if ok {
			r.Address = addr
		}
		switch {
		case link.Label != "":
			r.Label = &link.Label
		case ok && label != "":
			r.Label = &label
		}
		return GeocodeResults{[]maps.GeocodeResult{r}}
	}
	q := in.Q
	if link != nil && link.Kind == "place" {
		q = link.Query
	}
	return GeocodeResults{g.searchCandidates(ctx, q, in.Near, in.Limit)}
}

// searchCandidates widens until something resolves: a street-level hit beats a
// city centroid, so the tiers are never merged.
func (g *Geocoder) searchCandidates(ctx context.Context, q, near string, limit int) []maps.GeocodeResult {
	attempts := maps.QueryVariants(q)
	if near != "" {
		attempts = append(attempts, maps.QueryVariants(q+", "+near)...)
	}
	seen := map[string]bool{}
	for _, a := range attempts {
		key := strings.ToLower(a)
		// The bare country would drop the pin in the middle of Nepal.
		if seen[key] || key == "nepal" {
			continue
		}
		seen[key] = true
		if r := g.Maps.SearchPlaces(ctx, a, limit); len(r) > 0 {
			return r
		}
	}
	return []maps.GeocodeResult{}
}

// Geo mounts the two public lookups that ride on the geocoder.
type Geo struct {
	geocoder *Geocoder
	guards   *authz.Guards
	limiter  *ratelimit.Limiter

	mu    sync.Mutex
	cache map[string]cachedPlaces
}

type cachedPlaces struct {
	at     time.Time
	places []place
}

type place struct {
	Lat  float64 `json:"lat"`
	Lng  float64 `json:"lng"`
	Name string  `json:"name"`
}

const placesCacheFor = 24 * time.Hour // a college does not move

func NewGeo(m *maps.Client, guards *authz.Guards, limiter *ratelimit.Limiter) *Geo {
	return &Geo{geocoder: &Geocoder{m}, guards: guards, limiter: limiter, cache: map[string]cachedPlaces{}}
}

func (g *Geo) Register(v1 *gin.RouterGroup) {
	v1.GET("/public/hostels/register/geocode", httpx.ETag(), g.registerGeocode)
	v1.GET("/public/places", httpx.ETag(), g.places)
}

// registerGeocode is the location lookup for an owner placing their own hostel
// on the map while they apply: a signed-in account plus a per-client limit.
func (g *Geo) registerGeocode(c *gin.Context) {
	if err := g.limiter.Check(c, "public-hostel-registration-geocode", 60, g.limiter.FormWindow); err != nil {
		httpx.Fail(c, err)
		return
	}
	if _, err := g.guards.Require(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	q, err := ParseGeocodeQuery(valid.Query(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	msg := "Address lookup complete"
	if q.Q != "" {
		msg = "Location search complete"
	}
	httpx.OK(c, g.geocoder.LookupLocation(c, q), msg)
}

type placesOut struct {
	Places []place `json:"places"`
}

// places is the app's "My college / office" search, proxied so the phone never
// talks to the geocoder directly, rate limited and cached for a day.
func (g *Geo) places(c *gin.Context) {
	if err := g.limiter.PublicForm(c, "place-search"); err != nil {
		httpx.Fail(c, err)
		return
	}
	query := clip(valid.Trim(c.Query("q")), 80)
	if valid.JSLen(query) < 3 {
		httpx.Fail(c, httpx.NewError(http.StatusBadRequest, "QUERY_TOO_SHORT", "Type at least 3 letters.", nil))
		return
	}
	key := strings.ToLower(query)
	g.mu.Lock()
	hit, found := g.cache[key]
	g.mu.Unlock()
	if found && time.Since(hit.at) < placesCacheFor {
		httpx.OK(c, placesOut{hit.places}, "")
		return
	}
	places := []place{}
	for _, r := range g.geocoder.Maps.SearchPlaces(c, query+", Nepal", 6) {
		name := query
		if r.Label != nil {
			name = *r.Label
		}
		places = append(places, place{r.Coordinates.Lat, r.Coordinates.Lng, name})
	}
	g.mu.Lock()
	if len(g.cache) > 500 {
		g.cache = map[string]cachedPlaces{}
	}
	g.cache[key] = cachedPlaces{time.Now(), places}
	g.mu.Unlock()
	httpx.OK(c, placesOut{places}, "")
}
