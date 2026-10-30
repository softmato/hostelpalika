package maps

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"
)

type vectors struct {
	Links []struct {
		URL string          `json:"url"`
		Out json.RawMessage `json:"out"`
	} `json:"links"`
	Tidy []struct {
		Value *string `json:"value"`
		Out   *string `json:"out"`
	} `json:"tidy"`
	Variants []struct {
		Query string   `json:"query"`
		Out   []string `json:"out"`
	} `json:"variants"`
	Address []struct {
		Parts map[string]any `json:"parts"`
		Out   string         `json:"out"`
	} `json:"address"`
}

func load(t *testing.T) vectors {
	t.Helper()
	raw, err := os.ReadFile("../../../testdata/vectors/maps.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func linkMap(l *ParsedMapLink) any {
	if l == nil {
		return nil
	}
	m := map[string]any{"kind": l.Kind}
	switch l.Kind {
	case "coordinates":
		m["coordinates"] = map[string]any{"lat": l.Coordinates.Lat, "lng": l.Coordinates.Lng}
		if l.Label != "" {
			m["label"] = l.Label
		}
	case "place":
		m["query"] = l.Query
	case "shortLink":
		m["url"] = l.URL
	}
	return m
}

func TestParseMapLinkMatchesTS(t *testing.T) {
	for _, c := range load(t).Links {
		var want any
		_ = json.Unmarshal(c.Out, &want)
		got := linkMap(ParseMapLink(c.URL))
		b, _ := json.Marshal(got)
		var round any
		_ = json.Unmarshal(b, &round)
		if !reflect.DeepEqual(round, want) {
			t.Errorf("%q:\n got  %s\n want %s", c.URL, b, c.Out)
		}
	}
}

func TestTidyVariantsAndAddressMatchTS(t *testing.T) {
	v := load(t)
	for _, c := range v.Tidy {
		in := ""
		if c.Value != nil {
			in = *c.Value
		}
		want := ""
		if c.Out != nil {
			want = *c.Out
		}
		if got := TidyPlaceName(in); got != want {
			t.Errorf("tidy %q: %q != %q", in, got, want)
		}
	}
	for _, c := range v.Variants {
		if got := QueryVariants(c.Query); !reflect.DeepEqual(got, c.Out) {
			t.Errorf("variants %q: %q != %q", c.Query, got, c.Out)
		}
	}
	for _, c := range v.Address {
		s := func(k string) string { x, _ := c.Parts[k].(string); return x }
		_, countrySet := c.Parts["country"]
		got := BuildAddressQuery(AddressParts{Address: s("address"), Area: s("area"), City: s("city"), Country: s("country"), Province: s("province")}, countrySet)
		if got != c.Out {
			t.Errorf("address %v: %q != %q", c.Parts, got, c.Out)
		}
	}
}

// stub is Nominatim and Google in one: the path says which.
func stub(t *testing.T) (*Client, *int) {
	t.Helper()
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/search":
			if r.Header.Get("User-Agent") == "" || r.URL.Query().Get("countrycodes") != "np" {
				t.Errorf("search request: %v %v", r.Header, r.URL.Query())
			}
			if r.URL.Query().Get("q") == "nothing here" {
				_, _ = w.Write([]byte(`[]`))
				return
			}
			_, _ = w.Write([]byte(`[{"lat":"27.69","lon":"85.34","display_name":"New Baneshwor, Kathmandu","address":{"house_number":"12","road":"Ring Road","suburb":"New Baneshwor","city":"Kathmandu Metropolitan City","state":"Bagmati Province","country":"Nepal"}}]`))
		case "/reverse":
			_, _ = w.Write([]byte(`{"display_name":"Somewhere","address":{"neighbourhood":"Thamel","town":"Kathmandu","state":"Bagamati Province"}}`))
		case "/down":
			w.WriteHeader(http.StatusBadGateway)
		case "/google":
			_, _ = w.Write([]byte(`{"results":[{"formatted_address":"G, Kathmandu","geometry":{"location":{"lat":27.7,"lng":85.3}},"address_components":[{"long_name":"7","types":["street_number"]},{"long_name":"Main St","types":["route"]},{"long_name":"Kathmandu Metropolitan City","types":["locality"]},{"long_name":"Nepal","types":["country"]}]}]}`))
		}
	}))
	t.Cleanup(srv.Close)
	return &Client{HTTP: srv.Client(), UserAgent: "test/1.0", NominatimURL: srv.URL + "/search", NominatimReverseURL: srv.URL + "/reverse"}, &calls
}

