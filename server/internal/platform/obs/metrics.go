package obs

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	goredis "github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/event"
)

// Metrics live on their own port (METRICS_ADDR), which compose never publishes:
// MISSION.md §11. Labels stay bounded: route is Gin's path pattern, never the URL.
var (
	registry = prometheus.NewRegistry()

	buckets = []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30}

	httpRequests = newCounter("hostelpalika_http_requests_total", "Requests answered.", "method", "route", "status")
	httpDuration = newHistogram("hostelpalika_http_request_duration_seconds", "Time to answer a request.", "route")
	httpInFlight = newGauge("hostelpalika_http_in_flight", "Requests being answered now.")

	mongoDuration = newHistogram("hostelpalika_mongo_command_duration_seconds", "Mongo command time.", "command")
	mongoFailures = newCounter("hostelpalika_mongo_command_failures_total", "Mongo commands that failed.", "command")
	mongoPoolOut  = newGauge("hostelpalika_mongo_pool_checked_out", "Mongo connections in use (limit: MaxPoolSize).")
	mongoPoolWait = newCounter("hostelpalika_mongo_pool_checkout_failures_total", "Requests that got no Mongo connection.")

	redisDuration = newHistogram("hostelpalika_redis_command_duration_seconds", "Redis command or pipeline time.", "kind")
	redisFailures = newCounter("hostelpalika_redis_failures_total", "Redis calls that failed (a missing key is not a failure).")

	cacheLookups = newCounter("hostelpalika_cache_lookups_total", "Read-cache lookups.", "result")
	rateLimited  = newCounter("hostelpalika_rate_limited_total", "Requests refused by the rate limiter.", "namespace")

	backgroundRunning = newGauge("hostelpalika_background_running", "Background tasks running now.")
	backgroundDone    = newCounter("hostelpalika_background_tasks_total", "Background tasks finished.", "result")
)

func newCounter(name, help string, labels ...string) *prometheus.CounterVec {
	v := prometheus.NewCounterVec(prometheus.CounterOpts{Name: name, Help: help}, labels)
	registry.MustRegister(v)
	return v
}

func newHistogram(name, help string, labels ...string) *prometheus.HistogramVec {
	v := prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: name, Help: help, Buckets: buckets}, labels)
	registry.MustRegister(v)
	return v
}

func newGauge(name, help string) prometheus.Gauge {
	g := prometheus.NewGauge(prometheus.GaugeOpts{Name: name, Help: help})
	registry.MustRegister(g)
	return g
}

func init() {
	// CPU, memory, goroutines and GC.
	registry.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
}

// MetricsHandler serves the Prometheus text format.
func MetricsHandler() http.Handler { return promhttp.HandlerFor(registry, promhttp.HandlerOpts{}) }

func recordRequest(method, route string, status int, took time.Duration) {
	if route == "" {
		route = "unmatched" // a scanner's paths must not become labels
	}
	httpRequests.WithLabelValues(method, route, strconv.Itoa(status)).Inc()
	httpDuration.WithLabelValues(route).Observe(took.Seconds())
}

// CacheLookup counts one read-cache answer.
func CacheLookup(hit bool) {
	if hit {
		cacheLookups.WithLabelValues("hit").Inc()
		return
	}
	cacheLookups.WithLabelValues("miss").Inc()
}

// RateLimited counts one refusal.
func RateLimited(namespace string) { rateLimited.WithLabelValues(namespace).Inc() }

// BackgroundStarted returns the func to call when the task ends.
func BackgroundStarted() func(failed bool) {
	backgroundRunning.Inc()
	return func(failed bool) {
		backgroundRunning.Dec()
		if failed {
			backgroundDone.WithLabelValues("failed").Inc()
			return
		}
		backgroundDone.WithLabelValues("ok").Inc()
	}
}

// MongoPoolMonitor tracks pool use, the budget that runs out first under load.
func MongoPoolMonitor() *event.PoolMonitor {
	return &event.PoolMonitor{Event: func(e *event.PoolEvent) {
		switch e.Type {
		case event.ConnectionCheckedOut:
			mongoPoolOut.Inc()
		case event.ConnectionCheckedIn:
			mongoPoolOut.Dec()
		case event.ConnectionCheckOutFailed:
			mongoPoolWait.WithLabelValues().Inc()
		}
	}}
}

func recordRedis(ctx context.Context, kind string, start time.Time, err error) {
	took := time.Since(start)
	if t := from(ctx); t != nil {
		t.redis.Add(int64(took))
	}
	redisDuration.WithLabelValues(kind).Observe(took.Seconds())
	if err != nil && !errors.Is(err, goredis.Nil) {
		redisFailures.WithLabelValues().Inc()
	}
}
