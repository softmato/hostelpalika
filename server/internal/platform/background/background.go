// Package background is lib/after-response.ts: work that must finish but that
// the caller must not wait for. Every goroutine is tracked, so shutdown drains
// it (Wait) instead of dropping it — Go's version of Vercel's after().
package background

import (
	"context"
	"log/slog"
	"sync"

	"github.com/gin-gonic/gin"
)

type Runner struct{ wg sync.WaitGroup }

const queueKey = "background.after"

// Go runs fn now on a tracked goroutine, detached from the request's
// cancellation. Never fails anyone: errors and panics are logged and dropped —
// the caller's durable record is already written.
func (r *Runner) Go(ctx context.Context, fn func(context.Context) error) {
	// Gin recycles its Context once the request ends; never hold one.
	if c, ok := ctx.(*gin.Context); ok {
		ctx = c.Request.Context()
	}
	ctx = context.WithoutCancel(ctx)
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		defer func() {
			if p := recover(); p != nil {
				slog.ErrorContext(ctx, "background work panicked", "panic", p)
			}
		}()
		if err := fn(ctx); err != nil {
			slog.WarnContext(ctx, "background work failed", "error", err)
		}
	}()
}

// After is afterResponse: inside a request (Middleware installed) fn runs once
// the handler chain has finished; anywhere else (cron, script) it runs now.
func (r *Runner) After(ctx context.Context, fn func(context.Context) error) {
	if c, ok := ctx.(*gin.Context); ok {
		if q, ok := c.Get(queueKey); ok {
			*q.(*[]func(context.Context) error) = append(*q.(*[]func(context.Context) error), fn)
			return
		}
	}
	r.Go(ctx, fn)
}

// Middleware collects a request's After work and starts each, as after() does,
// once the handlers are done.
func (r *Runner) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		var q []func(context.Context) error
		c.Set(queueKey, &q)
		c.Next()
		for _, fn := range q {
			r.Go(c.Request.Context(), fn)
		}
	}
}

// Wait drains every tracked goroutine, or gives up when ctx ends.
func (r *Runner) Wait(ctx context.Context) error {
	done := make(chan struct{})
	go func() { r.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