func TestSearchPlacesNominatim(t *testing.T) {
	c, _ := stub(t)
	got := c.SearchPlaces(context.Background(), "  Baneshwor ", 3)
	b, _ := json.Marshal(got)
	want := `[{"address":{"address":"12 Ring Road","area":"New Baneshwor","city":"Kathmandu","country":"Nepal","province":"Bagmati"},"coordinates":{"lat":27.69,"lng":85.34},"label":"New Baneshwor, Kathmandu","precision":"approximate"}]`
	if string(b) != want {
		t.Errorf("got  %s\nwant %s", b, want)
	}
	if got := c.SearchPlaces(context.Background(), "nothing here", 3); len(got) != 0 {
		t.Errorf("empty answer: %v", got)
	}
	if got := c.SearchPlaces(context.Background(), "   ", 3); len(got) != 0 {
		t.Errorf("blank: %v", got)
	}
}

func TestUpstreamFailureIsNothingFound(t *testing.T) {
	c, _ := stub(t)
	c.NominatimURL = c.NominatimURL[:len(c.NominatimURL)-len("/search")] + "/down"
	if got := c.SearchPlaces(context.Background(), "x", 3); got == nil || len(got) != 0 {
		t.Errorf("502: %#v", got)
	}
	c.NominatimURL = "http://127.0.0.1:1/unreachable"
	if got := c.SearchPlaces(context.Background(), "x", 3); len(got) != 0 {
		t.Errorf("refused: %#v", got)
	}
}

func TestReverseAndGeocode(t *testing.T) {
	c, _ := stub(t)
	addr, label, ok := c.Reverse(context.Background(), Coordinates{27.7, 85.3})
	if !ok || label != "Somewhere" || *addr != (AddressParts{Area: "Thamel", City: "Kathmandu", Province: "Bagamati"}) {
		t.Errorf("reverse: %+v %q %v", addr, label, ok)
	}
	r := c.Geocode(context.Background(), AddressParts{Address: "Ring Road", Area: "Baneshwor", City: "Kathmandu"}, false)
	if r == nil || r.Precision != "exact" {
		t.Errorf("geocode full: %+v", r)
	}
	r = c.Geocode(context.Background(), AddressParts{Area: "Baneshwor", City: "Kathmandu"}, false)
	if r == nil || r.Precision != "approximate" {
		t.Errorf("geocode coarse only: %+v", r)
	}
	if c.Geocode(context.Background(), AddressParts{}, true) != nil {
		t.Error("nothing to geocode")
	}
}

func TestGoogleFirstThenNominatim(t *testing.T) {
	c, _ := stub(t)
	c.GoogleKey = "k"
	c.GoogleURL = c.NominatimURL[:len(c.NominatimURL)-len("/search")] + "/google"
	got := c.SearchPlaces(context.Background(), "x", 5)
	if len(got) != 1 || got[0].Address.Address != "7 Main St" || got[0].Address.City != "Kathmandu" || *got[0].Label != "G, Kathmandu" {
		t.Errorf("google: %+v", got)
	}
	c.GoogleURL = c.NominatimURL[:len(c.NominatimURL)-len("/search")] + "/down"
	if got := c.SearchPlaces(context.Background(), "x", 5); len(got) != 1 || got[0].Address.Area != "New Baneshwor" {
		t.Errorf("fallback to nominatim: %+v", got)
	}
}

func TestResolveShortLink(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/short":
			http.Redirect(w, r, "/maps/place/Royal+Rapti/@27.69,85.34,15z", http.StatusFound)
		case "/interstitial":
			_, _ = w.Write([]byte(`<html>consent ... !3d27.6935!4d85.3419 ...</html>`))
		case "/empty":
		default:
			_, _ = w.Write([]byte("ok"))
		}
	}))
	defer srv.Close()
	c := &Client{HTTP: srv.Client()}
	if l := c.ResolveShortLink(context.Background(), srv.URL+"/short"); l == nil || l.Kind != "coordinates" || l.Coordinates.Lat != 27.69 || l.Label != "Royal Rapti" {
		t.Errorf("redirect: %+v", l)
	}
	if l := c.ResolveShortLink(context.Background(), srv.URL+"/interstitial"); l == nil || l.Coordinates.Lng != 85.3419 {
		t.Errorf("markup: %+v", l)
	}
	if l := c.ResolveShortLink(context.Background(), srv.URL+"/empty"); l != nil {
		t.Errorf("empty: %+v", l)
	}
}
