// Package contract is the parity harness (TESTING.md §3): a Case is one request
// with the response the TS server gave to it, recorded by `cmd/dev record` and
// replayed against the Go router by router/contract_test.go.
package contract

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime"
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
	Masks    []string  `json:"masks,omitempty"`
	Response *Response `json:"response,omitempty"` // nil until recorded
	Recorded string    `json:"recorded,omitempty"` // TS base URL + baseline, for the reader
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
func Diff(c Case, status int, contentType string, body []byte) []string {
	want := c.Response
	var diffs []string
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
	} else if order(body) != order(want.Body) {
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
