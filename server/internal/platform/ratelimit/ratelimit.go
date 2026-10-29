// Package ratelimit is lib/rate-limit.ts on Redis: a fixed window per
// namespace and client, shared by every instance (TS keeps it per instance in
// memory). Redis down → the same in-memory window TS has, never no limit.
package ratelimit

import (
	"context"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	goredis "github.com/redis/go-redis/v9"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// Auth endpoints: 5 attempts per 15 minutes per client, per endpoint.
const (
	AuthAttemptLimit  = 5
	AuthAttemptWindow = 15 * time.Minute
	maxBuckets        = 10_000
)

type Limiter struct {
	Redis *goredis.Client // nil = memory only
	// PUBLIC_FORM_RATE_LIMIT_MAX / _WINDOW_SECONDS (config.Limits).
	FormMax    int
	FormWindow time.Duration

	mu      sync.Mutex
	buckets map[string]*bucket
	now     func() time.Time
}

type bucket struct {
	count   int
	resetAt time.Time
}

func New(rdb *goredis.Client, formMax int, formWindow time.Duration) *Limiter {
	return &Limiter{Redis: rdb, FormMax: formMax, FormWindow: formWindow, buckets: map[string]*bucket{}, now: time.Now}
}

// clientKey is TS's ip:user-agent. The IP is Gin's ClientIP, which trusts
// X-Forwarded-For only from Caddy — TS took the first XFF entry as given.
func clientKey(c *gin.Context) string {
	ua := strings.TrimSpace(c.GetHeader("User-Agent"))
	if ua == "" {
		ua = "unknown-agent"
	}
	ip := c.ClientIP()
	if ip == "" {
		ip = "unknown-ip"
	}
	return ip + ":" + ua
}

// PublicForm is rateLimitPublicForm with the configured budget.
func (l *Limiter) PublicForm(c *gin.Context, namespace string) error {
	return l.Check(c, namespace, l.FormMax, l.FormWindow)
}

// AuthAttempts gives every credential- or token-guessing door the same budget,
// per door.
func (l *Limiter) AuthAttempts(c *gin.Context, namespace string) error {
	return l.Check(c, namespace, AuthAttemptLimit, AuthAttemptWindow)
}

// Check counts this request; over the limit it returns TS's 429.
func (l *Limiter) Check(c *gin.Context, namespace string, limit int, window time.Duration) error {
	key := "rl:" + namespace + ":" + clientKey(c)
	count, ttl, err := l.hitRedis(c, key, window)
	if err != nil {
		count, ttl = l.hitMemory(key, window)
	}
	if count <= limit {
		return nil
	}
	retry := int(math.Max(1, math.Ceil(ttl.Seconds())))
	return httpx.NewError(http.StatusTooManyRequests, "RATE_LIMITED",
		"Too many requests. Please wait before submitting again.",
		map[string]int{"retryAfterSeconds": retry})
}

// hitRedis: INCR, start the window on the first hit only (NX), read what is left.
func (l *Limiter) hitRedis(ctx context.Context, key string, window time.Duration) (int, time.Duration, error) {
	if l.Redis == nil {
		return 0, 0, goredis.ErrClosed
	}
	pipe := l.Redis.TxPipeline()
	incr := pipe.Incr(ctx, key)
	pipe.Do(ctx, "PEXPIRE", key, window.Milliseconds(), "NX")
	pttl := pipe.PTTL(ctx, key)
	if _, err := pipe.Exec(ctx); err != nil {
		return 0, 0, err
	}
	return int(incr.Val()), pttl.Val(), nil
}

func (l *Limiter) hitMemory(key string, window time.Duration) (int, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	b := l.buckets[key]
	if b == nil || !b.resetAt.After(now) {
		if b == nil && len(l.buckets) >= maxBuckets {
			// ponytail: evicts an arbitrary bucket (TS evicts the oldest); only
			// matters while Redis is down under a flood of new clients.
			for k := range l.buckets {
				delete(l.buckets, k)
				break
			}
		}
		b = &bucket{resetAt: now.Add(window)}
		l.buckets[key] = b
	}
	b.count++
	return b.count, b.resetAt.Sub(now)
}
