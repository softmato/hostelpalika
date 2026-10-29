package contract

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestOrder(t *testing.T) {
	got := order([]byte(`{"a":1,"b":{"c":[{"d":true},{}],"e":"x"},"f":[1,[2]],"g":{}}`))
	if want := strings.Join([]string{"a", "b", "c", "d", "e", "f", "g"}, "\x00"); got != want {
		t.Errorf("order = %q, want %q", got, want)
	}
}

func TestDiff(t *testing.T) {
	c := Case{
		Masks:    []string{"data.*.id"},
		Response: &Response{Status: 200, ContentType: "application/json", Body: json.RawMessage(`{"success":true,"data":[{"id":"a","n":1}]}`)},
	}
	for name, tc := range map[string]struct {
		status int
		ct     string
		body   string
		diffs  int
	}{
		"masked id ok":    {200, "application/json; charset=utf-8", `{"success":true,"data":[{"id":"zzz","n":1}]}`, 0},
		"value differs":   {200, "application/json", `{"success":true,"data":[{"id":"a","n":2}]}`, 1},
		"key order":       {200, "application/json", `{"data":[{"id":"a","n":1}],"success":true}`, 1},
		"status + type":   {500, "text/html", `{"success":true,"data":[{"id":"a","n":1}]}`, 2},
		"absent ≠ masked": {200, "application/json", `{"success":true,"data":[{"n":1}]}`, 1},
	} {
		t.Run(name, func(t *testing.T) {
			if d := Diff(c, tc.status, tc.ct, nil, []byte(tc.body)); len(d) != tc.diffs {
				t.Errorf("got %d diffs, want %d: %v", len(d), tc.diffs, d)
			}
		})
	}
}
