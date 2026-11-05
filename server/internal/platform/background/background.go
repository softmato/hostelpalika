// Package background is lib/after-response.ts: work that must finish but that
// the caller must not wait for. Every goroutine is tracked, so shutdown drains
// it (Wait) instead of dropping it — Go's version of Vercel's after().
package background

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/platform/obs"
)

type Runner struct{ wg sync.WaitGroup }

const (
	queueKey = "background.after"
	// taskDeadline is the longest maxDuration a TS route had; after() died with it.
	// Without one a hung provider call would hold its goroutine for ever.
	taskDeadline = 5 * time.Minute
	// maxRunning bounds concurrent work, so a burst queues here instead of
	// exhausting the Mongo pool and the providers.
	maxRunning = 256
)

var slots = make(chan struct{}, maxRunning)

// parallelLimit is how many of one Parallel call's fns run at once: a job that
// fans out per hostel must not take the whole Mongo pool from requests (P11-14).
const parallelLimit = 16

// Parallel runs fns on goroutines, at most parallelLimit at a time, and waits
// for all of them. A panic in one is logged and costs only that one: a bare
// `go` would take the process.
func Parallel(ctx context.Context, fns ...func()) {
	var wg sync.WaitGroup
	sem := make(chan struct{}, parallelLimit)
	for _, fn := range fns {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			defer func() {
				if p := recover(); p != nil {
					slog.ErrorContext(ctx, "parallel work panicked", "panic", p)
				}
			}()
			fn()
		}()
	}
	wg.Wait()
}

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
		slots <- struct{}{}
		defer func() { <-slots }()
		ctx, cancel := context.WithTimeout(ctx, taskDeadline)
		defer cancel()
		done, failed := obs.BackgroundStarted(), true
		defer func() { done(failed) }()
		defer func() {
			if p := recover(); p != nil {
				slog.ErrorContext(ctx, "background work panicked", "panic", p)
			}
		}()
		if err := fn(ctx); err != nil {
			slog.WarnContext(ctx, "background work failed", "error", err)
			return
		}
		failed = false
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
