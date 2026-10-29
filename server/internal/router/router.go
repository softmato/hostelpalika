// Package router is the one place that knows every path (grouped like PARITY.md §6).
package router

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	goredis "github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/config"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// Deps are the process-wide clients every module reads from. Redis may be nil
// (no REDIS_URL in dev); DB is nil only in tests that don't touch data.
type Deps struct {
	DB    *mongo.Database
	Redis *goredis.Client
}

func New(cfg *config.Config, d Deps) (*gin.Engine, error) {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	// X-Forwarded-For is trusted only from Caddy (RULES.md §4); empty = trust nobody.
	if err := r.SetTrustedProxies(cfg.TrustedProxies); err != nil {
		return nil, fmt.Errorf("router: TRUSTED_PROXIES: %w", err)
	}
	// Next answers a known path with the wrong method with a bare 405: no body,
	// no content type. Gin's default writes "405 method not allowed" text.
	r.HandleMethodNotAllowed = true
	r.NoMethod(func(c *gin.Context) { c.AbortWithStatus(http.StatusMethodNotAllowed) })
	r.Use(httpx.Recover())

	v1 := r.Group("/api/v1")
	v1.GET("/health", health(d))
	return r, nil
}

type healthData struct {
	Service string `json:"service"`
	Status  string `json:"status"`
}

// The service name stays "hostelpalika-web": clients must not be able to tell
// which server answered (README golden rule 1).
//
// ?deep=1 is Go's readiness probe (TS ignores the query and answers the same
// bytes): it also pings Mongo and Redis, and a failure is a 503 so Caddy and
// the deploy wait. The plain probe stays dependency-free so a Redis blip never
// restarts the container.
func health(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Query("deep") == "1" {
			if err := ping(c, d); err != nil {
				slog.WarnContext(c, "deep health failed", "error", err)
				httpx.Fail(c, httpx.NewError(http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "Service unavailable", nil))
				return
			}
		}
		httpx.OK(c, healthData{"hostelpalika-web", "ok"}, "API is healthy")
	}
}

func ping(ctx context.Context, d Deps) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if d.DB != nil {
		if err := d.DB.Client().Ping(ctx, nil); err != nil {
			return fmt.Errorf("mongo: %w", err)
		}
	}
	if d.Redis != nil {
		if err := d.Redis.Ping(ctx).Err(); err != nil {
			return fmt.Errorf("redis: %w", err)
		}
	}
	return nil
}
