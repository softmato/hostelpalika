package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestETag(t *testing.T) {
	// Golden: lib/etag.ts's fnv1a run under node.
	for body, want := range map[string]string{
		`{"success":true,"message":"Request successful","data":null}`: `W/"h0y5c3-1n"`,
		"नेपाल 🏠 ok":                                                  `W/"vbbclo-b"`,
		"":                                                            `W/"ztntfp-0"`,
	} {
		if got := etagOf([]byte(body)); got != want {
			t.Errorf("%q: %s, want %s", body, got, want)
		}
	}

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(ETag())
	r.GET("/x", func(c *gin.Context) { OK(c, nil, "") })
	r.GET("/fail", func(c *gin.Context) { Fail(c, NewError(404, "NOT_FOUND", "Not found.", nil)) })

	do := func(path, inm string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", path, nil)
		if inm != "" {
			req.Header.Set("If-None-Match", inm)
		}
		r.ServeHTTP(w, req)
		return w
	}
	w := do("/x", "")
	if w.Code != 200 || w.Header().Get("ETag") != `W/"h0y5c3-1n"` || w.Body.Len() == 0 {
		t.Fatalf("200: %d %v %q", w.Code, w.Header(), w.Body)
	}
	w = do("/x", `W/"h0y5c3-1n"`)
	if w.Code != http.StatusNotModified || w.Body.Len() != 0 || w.Header().Get("Content-Type") != "" || w.Header().Get("ETag") == "" {
		t.Fatalf("304: %d %v %q", w.Code, w.Header(), w.Body)
	}
	w = do("/fail", "")
	if w.Code != 404 || w.Header().Get("ETag") != "" || w.Body.Len() == 0 {
		t.Fatalf("non-200 untouched: %d %v", w.Code, w.Header())
	}
}
