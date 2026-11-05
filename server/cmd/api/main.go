// Command api is the HostelPalika HTTP API.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	_ "net/http/pprof" // registers on DefaultServeMux, served only on PPROF_ADDR
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/softmato/hostelpalika/server/internal/jobs"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/modules/platformlogs"
	"github.com/softmato/hostelpalika/server/internal/platform/background"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
	applog "github.com/softmato/hostelpalika/server/internal/platform/log"
	"github.com/softmato/hostelpalika/server/internal/platform/mongo"
	"github.com/softmato/hostelpalika/server/internal/platform/obs"
	"github.com/softmato/hostelpalika/server/internal/platform/redis"
	"github.com/softmato/hostelpalika/server/internal/router"
)

// shutdownGrace must stay under compose's stop_grace_period so in-flight
// requests finish before Docker sends SIGKILL.
const shutdownGrace = 25 * time.Second

// revision is the git commit, set at build time (-ldflags "-X main.revision=<sha>")
// so a deploy can be matched to the build that is running.
var revision = "dev"

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
	// Stored log lines (the superadmin log viewer); flushed before Mongo closes.
	stopLogs, err := applog.Attach(ctx, db)
	if err != nil {
		return err
	}
	defer stopLogs()
	go platformlogs.Watch(ctx, platformconfig.New(db), 30*time.Second)
	rdb, err := redis.Connect(ctx, cfg.RedisURL)
	if err != nil {
		return err
	}
	if rdb != nil {
		defer func() { _ = rdb.Close() }()
	}

	bg := &background.Runner{}
	// Runs end with ctx: a job still going at SIGTERM is cancelled and its row closed.
	runner := jobs.New(ctx, db, rdb)
	handler, err := router.New(cfg, router.Deps{DB: db, Redis: rdb, Background: bg, Jobs: runner})
	if err != nil {
		return err
	}
	if _, err := runner.CloseStale(ctx, time.Now()); err != nil {
		slog.Warn("stale cron runs not closed", "category", "jobs", "error", err)
	}
	if cfg.SchedulerOn {
		go runner.Schedule(ctx)
	}
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		MaxHeaderBytes:    64 << 10,          // no real client sends more; caps what a header can cost (P11-9)
		ReadTimeout:       120 * time.Second, // /files/upload takes 10 MB over Nepali mobile links
		IdleTimeout:       120 * time.Second,
		// No WriteTimeout: NDJSON progress routes stream for longer than any
		// global value; each route gets its own context deadline instead.
	}

	// pprof on its own listener (config keeps it on localhost); never on the API port.
	if cfg.PprofAddr != "" {
		go func() {
			slog.Info("pprof listening", "addr", cfg.PprofAddr)
			if err := http.ListenAndServe(cfg.PprofAddr, nil); err != nil {
				slog.Warn("pprof stopped", "error", err)
			}
		}()
	}

	if cfg.MetricsAddr != "" {
		metrics := &http.Server{Addr: cfg.MetricsAddr, Handler: obs.MetricsHandler(), ReadHeaderTimeout: 5 * time.Second}
		defer func() { _ = metrics.Close() }() // exiting; nothing left to scrape
		go func() {
			slog.Info("metrics listening", "addr", cfg.MetricsAddr)
			if err := metrics.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
				slog.Warn("metrics stopped", "error", err)
			}
		}()
	}

	errc := make(chan error, 1)
	go func() {
		slog.Info("api listening", "addr", cfg.Addr, "env", cfg.Env, "revision", revision)
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
	// Handlers are done; let their afterResponse work land before Mongo closes.
	if err := bg.Wait(sctx); err != nil {
		slog.Warn("background work still running at shutdown", "error", err)
	}
	if err := runner.Wait(sctx); err != nil {
		slog.Warn("cron runs still open at shutdown", "category", "jobs", "error", err)
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
