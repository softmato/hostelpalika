// Package maps is lib/maps/{geocoding,map-links,upstream-fetch}.ts: address ⇄
// coordinates through Google (when a server key is set) or Nominatim, pasted
// map links, and the bounded wait every provider call gets. Every upstream
// failure degrades to "nothing found", never an error (the callers' contract).
package maps

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

const (
	nominatimURL        = "https://nominatim.openstreetmap.org/search"
	nominatimReverseURL = "https://nominatim.openstreetmap.org/reverse"
	googleGeocodeURL    = "https://maps.googleapis.com/maps/api/geocode/json"
	upstreamTimeout     = 8 * time.Second // DEFAULT_TIMEOUT_MS
)

type Coordinates struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

// AddressParts are the fields a hostel carries; absent ones are not printed
// (definedParts), in this key order.
type AddressParts struct {
	Address  string `json:"address,omitempty"`
	Area     string `json:"area,omitempty"`
	City     string `json:"city,omitempty"`
	Country  string `json:"country,omitempty"`
	Province string `json:"province,omitempty"`
}

func (a AddressParts) Empty() bool { return a == AddressParts{} }

// GeocodeResult is a ranked candidate. Address is a pointer: a Nominatim hit
// always prints one (`{}` when the provider gave none), a pasted pin may not.
type GeocodeResult struct {
	Address     *AddressParts `json:"address,omitempty"`
	Coordinates Coordinates   `json:"coordinates"`
	Label       *string       `json:"label,omitempty"`
	Precision   string        `json:"precision"`
}

// Client talks to the providers. The URL fields exist so tests can point it at
// a stub; production leaves them empty.
type Client struct {
	HTTP      *http.Client
	GoogleKey string // GOOGLE_MAPS_API_KEY
	UserAgent string // `${PLATFORM_NAME}/1.0 (hostel discovery; +${siteUrl()})`

	NominatimURL, NominatimReverseURL, GoogleURL string
}

func NewClient(googleKey, siteURL string) *Client {
	return &Client{HTTP: &http.Client{Timeout: upstreamTimeout}, GoogleKey: googleKey,
		UserAgent: "HostelPalika/1.0 (hostel discovery; +" + siteURL + ")"}
}

func or(v, fallback string) string {
	if v != "" {
		return v
	}
	return fallback
}

// fetch is fetchUpstream: nil on a timeout or transport error.
func (c *Client) fetch(ctx context.Context, rawURL string, headers map[string]string) *http.Response {
	ctx, cancel := context.WithTimeout(ctx, upstreamTimeout)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		cancel()
		return nil
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		cancel()
		return nil
	}
	res.Body = &cancelBody{res.Body, cancel}
	return res
}

type cancelBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (b *cancelBody) Close() error { b.cancel(); return b.ReadCloser.Close() }

func ok(res *http.Response) bool { return res != nil && res.StatusCode >= 200 && res.StatusCode < 300 }

func decode(res *http.Response, v any) error {
	defer res.Body.Close()
	return json.NewDecoder(res.Body).Decode(v)
}

// BuildAddressQuery joins the parts that are set, country defaulting to Nepal.
func BuildAddressQuery(p AddressParts, countrySet bool) string {
	country := p.Country
	if !countrySet {
		country = "Nepal"
	}
	var out []string
	for _, v := range []string{p.Address, p.Area, p.City, p.Province, country} {
		if v = valid.Trim(v); v != "" {
			out = append(out, v)
		}
	}
	return strings.Join(out, ", ")
}

// QueryVariants are progressively coarser forms of a place query, most
// specific first: duplicates dropped, then leading components one at a time.
func QueryVariants(raw string) []string {
	seen := map[string]bool{}
	var parts []string
	for _, p := range strings.Split(raw, ",") {
		p = valid.Trim(p)
		key := strings.ToLower(p)
		if p == "" || seen[key] {
			continue
		}
		seen[key] = true
		parts = append(parts, p)
	}
	out, dup := []string{}, map[string]bool{}
	for i := range parts {
		v := strings.Join(parts[i:], ", ")
		if !dup[v] {
			dup[v] = true
			out = append(out, v)
		}
	}
	return out
}

