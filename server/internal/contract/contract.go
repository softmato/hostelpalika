// Package contract is the parity harness (TESTING.md §3): a Case is one request
// with the response the TS server gave to it, recorded by `cmd/dev record` and
// replayed against the Go router by router/contract_test.go.
package contract

import (
	"regexp"

	"bytes"
	"encoding/json"
	"fmt"
	"github.com/softmato/hostelpalika/server/internal/contract/fixture"
	"mime"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
)

type Case struct {
	Name    string  `json:"name"`
	Request Request `json:"request"`
	// Masks are dot paths (`data.items.0.id`, `*` matches any key or index) whose
	// values can't match by design: generated ids, timestamps, reference codes.
	Masks []string `json:"masks,omitempty"`
	// KeyOrder off: an object in the answer takes its key order from a $group the
	// server runs (a count per category), so only the values are compared.
	UnorderedKeys bool `json:"unorderedKeys,omitempty"`
	// Capture saves response values for later cases in the file, as
	// {{name}}: a dot path into the body, or "cookie:<name>" from Set-Cookie.
	Capture  map[string]string `json:"capture,omitempty"`
	Response *Response         `json:"response,omitempty"` // nil until recorded
	Recorded string            `json:"recorded,omitempty"` // TS base URL + baseline, for the reader
}

type Request struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    json.RawMessage   `json:"body,omitempty"`
}

type Response struct {
	Status      int             `json:"status"`
	ContentType string          `json:"contentType"`
	Body        json.RawMessage `json:"body,omitempty"`
	// SetCookie is every Set-Cookie line, values and Expires dates blanked
	// (NormalizeCookies): names, paths and flags must match exactly.
	SetCookie []string `json:"setCookie,omitempty"`
	// Location is a redirect's target as path and query: the origin is the
	// server's own, so it differs per host.
	Location string `json:"location,omitempty"`
}

// PathAndQuery is a Location without its origin.
func PathAndQuery(location string) string {
	u, err := url.Parse(location)
	if err != nil {
		return location
	}
	return u.RequestURI()
}

// DiffLocation compares a redirect's Location with the recording.
func DiffLocation(c Case, location string) []string {
	if got := PathAndQuery(location); location == "" && c.Response.Location == "" || got == c.Response.Location {
		return nil
	}
	return []string{fmt.Sprintf("location: got %q, want %q", PathAndQuery(location), c.Response.Location)}
}

// Files returns every case file under root, sorted.
func Files(root string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(p, ".json") {
			out = append(out, p)
		}
		return err
	})
	return out, err
}

func Load(path string) ([]Case, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cases []Case
	if err := json.Unmarshal(raw, &cases); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return cases, nil
}

func Save(path string, cases []Case) error {
	raw, err := json.MarshalIndent(cases, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(raw, '\n'), 0o644)
}

// Diff compares a Go response with the recording and returns what differs.
// The media type is compared without parameters: Next sends
// `application/json`, Gin adds `; charset=utf-8`, and no client reads it.
func Diff(c Case, status int, contentType string, setCookie []string, body []byte) []string {
	want := c.Response
	var diffs []string
	if got := NormalizeCookies(setCookie); !reflect.DeepEqual(got, want.SetCookie) && (len(got) > 0 || len(want.SetCookie) > 0) {
		diffs = append(diffs, fmt.Sprintf("set-cookie:\n  got  %q\n  want %q", got, want.SetCookie))
	}
	if status != want.Status {
		diffs = append(diffs, fmt.Sprintf("status: got %d, want %d", status, want.Status))
	}
	if mediaType(contentType) != mediaType(want.ContentType) {
		diffs = append(diffs, fmt.Sprintf("content-type: got %q, want %q", contentType, want.ContentType))
	}
	if len(want.Body) == 0 && len(bytes.TrimSpace(body)) == 0 {
		return diffs
	}
	var got, exp any
	if err := json.Unmarshal(body, &got); err != nil {
		return append(diffs, fmt.Sprintf("body is not JSON: %q", body))
	}
	if err := json.Unmarshal(want.Body, &exp); err != nil {
		return append(diffs, "recorded body is not JSON")
	}
	for _, m := range c.Masks {
		mask(got, strings.Split(m, "."))
		mask(exp, strings.Split(m, "."))
	}
	if !reflect.DeepEqual(got, exp) {
		g, _ := json.Marshal(got)
		e, _ := json.Marshal(exp)
		diffs = append(diffs, fmt.Sprintf("body:\n  got  %s\n  want %s", g, e))
	} else if !c.UnorderedKeys && order(body) != order(want.Body) {
		// Key order matters to some clients (RULES.md §2); DeepEqual ignores it.
		diffs = append(diffs, "body: same values, different key order")
	}
	return diffs
}

