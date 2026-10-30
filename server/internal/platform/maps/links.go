package maps

import (
	"context"
	"io"
	"math"
	"net/url"
	"regexp"
	"strings"

	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// ParsedMapLink is what a pasted map link resolved to: Kind is "coordinates",
// "place" or "shortLink".
type ParsedMapLink struct {
	Kind        string
	Coordinates Coordinates
	Label       string // coordinates: the place name in the path, when there is one
	Query       string // place
	URL         string // shortLink
}

var (
	barePair  = regexp.MustCompile(`^@?(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)$`)
	dataPin   = regexp.MustCompile(`!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)`)
	atSegment = regexp.MustCompile(`@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)`)
	osmHash   = regexp.MustCompile(`map=\d+(?:\.\d+)?/(-?\d{1,2}(?:\.\d+)?)/(-?\d{1,3}(?:\.\d+)?)`)
	pathName  = regexp.MustCompile(`/(?:place|search|dir)/([^/@]+)`)
	numeric   = regexp.MustCompile(`^[\d.,\s+-]+$`)
	urlLike   = regexp.MustCompile(`(?i)^(https?://|www\.|maps\.)`)
	hasScheme = regexp.MustCompile(`(?i)^https?://`)
)

var pointParams = []string{"q", "query", "ll", "sll", "center", "daddr", "destination", "viewpoint"}

var shorteners = []string{"goo.gl", "maps.app.goo.gl", "g.co", "share.google", "bit.ly", "osm.org"}

func toCoordinates(lat, lng string) (Coordinates, bool) {
	c := Coordinates{valid.JSNumber(lat), valid.JSNumber(lng)}
	if math.IsNaN(c.Lat) || math.IsNaN(c.Lng) || math.IsInf(c.Lat, 0) || math.IsInf(c.Lng, 0) {
		return c, false
	}
	if math.Abs(c.Lat) > 90 || math.Abs(c.Lng) > 180 {
		return c, false
	}
	// 0,0 is Null Island — always a parse artefact, never a hostel.
	if c.Lat == 0 && c.Lng == 0 {
		return c, false
	}
	return c, true
}

// placeFromPath is a human-friendly place name out of `/place/New+Baneshwor/`.
func placeFromPath(pathname string) string {
	m := pathName.FindStringSubmatch(pathname)
	if m == nil || m[1] == "" {
		return ""
	}
	dec, err := url.PathUnescape(strings.ReplaceAll(m[1], "+", " "))
	if err != nil {
		panic(err) // decodeURIComponent throws URIError → the route's generic 500
	}
	name := valid.Trim(dec)
	if name == "" || numeric.MatchString(name) || strings.HasPrefix(name, "data=") {
		return ""
	}
	return name
}

func pair(re *regexp.Regexp, s string) (Coordinates, bool) {
	if m := re.FindStringSubmatch(s); m != nil {
		return toCoordinates(m[1], m[2])
	}
	return Coordinates{}, false
}

// ParseMapLink reads a pasted Google Maps (or OSM / Apple Maps) link, or a raw
// coordinate pair, without any network call. nil: an ordinary place query.
func ParseMapLink(raw string) *ParsedMapLink {
	value := valid.Trim(raw)
	if value == "" {
		return nil
	}
	if c, ok := pair(barePair, value); ok {
		return &ParsedMapLink{Kind: "coordinates", Coordinates: c}
	}
	if !urlLike.MatchString(value) {
		return nil
	}
	if !hasScheme.MatchString(value) {
		value = "https://" + value
	}
	u, err := url.Parse(value)
	if err != nil || u.Host == "" {
		return nil
	}
	host := strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
	for _, s := range shorteners {
		if host == s || strings.HasSuffix(host, "."+s) {
			href := u.String()
			if u.Path == "" && u.RawQuery == "" && u.Fragment == "" {
				href += "/"
			}
			return &ParsedMapLink{Kind: "shortLink", URL: href}
		}
	}
	whole := u.String()
	place := placeFromPath(u.EscapedPath())
	if c, ok := pair(dataPin, whole); ok {
		return &ParsedMapLink{Kind: "coordinates", Coordinates: c, Label: place}
	}
	q := u.Query()
	for _, key := range pointParams {
		if p := valid.Trim(q.Get(key)); p != "" {
			if c, ok := pair(barePair, p); ok {
				return &ParsedMapLink{Kind: "coordinates", Coordinates: c}
			}
		}
	}
	if mlat, mlon := q.Get("mlat"), q.Get("mlon"); mlat != "" && mlon != "" {
		if c, ok := toCoordinates(mlat, mlon); ok {
			return &ParsedMapLink{Kind: "coordinates", Coordinates: c}
		}
	}
	if c, ok := pair(osmHash, "#"+u.Fragment); ok && u.Fragment != "" {
		return &ParsedMapLink{Kind: "coordinates", Coordinates: c}
	}
	if c, ok := pair(atSegment, whole); ok {
		return &ParsedMapLink{Kind: "coordinates", Coordinates: c, Label: place}
	}
	if place != "" {
		return &ParsedMapLink{Kind: "place", Query: place}
	}
	for _, key := range pointParams {
		if p := valid.Trim(q.Get(key)); p != "" && !numeric.MatchString(p) {
			return &ParsedMapLink{Kind: "place", Query: p}
		}
	}
	return nil
}

// ResolveShortLink follows a shortened map link to the real one. Callers pass
// only hosts ParseMapLink classified as shorteners, so this is not an open
// redirect-follower.
func (c *Client) ResolveShortLink(ctx context.Context, short string) *ParsedMapLink {
	res := c.fetch(ctx, short, map[string]string{
		// The bare-bones client gets a consent interstitial with no coordinates.
		"Accept-Language": "en",
		"User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
	})
	if res == nil {
		return nil
	}
	defer res.Body.Close()
	if final := res.Request.URL.String(); final != short {
		if l := ParseMapLink(final); l != nil && l.Kind != "shortLink" {
			return l
		}
	}
	// Some short links land on a consent page that carries the real URL in the markup.
	raw, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil || len(raw) == 0 {
		return nil
	}
	body := string(raw)
	for _, re := range []*regexp.Regexp{dataPin, atSegment} {
		if c, ok := pair(re, body); ok {
			return &ParsedMapLink{Kind: "coordinates", Coordinates: c}
		}
	}
	return nil
}
