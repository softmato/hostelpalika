package obs

import (
	"math"
	"strings"
	"time"

	dto "github.com/prometheus/client_model/go"
)

var startedAt = time.Now().UTC()

// StartedAt is when this process began serving.
func StartedAt() time.Time { return startedAt }

// Health is the superadmin log page's strip: this instance's figures since it
// started, read from the same registry /metrics serves.
type Health struct {
	StartedAt             time.Time `json:"startedAt"`
	UptimeSeconds         float64   `json:"uptimeSeconds"`
	Requests              float64   `json:"requests"`
	RequestsPerMinute     float64   `json:"requestsPerMinute"`
	ServerErrors          float64   `json:"serverErrors"`
	ErrorRate             float64   `json:"errorRate"`
	P95Seconds            float64   `json:"p95Seconds"`
	InFlight              float64   `json:"inFlight"`
	MongoPoolInUse        float64   `json:"mongoPoolInUse"`
	MongoCheckoutFailures float64   `json:"mongoCheckoutFailures"`
	CacheHits             float64   `json:"cacheHits"`
	CacheMisses           float64   `json:"cacheMisses"`
	CacheHitRate          float64   `json:"cacheHitRate"`
	RateLimited           float64   `json:"rateLimited"`
	RedisFailures         float64   `json:"redisFailures"`
	BackgroundFailed      float64   `json:"backgroundFailed"`
}

// ReadHealth gathers the registry once.
// ponytail: since-boot totals, not a sliding window; a window needs a sampler
// (or Prometheus itself) once there is more than one instance to compare.
func ReadHealth() (Health, error) {
	families, err := registry.Gather()
	if err != nil {
		return Health{}, err
	}
	now := time.Now().UTC()
	h := Health{StartedAt: startedAt, UptimeSeconds: now.Sub(startedAt).Seconds()}
	var buckets map[float64]uint64
	var observed uint64
	for _, f := range families {
		for _, m := range f.GetMetric() {
			switch f.GetName() {
			case "hostelpalika_http_requests_total":
				v := m.GetCounter().GetValue()
				h.Requests += v
				if strings.HasPrefix(label(m, "status"), "5") {
					h.ServerErrors += v
				}
			case "hostelpalika_http_request_duration_seconds":
				if buckets == nil {
					buckets = map[float64]uint64{}
				}
				for _, b := range m.GetHistogram().GetBucket() {
					buckets[b.GetUpperBound()] += b.GetCumulativeCount()
				}
				observed += m.GetHistogram().GetSampleCount()
			case "hostelpalika_http_in_flight":
				h.InFlight = m.GetGauge().GetValue()
			case "hostelpalika_mongo_pool_checked_out":
				h.MongoPoolInUse = m.GetGauge().GetValue()
			case "hostelpalika_mongo_pool_checkout_failures_total":
				h.MongoCheckoutFailures += m.GetCounter().GetValue()
			case "hostelpalika_cache_lookups_total":
				if label(m, "result") == "hit" {
					h.CacheHits += m.GetCounter().GetValue()
				} else {
					h.CacheMisses += m.GetCounter().GetValue()
				}
			case "hostelpalika_rate_limited_total":
				h.RateLimited += m.GetCounter().GetValue()
			case "hostelpalika_redis_failures_total":
				h.RedisFailures += m.GetCounter().GetValue()
			case "hostelpalika_background_tasks_total":
				if label(m, "result") == "failed" {
					h.BackgroundFailed += m.GetCounter().GetValue()
				}
			}
		}
	}
	if h.Requests > 0 {
		h.ErrorRate = h.ServerErrors / h.Requests
	}
	if minutes := h.UptimeSeconds / 60; minutes > 0 {
		h.RequestsPerMinute = h.Requests / minutes
	}
	if lookups := h.CacheHits + h.CacheMisses; lookups > 0 {
		h.CacheHitRate = h.CacheHits / lookups
	}
	h.P95Seconds = quantile(buckets, observed, 0.95)
	return h, nil
}

// quantile is the upper bound of the first bucket holding q of the samples:
// coarse by the bucket layout, which is the honest answer a histogram gives.
func quantile(buckets map[float64]uint64, total uint64, q float64) float64 {
	if total == 0 {
		return 0
	}
	want := uint64(math.Ceil(q * float64(total)))
	best := math.Inf(1)
	for bound, count := range buckets {
		if count >= want && bound < best {
			best = bound
		}
	}
	if math.IsInf(best, 1) {
		return bucketsMax(buckets)
	}
	return best
}

func bucketsMax(buckets map[float64]uint64) float64 {
	m := 0.0
	for bound := range buckets {
		if !math.IsInf(bound, 1) && bound > m {
			m = bound
		}
	}
	return m
}

func label(m *dto.Metric, name string) string {
	for _, l := range m.GetLabel() {
		if l.GetName() == name {
			return l.GetValue()
		}
	}
	return ""
}