func mediaType(ct string) string {
	mt, _, _ := mime.ParseMediaType(ct)
	return mt
}

// mask replaces the value at path with a placeholder, so absent stays absent
// and only present values are equalised.
func mask(v any, path []string) {
	if len(path) == 0 {
		return
	}
	key, rest := path[0], path[1:]
	switch node := v.(type) {
	case map[string]any:
		for k, child := range node {
			if key == "*" || k == key {
				if len(rest) == 0 {
					node[k] = "<masked>"
				} else {
					mask(child, rest)
				}
			}
		}
	case []any:
		for i, child := range node {
			if key == "*" || strconv.Itoa(i) == key {
				if len(rest) == 0 {
					node[i] = "<masked>"
				} else {
					mask(child, rest)
				}
			}
		}
	}
}

// order lists object keys in document order, depth first. Inside an object the
// decoder's tokens alternate key, value; a frame tracks which one is next.
func order(raw []byte) string {
	type frame struct{ object, wantKey bool }
	var stack []frame
	var keys []string
	valueDone := func() {
		if n := len(stack); n > 0 && stack[n-1].object {
			stack[n-1].wantKey = true
		}
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		if n := len(stack); n > 0 && stack[n-1].object && stack[n-1].wantKey {
			if d, ok := tok.(json.Delim); ok && d == '}' {
				stack = stack[:n-1]
				valueDone()
				continue
			}
			keys = append(keys, tok.(string))
			stack[n-1].wantKey = false
			continue
		}
		switch tok {
		case json.Delim('{'):
			stack = append(stack, frame{object: true, wantKey: true})
		case json.Delim('['):
			stack = append(stack, frame{})
		case json.Delim(']'), json.Delim('}'):
			stack = stack[:len(stack)-1]
			valueDone()
		default:
			valueDone()
		}
	}
	return strings.Join(keys, "\x00")
}

// NormalizeCookies blanks what changes per run: a non-empty value and Expires.
func NormalizeCookies(lines []string) []string {
	var out []string
	for _, l := range lines {
		parts := strings.Split(l, "; ")
		if name, val, ok := strings.Cut(parts[0], "="); ok && val != "" {
			parts[0] = name + "=<value>"
		}
		for i, p := range parts[1:] {
			if strings.HasPrefix(p, "Expires=") {
				parts[i+1] = "Expires=<date>"
			}
		}
		out = append(out, strings.Join(parts, "; "))
	}
	return out
}

var placeholder = regexp.MustCompile(`\{\{([^{}]+)\}\}`)

// Expand fills {{name}}: a captured value, else a fixture-minted token.
func Expand(s string, vars map[string]string) string {
	return placeholder.ReplaceAllStringFunc(s, func(m string) string {
		name := m[2 : len(m)-2]
		if v, ok := vars[name]; ok {
			return v
		}
		if t, ok := fixture.Mint(name); ok {
			return t
		}
		return m
	})
}

// Prepare is the request with every placeholder filled.
func (r Request) Prepare(vars map[string]string) (method, path string, headers map[string]string, body []byte) {
	headers = map[string]string{}
	for k, v := range r.Headers {
		headers[k] = Expand(v, vars)
	}
	if len(r.Body) > 0 {
		body = []byte(Expand(string(r.Body), vars))
		// A JSON string is a raw body (a form post), sent as written.
		var raw string
		if r.Body[0] == '"' && json.Unmarshal(r.Body, &raw) == nil {
			body = []byte(Expand(raw, vars))
		}
	}
	return r.Method, Expand(r.Path, vars), headers, body
}

// Collect stores a case's captures from the raw response.
func Collect(c Case, setCookie []string, body []byte, vars map[string]string) {
	if len(c.Capture) == 0 {
		return
	}
	var doc any
	_ = json.Unmarshal(body, &doc)
	for name, path := range c.Capture {
		if cookie, ok := strings.CutPrefix(path, "cookie:"); ok {
			for _, l := range setCookie {
				if v, ok := strings.CutPrefix(strings.SplitN(l, ";", 2)[0], cookie+"="); ok && v != "" {
					vars[name] = v
				}
			}
			continue
		}
		node := doc
		for _, k := range strings.Split(path, ".") {
			if m, ok := node.(map[string]any); ok {
				node = m[k]
			}
		}
		if s, ok := node.(string); ok {
			vars[name] = s
		}
	}
}
