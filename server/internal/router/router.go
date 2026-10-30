// Package router is the one place that knows every path (grouped like PARITY.md §6).
package router

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	goredis "github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/modules/arrivals"
	authmod "github.com/softmato/hostelpalika/server/internal/modules/auth"
	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/modules/bookings"
	"github.com/softmato/hostelpalika/server/internal/modules/feedback"
	"github.com/softmato/hostelpalika/server/internal/modules/files"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelreferrals"
	"github.com/softmato/hostelpalika/server/internal/modules/hostels"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/offerprogram"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/modules/referrals"
	"github.com/softmato/hostelpalika/server/internal/modules/reports"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/modules/reviews"
	searchmod "github.com/softmato/hostelpalika/server/internal/modules/search"
	"github.com/softmato/hostelpalika/server/internal/modules/serviceproviders"
	"github.com/softmato/hostelpalika/server/internal/modules/usage"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/background"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/llm"
	"github.com/softmato/hostelpalika/server/internal/platform/maps"
	"github.com/softmato/hostelpalika/server/internal/platform/obs"
	"github.com/softmato/hostelpalika/server/internal/platform/push"
	"github.com/softmato/hostelpalika/server/internal/platform/ratelimit"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/storage"
)

// Deps are the process-wide clients every module reads from. Redis may be nil
// (no REDIS_URL in dev); DB is nil only in tests that don't touch data.
type Deps struct {
	DB    *mongo.Database
	Redis *goredis.Client
	// Tracks afterResponse work so shutdown drains it; nil in tests that run none.
	Background *background.Runner
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
	// A *gin.Context handed on as a context.Context (slog, Mongo, Redis) must
	// reach the request's own values: request id, timings.
	r.ContextWithFallback = true
	r.Use(httpx.Recover(), obs.Middleware())
	if d.Background != nil {
		r.Use(d.Background.Middleware())
	}

	v1 := r.Group("/api/v1")
	v1.GET("/health", health(d))
	if d.DB != nil {
		mountAPI(v1, cfg, d)
	}
	return r, nil
}

// mountAPI builds the platform services every module shares and mounts the
// ported route groups. Needs a database; the no-DB router serves health only.
func mountAPI(v1 *gin.RouterGroup, cfg *config.Config, d Deps) {
	bg := d.Background
	if bg == nil {
		bg = &background.Runner{}
	}
	tokens := auth.NewTokens(cfg.Auth.AccessSecret, cfg.Auth.RefreshSecret, cfg.Auth.AccessTTL, cfg.Auth.RefreshTTL)
	cookies := &auth.Cookies{Tokens: tokens, Secure: cfg.IsProduction(), Domain: cfg.CookieDomain}
	guards := authz.New(tokens, cookies, d.DB, cache.New(d.Redis), bg)
	limiter := ratelimit.New(d.Redis, cfg.Limits.PublicFormMax, cfg.Limits.PublicFormWindow)
	sender := email.NewSender(cfg.Email.ResendAPIKey, cfg.Email.Domain, cfg.Email.ReplyTo, d.DB)
	sender.PrefSecret, sender.Outbound = cfg.Auth.AccessSecret, cfg.OutboundURL()
	log := audit.New(d.DB)
	rt := realtime.New(cfg.Pusher)
	pushSender := push.New(d.DB, cfg.Push, notifications.Hooks(d.DB))
	notify := &notifications.Service{DB: d.DB, Push: pushSender, RT: rt, Cache: cache.New(d.Redis), BG: bg}

	authSvc := authmod.NewService(d.DB, cfg, tokens, auth.NewSessions(d.DB, cfg.Auth.RefreshTTL), sender, log)
	authmod.NewHandler(authSvc, guards, cookies, limiter).Register(v1)

	siteConfig := platformconfig.New(d.DB)
	platformconfig.NewHandler(siteConfig).Register(v1)
	pubHostels := hostels.NewPublic(d.DB, siteConfig)
	hostels.NewHandler(pubHostels).Register(v1)
	hostels.NewWrites(hostels.WriteDeps{DB: d.DB, Guards: guards, Limiter: limiter, Secure: cfg.IsProduction(), Public: pubHostels,
		Mail: sender, Notify: notify, RT: rt, Cache: cache.New(d.Redis), Outbound: cfg.OutboundURL()}).Register(v1)
	arrivals.NewHandler(d.DB, guards, limiter, notify).Register(v1)
	claims := files.Claims{Secret: cfg.Auth.AccessSecret}
	hostels.NewApplications(d.DB, guards, claims, log).Register(v1)
	files.NewHandler(d.DB, storage.New(cfg.R2), cfg.R2, limiter, claims).Register(v1)
	personal, _ := crypto.NewPersonal(cfg.Crypto.PersonalDataKey)
	(&residents.Public{DB: d.DB, Guards: guards, Limiter: limiter, Claims: claims, Personal: personal, Notify: notify, RT: rt, Cache: cache.New(d.Redis)}).Register(v1)
	refs := hostelreferrals.NewService(d.DB)
	bookingsSvc := bookings.NewService(d.DB, siteConfig)
	(&hostels.Registration{Refs: refs, DB: d.DB, Guards: guards, Limiter: limiter, Claims: claims, Mail: sender, Notify: notify, Audit: log, RT: rt, Cache: cache.New(d.Redis), Outbound: cfg.OutboundURL(),
		FinanceKey: cfg.Crypto.FinanceMasterKey, FinancePrev: cfg.Crypto.FinanceMasterKeyPrev, PersonalKey: cfg.Crypto.PersonalDataKey,
		ShortStayLimits: func(ctx context.Context) (float64, float64) {
			c := bookingsSvc.BookingConfig(ctx)
			return c.ShortStayMinMarkupPercent, c.ShortStayMaxNights
		}}).Register(v1)
	referrals.NewHandler(d.DB, limiter).Register(v1)
	(&serviceproviders.Handler{DB: d.DB, Guards: guards, Limiter: limiter, Claims: claims, Mail: sender, Notify: notify, Audit: log, RT: rt, Cache: cache.New(d.Redis), Outbound: cfg.OutboundURL()}).Register(v1)
	hostelreferrals.NewHandler(refs, limiter).Register(v1)
	(&hostels.Quick{DB: d.DB, Guards: guards, Limiter: limiter, Refs: refs, Config: siteConfig, Mail: sender, Notify: notify, Audit: log, SiteURL: strings.TrimRight(cfg.AppURL, "/")}).Register(v1)
	hostels.NewGeo(maps.NewClient(cfg.Google.MapsAPIKey, cfg.AppURL), guards, limiter).Register(v1)
	searchmod.NewHandler(llm.New(cfg.LLM.Keys, cfg.LLM.ProviderOrder), cfg.LLM.SearchQuotaSecret, cfg.CookieSecure).Register(v1)
	reviews.NewHandler(d.DB).Register(v1)
	reports.NewHandler(d.DB).Register(v1)
	billing.NewHandler(d.DB, siteConfig).Register(v1)
	offerprogram.NewHandler(d.DB).Register(v1)
	bookings.NewHandler(bookingsSvc).Register(v1)

	feedback.NewHandler(d.DB, guards, limiter).Register(v1)
	usage.NewHandler(d.DB, guards, limiter).Register(v1)
	notifications.NewHandler(d.DB, guards, sender, pushSender).Register(v1)
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
