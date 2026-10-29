package router

import (
	"bytes"
	"io"
	"net/http/httptest"
	"testing"

	"github.com/softmato/hostelpalika/server/internal/contract"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
)

// TestContract replays every recorded TS response against the Go router.
func TestContract(t *testing.T) {
	files, err := contract.Files("../../testdata/contract")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Fatal("no contract cases found")
	}
	r, err := New(&config.Config{}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		cases, err := contract.Load(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, c := range cases {
			t.Run(f+"/"+c.Name, func(t *testing.T) {
				if c.Response == nil {
					t.Fatal("not recorded yet: go run ./cmd/dev record " + f)
				}
				var body io.Reader
				if len(c.Request.Body) > 0 {
					body = bytes.NewReader(c.Request.Body)
				}
				req := httptest.NewRequest(c.Request.Method, c.Request.Path, body)
				for k, v := range c.Request.Headers {
					req.Header.Set(k, v)
				}
				w := httptest.NewRecorder()
				r.ServeHTTP(w, req)
				for _, d := range contract.Diff(c, w.Code, w.Header().Get("Content-Type"), w.Body.Bytes()) {
					t.Error(d)
				}
			})
		}
	}
}