// SearchPlaces is free-text lookup returning ranked candidates: Google first
// when a key is set, then Nominatim.
func (c *Client) SearchPlaces(ctx context.Context, query string, limit int) []GeocodeResult {
	q := valid.Trim(query)
	if q == "" {
		return []GeocodeResult{}
	}
	if c.GoogleKey != "" {
		if r := c.searchGoogle(ctx, q, limit); len(r) > 0 {
			return r
		}
	}
	return c.searchNominatim(ctx, q, limit)
}

// Geocode is geocodeAddress: the full address first, then the coarse locality.
func (c *Client) Geocode(ctx context.Context, parts AddressParts, countrySet bool) *GeocodeResult {
	full := BuildAddressQuery(parts, countrySet)
	coarse := BuildAddressQuery(AddressParts{Area: parts.Area, City: parts.City, Country: parts.Country, Province: parts.Province}, countrySet)
	var queries []string
	for _, q := range []string{full, coarse} {
		if q == "" {
			continue
		}
		dup := false
		for _, x := range queries {
			dup = dup || x == q
		}
		if !dup {
			queries = append(queries, q)
		}
	}
	for i, q := range queries {
		precision := "approximate"
		if i == 0 && q != coarse {
			precision = "exact"
		}
		if m := c.SearchPlaces(ctx, q, 1); len(m) > 0 {
			m[0].Precision = precision
			return &m[0]
		}
	}
	return nil
}

// Reverse is reverseGeocode: the address a pin sits on, or nil.
func (c *Client) Reverse(ctx context.Context, at Coordinates) (*AddressParts, string, bool) {
	if c.GoogleKey != "" {
		if a, label, ok := c.reverseGoogle(ctx, at); ok {
			return a, label, true
		}
	}
	return c.reverseNominatim(ctx, at)
}

type nominatimAddress map[string]any

func pick(src nominatimAddress, keys ...string) string {
	for _, k := range keys {
		if s, isStr := src[k].(string); isStr {
			if s = valid.Trim(s); s != "" {
				return s
			}
		}
	}
	return ""
}

var adminSuffix = regexp.MustCompile(`(?i)[\s\x{00A0}\x{FEFF}]+(sub[- ]metropolitan city|metropolitan city|rural municipality|municipality|province|district)$`)

// TidyPlaceName: "Kathmandu Metropolitan City" → "Kathmandu".
func TidyPlaceName(v string) string {
	if v == "" {
		return ""
	}
	if t := valid.Trim(adminSuffix.ReplaceAllString(v, "")); t != "" {
		return t
	}
	return valid.Trim(v)
}

func addressFromNominatim(a nominatimAddress) AddressParts {
	if a == nil {
		return AddressParts{}
	}
	var street []string
	for _, k := range []string{"house_number", "road"} {
		if s, _ := a[k].(string); s != "" {
			street = append(street, s)
		}
	}
	return AddressParts{
		Address:  valid.Trim(strings.Join(street, " ")),
		Area:     pick(a, "neighbourhood", "suburb", "quarter", "hamlet", "village", "city_district"),
		City:     TidyPlaceName(pick(a, "city", "town", "municipality", "county")),
		Country:  pick(a, "country"),
		Province: TidyPlaceName(pick(a, "state", "region")),
	}
}

func (c *Client) nominatimBase() string { return or(c.NominatimURL, nominatimURL) }

func (c *Client) searchNominatim(ctx context.Context, query string, limit int) []GeocodeResult {
	u := c.nominatimBase() + "?format=json&addressdetails=1&limit=" + strconv.Itoa(limit) + "&countrycodes=np&q=" + httpx.EncodeURIComponent(query)
	res := c.fetch(ctx, u, map[string]string{"Accept-Language": "en", "User-Agent": c.UserAgent})
	if !ok(res) {
		return []GeocodeResult{}
	}
	var data []struct {
		Address     nominatimAddress `json:"address"`
		DisplayName *string          `json:"display_name"`
		Lat         string           `json:"lat"`
		Lon         string           `json:"lon"`
	}
	if decode(res, &data) != nil {
		return []GeocodeResult{}
	}
	out := make([]GeocodeResult, len(data))
	for i, it := range data {
		addr := addressFromNominatim(it.Address)
		out[i] = GeocodeResult{Address: &addr, Coordinates: Coordinates{valid.JSNumber(it.Lat), valid.JSNumber(it.Lon)},
			Label: it.DisplayName, Precision: "approximate"}
	}
	return out
}

