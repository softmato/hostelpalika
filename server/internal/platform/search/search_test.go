package search

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/bytedance/sonic"

	"github.com/softmato/hostelpalika/server/internal/platform/llm"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

type vectors struct {
	Now         int64  `json:"now"`
	QuotaSecret string `json:"quotaSecret"`
	Parse       []struct {
		Query string          `json:"query"`
		Out   json.RawMessage `json:"out"`
	} `json:"parse"`
	Quota struct {
		States []struct {
			State     QuotaState      `json:"state"`
			Encoded   string          `json:"encoded"`
			Window    json.RawMessage `json:"window"`
			Remaining int             `json:"remaining"`
			MaxAge    int             `json:"maxAge"`
		} `json:"states"`
		Raws []struct {
			Raw    *string         `json:"raw"`
			Window json.RawMessage `json:"window"`
		} `json:"raws"`
		Tampered struct {
			Cookie string          `json:"cookie"`
			Window json.RawMessage `json:"window"`
		} `json:"tampered"`
	} `json:"quota"`
	Model []struct {
		Raw       string          `json:"raw"`
		Extracted string          `json:"extracted"`
		Sanitized string          `json:"sanitized"`
		Parsed    json.RawMessage `json:"parsed"`
	} `json:"model"`
}

func load(t *testing.T) vectors {
	t.Helper()
	raw, err := os.ReadFile("../../../testdata/vectors/search.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func compact(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var b bytes.Buffer
	if err := json.Compact(&b, raw); err != nil {
		t.Fatal(err)
	}
	return b.String()
}

func TestParseSearchQueryMatchesTS(t *testing.T) {
	for _, c := range load(t).Parse {
		got := ParseSearchQuery(c.Query)
		out, err := sonic.Marshal(struct {
			Confidence  float64     `json:"confidence"`
			Filters     ordered.Map `json:"filters"`
			RawTextOnly bool        `json:"rawTextOnly"`
			Source      string      `json:"source"`
		}{got.Confidence, got.Filters, got.RawTextOnly, got.Source})
		if err != nil {
			t.Fatalf("%q: %v", c.Query, err)
		}
		if want := compact(t, c.Out); string(out) != want {
			t.Errorf("%q:\n got  %s\n want %s", c.Query, out, want)
		}
	}
}

func windowJSON(s QuotaState) string {
	b, _ := json.Marshal(struct {
		Used         int   `json:"used"`
		WindowEndsAt int64 `json:"windowEndsAt"`
	}{s.Used, s.WindowEndsAt})
	return string(b)
}

func TestQuotaMatchesTS(t *testing.T) {
	v := load(t)
	q := Quota{Secret: v.QuotaSecret}
	now := time.UnixMilli(v.Now)
	for _, c := range v.Quota.States {
		if got := q.Encode(c.State); got != c.Encoded {
			t.Errorf("encode %+v: %s != %s", c.State, got, c.Encoded)
		}
		if got := windowJSON(q.CurrentWindow(c.Encoded, now)); got != compact(t, c.Window) {
			t.Errorf("window %+v: %s != %s", c.State, got, c.Window)
		}
		if Remaining(c.State) != c.Remaining || MaxAge(c.State, now) != c.MaxAge {
			t.Errorf("remaining/maxAge %+v", c.State)
		}
	}
	for _, c := range v.Quota.Raws {
		raw := ""
		if c.Raw != nil {
			raw = *c.Raw
		}
		if got := windowJSON(q.CurrentWindow(raw, now)); got != compact(t, c.Window) {
			t.Errorf("raw %q: %s != %s", raw, got, c.Window)
		}
	}
	if got := windowJSON(q.CurrentWindow(v.Quota.Tampered.Cookie, now)); got != compact(t, v.Quota.Tampered.Window) {
		t.Errorf("tampered: %s != %s", got, v.Quota.Tampered.Window)
	}
}

func TestModelJSONMatchesTS(t *testing.T) {
	for _, c := range load(t).Model {
		ext := llm.ExtractJSONPayload(c.Raw)
		if ext != c.Extracted {
			t.Errorf("extract %q: %q != %q", c.Raw, ext, c.Extracted)
		}
		if got := llm.SanitizeJSONPayload(ext); got != c.Sanitized {
			t.Errorf("sanitize %q: %q != %q", c.Raw, got, c.Sanitized)
		}
		v, ok := llm.ParseModelJSON(c.Raw, "test")
		var got []byte
		if ok {
			got, _ = sonic.Marshal(v)
		} else {
			got = []byte("null")
		}
		var a, b any
		_ = json.Unmarshal(got, &a)
		_ = json.Unmarshal(c.Parsed, &b)
		ga, _ := json.Marshal(a)
		gb, _ := json.Marshal(b)
		if string(ga) != string(gb) {
			t.Errorf("parse %q: %s != %s", c.Raw, ga, gb)
		}
	}
}

func TestNormalizeFilters(t *testing.T) {
	cases := []struct {
		name    string
		query   string
		payload string
		want    string
	}{
		{"keeps a mentioned area", "boys hostel in Thamel", `{"area":"thamel","type":"BOYS"}`, `{"area":"Thamel","facility":null,"roomType":null,"type":"BOYS"}`},
		{"drops an unmentioned area", "boys hostel", `{"area":"Thamel"}`, `null`},
		{"drops a budget with no digit", "cheap hostel", `{"maxPrice":8000,"q":"Royal"}`, `{"area":null,"facility":null,"roomType":null,"q":"Royal"}`},
		{"keeps a stated budget", "hostel under 8k", `{"maxPrice":"8000.4"}`, `{"area":null,"facility":null,"roomType":null,"minPrice":null,"maxPrice":8000}`},
		{"equal bounds are dropped", "between 8k and 8k", `{"minPrice":8000,"maxPrice":8000,"food":"veg"}`, `{"area":null,"facility":null,"roomType":null,"food":"veg"}`},
		{"q echoing the sentence", "Royal Rapti", `{"q":" royal rapti "}`, `null`},
		{"q too long", "x", `{"q":"` + string(bytes.Repeat([]byte("a"), 61)) + `"}`, `null`},
		{"facility needs a mention", "hostel with wifi", `{"facility":"WiFi","roomType":"Single"}`, `{"area":null,"facility":"WiFi","roomType":null}`},
	}
	for _, c := range cases {
		var payload map[string]any
		if err := json.Unmarshal([]byte(c.payload), &payload); err != nil {
			t.Fatal(err)
		}
		got := normalizeFilters(payload, c.query)
		var out []byte
		if got == nil {
			out = []byte("null")
		} else {
			// undefined keys print as null here so the case shows which survived
			for i := range got {
				if got[i].Value == ordered.Undefined {
					got[i].Value = nil
				}
			}
			out, _ = sonic.Marshal(got)
		}
		if string(out) != c.want {
			t.Errorf("%s:\n got  %s\n want %s", c.name, out, c.want)
		}
	}
}
