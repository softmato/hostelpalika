package ratelimit

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

func hit(l *Limiter, ns, ua string) error {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/", nil)
	c.Request.Header.Set("User-Agent", ua)
	return l.Check(c, ns, 2, time.Minute)
}

func exercise(t *testing.T, l *Limiter, ns string) {
	for i := 0; i < 2; i++ {
		if err := hit(l, ns, "a"); err != nil {
			t.Fatalf("hit %d refused: %v", i+1, err)
		}
	}
	var e *httpx.Error
	if err := hit(l, ns, "a"); !errors.As(err, &e) || e.Status != 429 || e.ErrorCode != "RATE_LIMITED" ||
		e.Details.(map[string]int)["retryAfterSeconds"] != 60 {
		t.Fatalf("third hit: %v %+v", err, e)
	}
	if hit(l, ns, "b") != nil || hit(l, ns+"x", "a") != nil {
		t.Fatal("budgets are per client and per namespace")
	}
}

func TestMemoryFallback(t *testing.T) {
	gin.SetMode(gin.ReleaseMode)
	now := time.Unix(1_000_000, 0)
	l := New(nil, 10, time.Minute)
	l.now = func() time.Time { return now }
	exercise(t, l, "form")
	now = now.Add(time.Minute)
	if hit(l, "form", "a") != nil {
		t.Fatal("a new window starts fresh")
	}
}

// Against the compose Redis; skipped when it is down.
func TestRedis(t *testing.T) {
	gin.SetMode(gin.ReleaseMode)
	rdb := goredis.NewClient(&goredis.Options{Addr: "127.0.0.1:6380"})
	if rdb.Ping(context.Background()).Err() != nil {
		t.Skip("local Redis not running")
	}
	defer rdb.Close()
	ns := "test-" + time.Now().Format("150405.000000")
	l := New(rdb, 10, time.Minute)
	l.now = func() time.Time { t.Fatal("memory used while Redis is up"); return time.Time{} }
	exercise(t, l, ns)
	keys, _ := rdb.Keys(context.Background(), "rl:"+ns+"*").Result()
	for _, k := range keys {
		if ttl := rdb.PTTL(context.Background(), k).Val(); ttl <= 0 || ttl > time.Minute {
			t.Errorf("%s ttl %v", k, ttl)
		}
		rdb.Del(context.Background(), k)
	}
	if len(keys) != 3 {
		t.Errorf("keys %v", keys)
	}
}