func jsFloat(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

func (c *Client) reverseNominatim(ctx context.Context, at Coordinates) (*AddressParts, string, bool) {
	u := or(c.NominatimReverseURL, nominatimReverseURL) + "?format=jsonv2&addressdetails=1&zoom=18&lat=" + jsFloat(at.Lat) + "&lon=" + jsFloat(at.Lng)
	res := c.fetch(ctx, u, map[string]string{"Accept-Language": "en", "User-Agent": c.UserAgent})
	if !ok(res) {
		return nil, "", false
	}
	var data struct {
		Address     nominatimAddress `json:"address"`
		DisplayName string           `json:"display_name"`
	}
	if decode(res, &data) != nil {
		return nil, "", false
	}
	a := addressFromNominatim(data.Address)
	if a.Empty() {
		return nil, "", false
	}
	return &a, data.DisplayName, true
}

type googleComponent struct {
	LongName string   `json:"long_name"`
	Types    []string `json:"types"`
}

func addressFromGoogle(comps []googleComponent) AddressParts {
	of := func(types ...string) string {
		for _, c := range comps {
			for _, t := range c.Types {
				for _, w := range types {
					if t == w {
						return c.LongName
					}
				}
			}
		}
		return ""
	}
	var street []string
	for _, v := range []string{of("street_number"), of("route")} {
		if v != "" {
			street = append(street, v)
		}
	}
	address := valid.Trim(strings.Join(street, " "))
	if address == "" {
		address = of("premise", "point_of_interest")
	}
	return AddressParts{
		Address:  address,
		Area:     of("sublocality_level_1", "sublocality", "neighborhood", "ward"),
		City:     TidyPlaceName(of("locality", "administrative_area_level_2", "postal_town")),
		Country:  of("country"),
		Province: TidyPlaceName(of("administrative_area_level_1")),
	}
}

func (c *Client) googleBase() string { return or(c.GoogleURL, googleGeocodeURL) }

func (c *Client) searchGoogle(ctx context.Context, query string, limit int) []GeocodeResult {
	res := c.fetch(ctx, c.googleBase()+"?address="+httpx.EncodeURIComponent(query)+"&region=np&key="+c.GoogleKey, nil)
	if !ok(res) {
		return nil
	}
	var data struct {
		Results []struct {
			Components []googleComponent `json:"address_components"`
			Formatted  *string           `json:"formatted_address"`
			Geometry   struct {
				Location Coordinates `json:"location"`
			} `json:"geometry"`
		} `json:"results"`
	}
	if decode(res, &data) != nil {
		return nil
	}
	var out []GeocodeResult
	for i, r := range data.Results {
		if i >= limit {
			break
		}
		a := addressFromGoogle(r.Components)
		out = append(out, GeocodeResult{Address: &a, Coordinates: r.Geometry.Location, Label: r.Formatted, Precision: "approximate"})
	}
	return out
}

func (c *Client) reverseGoogle(ctx context.Context, at Coordinates) (*AddressParts, string, bool) {
	res := c.fetch(ctx, c.googleBase()+"?latlng="+jsFloat(at.Lat)+","+jsFloat(at.Lng)+"&key="+c.GoogleKey, nil)
	if !ok(res) {
		return nil, "", false
	}
	var data struct {
		Results []struct {
			Components []googleComponent `json:"address_components"`
			Formatted  string            `json:"formatted_address"`
		} `json:"results"`
	}
	if decode(res, &data) != nil || len(data.Results) == 0 {
		return nil, "", false
	}
	a := addressFromGoogle(data.Results[0].Components)
	if a.Empty() {
		return nil, "", false
	}
	return &a, data.Results[0].Formatted, true
}
