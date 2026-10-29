// Package redis owns the process's single Redis client: the in-compose
// container, production included (ARCHITECTURE.md §5).
package redis

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

// Connect parses REDIS_URL and pings once. Redis is fail-open (DESIGN.md §1
// rule 10): an unreachable server at boot is logged, not fatal; go-redis
// redials on use and every caller falls back to Mongo. An empty URL (dev
// without the container) returns nil, which callers treat as "no Redis".
//
// Timeouts are tight because the server is a same-host hop: anything slower
// than this is broken, and a read should go to Mongo rather than wait.
func Connect(ctx context.Context, url string) (*redis.Client, error) {
	if url == "" {
		return nil, nil
	}
	opt, err := redis.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("redis: REDIS_URL: %w", err)
	}
	opt.DialTimeout = 2 * time.Second
	opt.ReadTimeout = 500 * time.Millisecond
	opt.WriteTimeout = 500 * time.Millisecond
	opt.MinIdleConns = 4
	client := redis.NewClient(opt)

	pctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := client.Ping(pctx).Err(); err != nil {
		slog.Warn("redis unreachable at boot; serving without cache until it answers", "error", err)
	}
	return client, nil
}
