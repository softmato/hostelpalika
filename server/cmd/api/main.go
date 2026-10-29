// Command api is the HostelPalika HTTP API.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/softmato/hostelpalika/server/internal/platform/config"
	applog "github.com/softmato/hostelpalika/server/internal/platform/log"
	"github.com/softmato/hostelpalika/server/internal/platform/mongo"
	"github.com/softmato/hostelpalika/server/internal/platform/redis"
	"github.com/softmato/hostelpalika/server/internal/router"
)

// shutdownGrace must stay under compose's stop_grace_period so in-flight
// requests finish before Docker sends SIGKILL.
const shutdownGrace = 25 * time.Second

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	if err := run(); err != nil {
		slog.Error("api stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, warnings, err := config.Load()
	if err != nil {
		return err
	}
	slog.SetDefault(applog.New(cfg.LogLevel))
	for _, w := range warnings {
		slog.Warn(w)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Mongo is opened before the listener so the pool is warm for the first
	// request and a bad URI fails boot. Closed after Shutdown drains handlers.
	mc, db, err := mongo.Connect(ctx, cfg.MongoURI)
	if err != nil {
		return err
	}
	defer func() { _ = mc.Disconnect(context.Background()) }() // exiting; nothing left to save
	rdb, err := redis.Connect(ctx, cfg.RedisURL)
	if err != nil {
		return err
	}
	if rdb != nil {
		defer func() { _ = rdb.Close() }()
	}

	handler, err := router.New(cfg, router.Deps{DB: db, Redis: rdb})
	if err != nil {
		return err
	}
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second, // uploads go to R2 presigned; API bodies are small
		IdleTimeout:       120 * time.Second,
		// No WriteTimeout: NDJSON progress routes stream for longer than any
		// global value; each route gets its own context deadline instead.
	}

	errc := make(chan error, 1)
	go func() {
		slog.Info("api listening", "addr", cfg.Addr, "env", cfg.Env)
		errc <- srv.ListenAndServe()
	}()

	select {
	case err := <-errc:
		return err // failed to bind
	case <-ctx.Done():
	}

	slog.Info("shutting down")
	sctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	if err := srv.Shutdown(sctx); err != nil {
		return err
	}
	if err := <-errc; !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	slog.Info("stopped cleanly")
	return nil
}

// healthcheck is the container probe (Dockerfile HEALTHCHECK), so the runtime
// image needs no curl. It reads only API_ADDR, not the full config.
func healthcheck() int {
	addr := os.Getenv("API_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	client := http.Client{Timeout: 2 * time.Second}
	res, err := client.Get("http://" + addr + "/api/v1/health")
	if err != nil {
		return 1
	}
	_ = res.Body.Close() // probe only; nothing to recover
	if res.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
