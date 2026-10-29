package cache

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	goredis "github.com/redis/go-redis/v9"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// Against the compose Redis; skipped when it is down.
func TestRespond(t *testing.T) {
	ctx := context.Background()
	rdb := goredis.NewClient(&goredis.Options{Addr: "127.0.0.1:6380"})
	if rdb.Ping(ctx).Err() != nil {
		t.Skip("local Redis not running")
	}
	defer rdb.Close()
	gin.SetMode(gin.ReleaseMode)
	c := New(rdb)
	hostel := "respond-" + time.Now().Format("150405.000000")
	defer rdb.Del(ctx, versionKey(hostel), "r:"+hostel+":0:u:list", "r:"+hostel+":1:u:list")

	loads := 0
	fail := false
	r := gin.New()
	r.GET("/x", func(g *gin.Context) {
		Respond(g, c, []string{hostel}, "u", "list", "Rooms", func() ([]string, error) {
			loads++
			if fail {
				return nil, errors.New("boom")
			}
			return []string{"a<b"}, nil
		})
	})
	get := func(inm string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/x", nil)
		if inm != "" {
			req.Header.Set("If-None-Match", inm)
		}
		r.ServeHTTP(w, req)
		return w
	}
	want := `{"success":true,"message":"Rooms","data":["a<b"]}`
	w := get("")
	if w.Code != 200 || w.Body.String() != want || w.Header().Get("ETag") != httpx.ETagOf([]byte(want)) || loads != 1 {
		t.Fatalf("miss: %d %q %v loads=%d", w.Code, w.Body, w.Header(), loads)
	}
	tag := w.Header().Get("ETag")
	if w = get(tag); w.Code != 304 || w.Body.Len() != 0 || loads != 1 {
		t.Fatalf("revalidation must 304 without loading: %d loads=%d", w.Code, loads)
	}
	if w = get(""); w.Body.String() != want || loads != 1 {
		t.Fatalf("hit must replay the bytes: %q loads=%d", w.Body, loads)
	}
	c.Bump(ctx, hostel)
	if w = get(tag); w.Code != 304 || loads != 2 {
		t.Fatalf("after a bump the body is rebuilt (same body, same tag → 304): %d loads=%d", w.Code, loads)
	}
	c.Bump(ctx, hostel)
	fail = true
	if w = get(""); w.Code != 500 {
		t.Fatalf("a failed load is the error envelope: %d", w.Code)
	}
}
