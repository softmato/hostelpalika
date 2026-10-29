// Package obs is the request-lifecycle telemetry of ARCHITECTURE.md §2/§12:
// request id, Server-Timing (app, db, redis) and one log line per request.
package obs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	goredis "github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/event"

	applog "github.com/softmato/hostelpalika/server/internal/platform/log"
)

type timingsKey struct{}

// timings sums Mongo and Redis time spent under one request (parallel calls
// add up, so db can exceed app).
type timings struct{ db, redis atomic.Int64 }

func from(ctx context.Context) *timings {
	t, _ := ctx.Value(timingsKey{}).(*timings)
	return t
}

// Middleware: Caddy's X-Request-Id (or a minted one) goes on every log line;
// Server-Timing is set as the first byte goes out; the request is logged once.
// The router must set ContextWithFallback so a *gin.Context passed as ctx
// (to slog, Mongo, Redis) reaches these values.
func Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		id := c.GetHeader("X-Request-Id")
		if !validID(id) {
			id = mint()
		}
		t := &timings{}
		ctx := context.WithValue(applog.WithRequestID(c.Request.Context(), id), timingsKey{}, t)
		c.Request = c.Request.WithContext(ctx)
		c.Writer = &timingWriter{ResponseWriter: c.Writer, start: start, t: t}

		c.Next()

		level := slog.LevelInfo
		if c.Request.URL.Path == "/api/v1/health" {
			level = slog.LevelDebug // probes every few seconds
		}
		attrs := []slog.Attr{
			slog.String("method", c.Request.Method),
			slog.String("route", c.FullPath()),
			slog.Int("status", c.Writer.Status()),
			slog.Float64("app_ms", ms(time.Since(start))),
			slog.Float64("db_ms", ms(time.Duration(t.db.Load()))),
			slog.Float64("redis_ms", ms(time.Duration(t.redis.Load()))),
		}
		if uid := c.GetString(PrincipalIDKey); uid != "" {
			attrs = append(attrs, slog.String("user", uid))
		}
		slog.LogAttrs(c, level, "request", attrs...)
	}
}

// PrincipalIDKey: a guard stores the user id here for the request log line.
const PrincipalIDKey = "obs.user"

func validID(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for _, r := range s {
		if !(r == '-' || r == '_' || r == '.' || '0' <= r && r <= '9' || 'a' <= r && r <= 'z' || 'A' <= r && r <= 'Z') {
			return false
		}
	}
	return true
}

func mint() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()/100) / 10 }

// timingWriter sets Server-Timing just before the header goes out. Gin's own
// writer writes the header from inside Write, so every write path is wrapped.
type timingWriter struct {
	gin.ResponseWriter
	start time.Time
	t     *timings
	done  bool
}

func (w *timingWriter) stamp() {
	if w.done {
		return
	}
	w.done = true
	w.Header().Set("Server-Timing", fmt.Sprintf("app;dur=%.1f, db;dur=%.1f, redis;dur=%.1f",
		ms(time.Since(w.start)), ms(time.Duration(w.t.db.Load())), ms(time.Duration(w.t.redis.Load()))))
}

func (w *timingWriter) WriteHeaderNow()             { w.stamp(); w.ResponseWriter.WriteHeaderNow() }
func (w *timingWriter) Write(b []byte) (int, error) { w.stamp(); return w.ResponseWriter.Write(b) }
func (w *timingWriter) WriteString(s string) (int, error) {
	w.stamp()
	return w.ResponseWriter.WriteString(s)
}
func (w *timingWriter) Flush() { w.stamp(); w.ResponseWriter.Flush() }

// MongoMonitor adds every command's duration to its request's db time.
func MongoMonitor() *event.CommandMonitor {
	add := func(ctx context.Context, d time.Duration) {
		if t := from(ctx); t != nil {
			t.db.Add(int64(d))
		}
	}
	return &event.CommandMonitor{
		Succeeded: func(ctx context.Context, e *event.CommandSucceededEvent) { add(ctx, e.Duration) },
		Failed:    func(ctx context.Context, e *event.CommandFailedEvent) { add(ctx, e.Duration) },
	}
}

// RedisHook adds every command's (and pipeline's) duration to redis time.
type RedisHook struct{}

func (RedisHook) DialHook(next goredis.DialHook) goredis.DialHook {
	return func(ctx context.Context, network, addr string) (net.Conn, error) { return next(ctx, network, addr) }
}

func (RedisHook) ProcessHook(next goredis.ProcessHook) goredis.ProcessHook {
	return func(ctx context.Context, cmd goredis.Cmder) error {
		start := time.Now()
		err := next(ctx, cmd)
		if t := from(ctx); t != nil {
			t.redis.Add(int64(time.Since(start)))
		}
		return err
	}
}

func (RedisHook) ProcessPipelineHook(next goredis.ProcessPipelineHook) goredis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []goredis.Cmder) error {
		start := time.Now()
		err := next(ctx, cmds)
		if t := from(ctx); t != nil {
			t.redis.Add(int64(time.Since(start)))
		}
		return err
	}
}
