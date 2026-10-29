// Package cache is lib/redis-cache.ts on the in-compose Redis: per-user reads
// cached under their hostel's version, so one INCR (Bump) skips every cached
// read of that hostel. Key and value format are TS's exactly (ARCHITECTURE.md §5).
// Nil Redis or any Redis failure falls through to the loader, never an error.
package cache

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"time"

	"github.com/bytedance/sonic"
	goredis "github.com/redis/go-redis/v9"
	"golang.org/x/sync/singleflight"
)

const (
	TTL = 60 * time.Second
	// Longest Redis may take before the request goes to Mongo instead.
	Timeout = 150 * time.Millisecond
)

type Cache struct {
	Redis *goredis.Client // nil = no cache
	group singleflight.Group
}

func New(rdb *goredis.Client) *Cache { return &Cache{Redis: rdb} }

func versionKey(hostelID string) string { return "v:hostel:" + hostelID }

// Read is cachedRead. hostelIDs is the narrowed principal's; a request spanning
// several hostels is not cached. Concurrent misses on one key share one load.
func Read[T any](ctx context.Context, c *Cache, hostelIDs []string, userID, key string, load func() (T, error)) (T, error) {
	if c == nil || c.Redis == nil || len(hostelIDs) != 1 {
		return load()
	}
	hostelID := hostelIDs[0]

	tctx, cancel := context.WithTimeout(ctx, Timeout)
	version, err := c.Redis.Get(tctx, versionKey(hostelID)).Result()
	cancel()
	if errors.Is(err, goredis.Nil) {
		version, err = "0", nil
	}
	if err != nil {
		return load()
	}
	if _, perr := strconv.ParseInt(version, 10, 64); perr != nil {
		return load()
	}
	cacheKey := "c:" + hostelID + ":" + version + ":" + userID + ":" + key

	tctx, cancel = context.WithTimeout(ctx, Timeout)
	raw, err := c.Redis.Get(tctx, cacheKey).Bytes()
	cancel()
	if err == nil {
		// Wrapped so a cached null reads as a hit, not a miss.
		var hit struct {
			Value T `json:"value"`
		}
		if sonic.Unmarshal(raw, &hit) == nil {
			return hit.Value, nil
		}
	} else if !errors.Is(err, goredis.Nil) {
		return load()
	}

	v, err, _ := c.group.Do(cacheKey, func() (any, error) {
		value, err := load()
		if err != nil {
			return value, err
		}
		if b, merr := sonic.Marshal(struct {
			Value T `json:"value"`
		}{value}); merr == nil {
			// Detached from the request: a client that hung up still leaves the answer.
			sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), Timeout)
			_ = c.Redis.Set(sctx, cacheKey, b, TTL).Err()
			cancel()
		}
		return value, nil
	})
	if err != nil {
		var zero T
		if t, ok := v.(T); ok {
			return t, err
		}
		return zero, err
	}
	return v.(T), nil
}

// Bump is bumpHostelCache: skips every cached read of these hostels. Never fails.
func (c *Cache) Bump(ctx context.Context, hostelIDs ...string) {
	if c == nil || c.Redis == nil {
		return
	}
	var ids []string
	for _, id := range hostelIDs {
		if id != "" && !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return
	}
	tctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), Timeout)
	defer cancel()
	pipe := c.Redis.Pipeline()
	for _, id := range ids {
		pipe.Incr(tctx, versionKey(id))
	}
	_, _ = pipe.Exec(tctx)
}
