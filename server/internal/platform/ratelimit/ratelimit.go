// Package ratelimit is lib/rate-limit.ts on Redis: a fixed window per
// namespace and client, shared by every instance (TS keeps it per instance in
// memory). Redis down → the same in-memory window TS has, never no limit.
package ratelimit

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	goredis "github.com/redis/go-redis/v9"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/obs"
)

// Auth endpoints: 5 attempts per 15 minutes per client, per endpoint.
const (
	AuthAttemptLimit  = 5
	AuthAttemptWindow = 15 * time.Minute
	// redisWait matches cache.Timeout: Redis is a same-host hop.
	redisWait      = 150 * time.Millisecond
	maxBuckets     = 10_000
	ipBudgetFactor = 6
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
	// Hashed: the header is client-sized, and a raw one in every key let one IP
	// fill Redis (or the memory fallback) with megabyte keys (P11-9).
	sum := sha256.Sum256([]byte(ua))
	return clientIP(c) + ":" + hex.EncodeToString(sum[:8])
}

func clientIP(c *gin.Context) string {
	if ip := c.ClientIP(); ip != "" {
		return ip
	}
	return "unknown-ip"
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

// Check counts this request; over either budget it returns TS's 429. The
// user-agent keeps one hostel's Wi-Fi from sharing one budget, but a client picks
// its own, so one IP also has a total across every user-agent (TS's bug: rotate
// the header and the limit was gone). Same ratio as lib/auth-attempts.ts.
func (l *Limiter) Check(c *gin.Context, namespace string, limit int, window time.Duration) error {
	ttl, over := l.hit(c, "rl:"+namespace+":"+clientKey(c), limit, window)
	if ttlIP, overIP := l.hit(c, "rl:"+namespace+":ip:"+clientIP(c), limit*ipBudgetFactor, window); overIP {
		ttl, over = ttlIP, true
	}
	if !over {
		return nil
	}
	retry := int(math.Max(1, math.Ceil(ttl.Seconds())))
	obs.RateLimited(namespace)
	return httpx.NewError(http.StatusTooManyRequests, "RATE_LIMITED",
		"Too many requests. Please wait before submitting again.",
		map[string]int{"retryAfterSeconds": retry})
}

func (l *Limiter) hit(ctx context.Context, key string, limit int, window time.Duration) (time.Duration, bool) {
	// A hung Redis costs a request at most this before the memory fallback; on the
	// client's own read timeout and retries it cost ~1.3 s per hit, two per request (P10-12).
	rctx, cancel := context.WithTimeout(ctx, redisWait)
	count, ttl, err := l.hitRedis(rctx, key, window)
	cancel()
	if err != nil {
		count, ttl = l.hitMemory(key, window)
	}
	return ttl, count > limit
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
