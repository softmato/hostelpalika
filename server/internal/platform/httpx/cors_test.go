package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestCORS(t *testing.T) {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.HandleMethodNotAllowed = true
	r.Use(CORS([]string{"https://hostelpalika.com"}))
	r.POST("/x", func(c *gin.Context) { c.Status(http.StatusOK) })

	do := func(method, origin, preflight string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/x", nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if preflight != "" {
			req.Header.Set("Access-Control-Request-Method", preflight)
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w
	}
	const allow = "Access-Control-Allow-Origin"

	if w := do("POST", "", ""); w.Code != 200 || w.Header().Get(allow) != "" || w.Header().Get("Vary") != "" {
		t.Errorf("no origin must be untouched: %d %v", w.Code, w.Header())
	}
	if w := do("POST", "https://evil.example", ""); w.Code != 200 || w.Header().Get(allow) != "" {
		t.Errorf("foreign origin must get no allow header: %d %v", w.Code, w.Header())
	}
	if w := do("OPTIONS", "https://evil.example", "POST"); w.Code == 204 || w.Header().Get(allow) != "" {
		t.Errorf("foreign preflight must not pass: %d %v", w.Code, w.Header())
	}
	w := do("POST", "https://hostelpalika.com", "")
	if w.Header().Get(allow) != "https://hostelpalika.com" || w.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Errorf("allowed origin: %v", w.Header())
	}
	w = do("OPTIONS", "https://hostelpalika.com", "POST")
	if w.Code != 204 || w.Header().Get("Access-Control-Allow-Headers") == "" {
		t.Errorf("preflight: %d %v", w.Code, w.Header())
	}
}
