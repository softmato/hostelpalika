package httpx

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func guarded(budgets map[string]time.Duration, h gin.HandlerFunc) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.ContextWithFallback = true
	r.NoRoute(NotFound)
	r.Use(Deadline(budgets), SecurityHeaders(), BodyLimit())
	r.POST("/x", h)
	return r
}

func serve(r http.Handler, body, contentType string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body))
	req.Header.Set("Content-Type", contentType)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestBodyLimit(t *testing.T) {
	read := func(c *gin.Context) {
		if _, err := io.ReadAll(c.Request.Body); err != nil {
			Fail(c, err)
			return
		}
		OK(c, nil, "")
	}
	r := guarded(nil, read)
	if w := serve(r, strings.Repeat("a", JSONBodyLimit), "application/json"); w.Code != http.StatusOK {
		t.Errorf("at the JSON limit: %d", w.Code)
	}
	w := serve(r, strings.Repeat("a", JSONBodyLimit+1), "application/json")
	if w.Code != http.StatusRequestEntityTooLarge || !strings.Contains(w.Body.String(), "PAYLOAD_TOO_LARGE") {
		t.Errorf("over the JSON limit: %d %s", w.Code, w.Body)
	}
	if w := serve(r, strings.Repeat("a", JSONBodyLimit+1), "multipart/form-data; boundary=b"); w.Code != http.StatusOK {
		t.Errorf("multipart gets the larger limit: %d", w.Code)
	}
	if w := serve(r, strings.Repeat("a", FormBodyLimit+1), "multipart/form-data; boundary=b"); w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("over the multipart limit: %d", w.Code)
	}
}

func TestDeadline(t *testing.T) {
	var got time.Duration
	r := guarded(map[string]time.Duration{"/x": time.Hour}, func(c *gin.Context) {
		d, ok := c.Deadline()
		if !ok {
			t.Error("no deadline on the request")
		}
		got = time.Until(d)
		OK(c, nil, "")
	})
	serve(r, "", "application/json")
	if got < 59*time.Minute {
		t.Errorf("route budget not applied: %v", got)
	}
	r = guarded(nil, func(c *gin.Context) {
		d, _ := c.Deadline()
		got = time.Until(d)
		OK(c, nil, "")
	})
	serve(r, "", "application/json")
	if got > DefaultDeadline || got < DefaultDeadline-time.Second {
		t.Errorf("default budget: %v", got)
	}
}

// On a real connection, where the write deadline and the size limit truly apply.
func TestGuardsOnARealServer(t *testing.T) {
	var writeDeadlineErr error
	r := guarded(map[string]time.Duration{"/x": time.Minute}, func(c *gin.Context) {
		writeDeadlineErr = http.NewResponseController(c.Writer).SetWriteDeadline(time.Now().Add(time.Minute))
		if _, err := io.ReadAll(c.Request.Body); err != nil {
			Fail(c, err)
			return
		}
		OK(c, nil, "")
	})
	srv := httptest.NewServer(r)
	defer srv.Close()

	res, err := http.Post(srv.URL+"/x", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Errorf("small body: %d", res.StatusCode)
	}
	if writeDeadlineErr != nil {
		t.Errorf("Gin's writer must support a write deadline: %v", writeDeadlineErr)
	}

	res, err = http.Post(srv.URL+"/x", "application/json", strings.NewReader(strings.Repeat("a", JSONBodyLimit+1)))
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("large body: %d", res.StatusCode)
	}
}

func TestFailMapsWhatWasA500(t *testing.T) {
	_, badHex := bson.ObjectIDFromHex("nope")
	cases := []struct {
		name string
		err  error
		code int
		want string
	}{
		{"bad json", ErrBadJSON, 400, "INVALID_JSON"},
		{"not a form", http.ErrNotMultipart, 400, "INVALID_FORM"},
		{"no boundary", fmt.Errorf("parse: %w", http.ErrMissingBoundary), 400, "INVALID_FORM"},
		{"bad id", badHex, 404, "NOT_FOUND"},
		{"out of time", fmt.Errorf("find: %w", context.DeadlineExceeded), 504, "TIMEOUT"},
		{"client left", context.Canceled, statusClientClosed, "CLIENT_CLOSED"},
		{"anything else", errors.New("boom"), 500, "INTERNAL_SERVER_ERROR"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := serve(guarded(nil, func(c *gin.Context) { Fail(c, tc.err) }), "", "application/json")
			if w.Code != tc.code || !strings.Contains(w.Body.String(), tc.want) {
				t.Errorf("got %d %s", w.Code, w.Body)
			}
			if strings.Contains(w.Body.String(), "boom") {
				t.Error("an internal reason reached the body")
			}
		})
	}
}

func TestSecurityHeaders(t *testing.T) {
	r := guarded(nil, func(c *gin.Context) { OK(c, nil, "") })
	w := serve(r, "", "application/json")
	for _, h := range []string{"X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Permissions-Policy", "Strict-Transport-Security", "Cross-Origin-Opener-Policy"} {
		if w.Header().Get(h) == "" {
			t.Errorf("%s missing", h)
		}
	}
	if w.Header().Get("X-Robots-Tag") != "" {
		t.Error("noindex belongs on /public only")
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/public/anything", nil)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Header().Get("X-Robots-Tag") != "noindex" {
		t.Error("public JSON must be noindex, on an unmatched path too")
	}
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), `"errorCode":"NOT_FOUND"`) {
		t.Errorf("unknown path: %d %s", w.Code, w.Body)
	}
}
