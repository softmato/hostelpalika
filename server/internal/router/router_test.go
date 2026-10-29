package router

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/softmato/hostelpalika/server/internal/platform/config"
)

func TestHealth(t *testing.T) {
	r, err := New(&config.Config{}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		method string
		status int
		body   string
	}{
		// Same bytes as the TS route, field order included.
		{http.MethodGet, 200, `{"success":true,"message":"API is healthy","data":{"service":"hostelpalika-web","status":"ok"}}`},
		{http.MethodPost, 405, ""},
	} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(tc.method, "/api/v1/health", nil))
		if w.Code != tc.status {
			t.Errorf("%s: status %d, want %d", tc.method, w.Code, tc.status)
		}
		if tc.body != "" && w.Body.String() != tc.body {
			t.Errorf("%s: body\n got %s\nwant %s", tc.method, w.Body.String(), tc.body)
		}
	}
}
