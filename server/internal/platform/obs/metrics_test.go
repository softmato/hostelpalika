package obs

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestMetricsExposeRequestsByRoutePattern(t *testing.T) {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(Middleware())
	r.GET("/hostels/:id", func(c *gin.Context) { c.Status(http.StatusOK) })
	for _, path := range []string{"/hostels/secret-looking-id", "/no/such/path"} {
		r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, path, nil))
	}
	CacheLookup(true)
	RateLimited("test-door")
	BackgroundStarted()(false)

	w := httptest.NewRecorder()
	MetricsHandler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	body := w.Body.String()
	for _, want := range []string{
		`route="/hostels/:id"`, `route="unmatched"`, "hostelpalika_http_request_duration_seconds_bucket", "hostelpalika_http_in_flight",
		`hostelpalika_cache_lookups_total{result="hit"}`, `hostelpalika_rate_limited_total{namespace="test-door"}`,
		`hostelpalika_background_tasks_total{result="ok"}`, "go_goroutines", "go_gc_duration_seconds",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("metrics lack %s", want)
		}
	}
	// A URL as a label would grow without bound, and could carry an id.
	if strings.Contains(body, "secret-looking-id") || strings.Contains(body, "/no/such/path") {
		t.Error("a raw URL reached a label")
	}
}
