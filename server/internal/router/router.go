// Package router is the one place that knows every path (grouped like PARITY.md §6).
package router

import (
	"context"
	"fmt"
	"log/slog"
	stdmaps "maps"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	goredis "github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/jobs"
	"github.com/softmato/hostelpalika/server/internal/modules/arrivals"
	"github.com/softmato/hostelpalika/server/internal/modules/attendance"
	authmod "github.com/softmato/hostelpalika/server/internal/modules/auth"
	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/modules/bookings"
	"github.com/softmato/hostelpalika/server/internal/modules/community"
	"github.com/softmato/hostelpalika/server/internal/modules/complaints"
	"github.com/softmato/hostelpalika/server/internal/modules/expenses"
	"github.com/softmato/hostelpalika/server/internal/modules/feedback"
	"github.com/softmato/hostelpalika/server/internal/modules/files"
	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/guardian"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelleave"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelreferrals"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelresidents"
	"github.com/softmato/hostelpalika/server/internal/modules/hostels"
	"github.com/softmato/hostelpalika/server/internal/modules/khata"
	"github.com/softmato/hostelpalika/server/internal/modules/kitchen"
	"github.com/softmato/hostelpalika/server/internal/modules/notices"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/offerprogram"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/modules/platformlogs"
	"github.com/softmato/hostelpalika/server/internal/modules/questioncall"
	"github.com/softmato/hostelpalika/server/internal/modules/referrals"
	"github.com/softmato/hostelpalika/server/internal/modules/reports"
	"github.com/softmato/hostelpalika/server/internal/modules/residentaccount"
	"github.com/softmato/hostelpalika/server/internal/modules/residentfinance"
	"github.com/softmato/hostelpalika/server/internal/modules/residentportal"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/modules/reviews"
	"github.com/softmato/hostelpalika/server/internal/modules/safety"
	searchmod "github.com/softmato/hostelpalika/server/internal/modules/search"
	"github.com/softmato/hostelpalika/server/internal/modules/serviceproviders"
	"github.com/softmato/hostelpalika/server/internal/modules/stock"
	"github.com/softmato/hostelpalika/server/internal/modules/store"
	"github.com/softmato/hostelpalika/server/internal/modules/team"
	"github.com/softmato/hostelpalika/server/internal/modules/usage"
	"github.com/softmato/hostelpalika/server/internal/modules/users"
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
	"github.com/softmato/hostelpalika/server/internal/platform/softmato"
	"github.com/softmato/hostelpalika/server/internal/platform/storage"
)

// Deps are the process-wide clients every module reads from. Redis may be nil
// (no REDIS_URL in dev); DB is nil only in tests that don't touch data.
type Deps struct {
	DB    *mongo.Database
	Redis *goredis.Client
	// RedisCache holds cached responses only; nil = Redis.
	RedisCache *goredis.Client
	// Tracks afterResponse work so shutdown drains it; nil in tests that run none.
	Background *background.Runner
	// Jobs runs the scheduled jobs and their /cron doors; nil builds one bound to
	// no shutdown (tests).
	Jobs *jobs.Runner
}

// routeBudgets are the routes allowed past httpx.DefaultDeadline: TS's maxDuration,
// and the upload doors, which read a body over slow mobile links first. Keys are
// Gin paths; TestRouteBudgetsAreRoutes catches a typo.
var routeBudgets = map[string]time.Duration{
	"/api/v1/hostel-admin/backup":                       300 * time.Second,
	"/api/v1/hostel-admin/backup/runs/:runId/file":      120 * time.Second,
	"/api/v1/account/hostel-leave/:requestId/files/zip": 300 * time.Second,
	"/api/v1/files/upload":                              120 * time.Second,
	"/api/v1/public/files/upload":                       120 * time.Second,
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
	r.NoRoute(httpx.NotFound)
	// A *gin.Context handed on as a context.Context (slog, Mongo, Redis) must
	// reach the request's own values: request id, timings.
	r.ContextWithFallback = true
	budgets := stdmaps.Clone(routeBudgets)
	r.Use(httpx.Recover(), httpx.Deadline(budgets), obs.Middleware(), httpx.SecurityHeaders(), httpx.CORS(cfg.CORSOrigins), httpx.BodyLimit())
	if d.Background != nil {
		r.Use(d.Background.Middleware())
	}

	v1 := r.Group("/api/v1")
	v1.GET("/health", health(d))
	if d.DB != nil {
		if d.Jobs == nil {
			d.Jobs = jobs.New(context.Background(), d.DB, d.Redis)
		}
		mountAPI(v1, cfg, d)
		stdmaps.Copy(budgets, jobs.Paths(d.Jobs.Jobs()))
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
	guards := authz.New(tokens, cookies, d.DB, cache.New(d.Redis, d.RedisCache), bg)
	limiter := ratelimit.New(d.Redis, cfg.Limits.PublicFormMax, cfg.Limits.PublicFormWindow)
	sender := email.NewSender(cfg.Email.ResendAPIKey, cfg.Email.Domain, cfg.Email.ReplyTo, d.DB)
	sender.PrefSecret, sender.Outbound = cfg.Auth.AccessSecret, cfg.OutboundURL()
	log := audit.New(d.DB)
	rt := realtime.New(cfg.Pusher)
	pushSender := push.New(d.DB, cfg.Push, notifications.Hooks(d.DB))
	notify := &notifications.Service{DB: d.DB, Push: pushSender, RT: rt, Cache: cache.New(d.Redis, d.RedisCache), BG: bg}

	authSvc := authmod.NewService(d.DB, cfg, tokens, auth.NewSessions(d.DB, cfg.Auth.RefreshTTL), sender, log)
	authmod.NewHandler(authSvc, guards, cookies, limiter).Register(v1)

	siteConfig := platformconfig.New(d.DB)
	if !cfg.InProcessCache {
		siteConfig.TTL = 0
		guards.GateTTL = 0
	}
	platformconfig.NewHandler(siteConfig).Register(v1)
	pubHostels := hostels.NewPublic(d.DB, siteConfig)
	pubHostels.Cache = cache.New(d.Redis, d.RedisCache)
	pubHostels.MediaURL = cfg.R2.PublicURL
	hostels.NewHandler(pubHostels).Register(v1)
	hostels.NewWrites(hostels.WriteDeps{DB: d.DB, Guards: guards, Limiter: limiter, Secure: cfg.IsProduction(), Public: pubHostels,
		Mail: sender, Notify: notify, RT: rt, Cache: cache.New(d.Redis, d.RedisCache), Outbound: cfg.OutboundURL()}).Register(v1)
	arrivals.NewHandler(d.DB, guards, limiter, notify).Register(v1)
	claims := files.Claims{Secret: cfg.Auth.AccessSecret}
	hostels.NewApplications(d.DB, guards, claims, log).Register(v1)
	files.NewHandler(d.DB, storage.New(cfg.R2), cfg.R2, limiter, claims).Register(v1)
	(&files.Assets{DB: d.DB, R2: storage.New(cfg.R2), R2Cfg: cfg.R2, Limits: cfg.Uploads, Guards: guards, Claims: claims}).Register(v1)
	personal, _ := crypto.NewPersonal(cfg.Crypto.PersonalDataKey)
	(&residents.Public{DB: d.DB, Guards: guards, Limiter: limiter, Claims: claims, Personal: personal, Notify: notify, RT: rt, Cache: cache.New(d.Redis, d.RedisCache)}).Register(v1)
	refs := hostelreferrals.NewService(d.DB)
	bookingsSvc := bookings.NewService(d.DB, siteConfig)
	(&hostels.Registration{Refs: refs, DB: d.DB, Guards: guards, Limiter: limiter, Claims: claims, Mail: sender, Notify: notify, Audit: log, RT: rt, Cache: cache.New(d.Redis, d.RedisCache), Outbound: cfg.OutboundURL(),
		FinanceKey: cfg.Crypto.FinanceMasterKey, FinancePrev: cfg.Crypto.FinanceMasterKeyPrev, PersonalKey: cfg.Crypto.PersonalDataKey,
		ShortStayLimits: func(ctx context.Context) (float64, float64) {
			c := bookingsSvc.BookingConfig(ctx)
			return c.ShortStayMinMarkupPercent, c.ShortStayMaxNights
		}}).Register(v1)
	referrals.NewHandler(d.DB, limiter).Register(v1)
	(&serviceproviders.Handler{DB: d.DB, Guards: guards, Limiter: limiter, Claims: claims, Mail: sender, Notify: notify, Audit: log, RT: rt, Cache: cache.New(d.Redis, d.RedisCache), Outbound: cfg.OutboundURL()}).Register(v1)
	refHandler := hostelreferrals.NewHandler(refs, limiter)
	refHandler.Cover = hostels.ExteriorPhoto
	refHandler.Register(v1)
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
	platformlogs.NewHandler(d.DB, guards).Register(v1)
	(&team.Handler{DB: d.DB, Guards: guards, Config: siteConfig, Audit: log, RT: rt, Now: time.Now}).Register(v1)
	(&store.Handler{DB: d.DB, Guards: guards, Config: siteConfig, Notify: notify, Push: pushSender, Mail: sender, Audit: log, RT: rt, Bump: cache.New(d.Redis, d.RedisCache),
		SiteURL: strings.TrimRight(cfg.AppURL, "/"), Now: time.Now}).Register(v1)

	deletion := &users.Deletion{DB: d.DB, Guards: guards, Tokens: tokens, Mail: sender, Audit: log, Notify: notify, Now: time.Now,
		AppURL: func(path string) string { return residents.AppURL(cfg.OutboundURL(), path) }}
	deletion.Register(v1)
	(&users.SelfService{DB: d.DB, Guards: guards, Limiter: limiter, Mail: sender, Audit: log, Now: time.Now,
		HasProfile: (&hostelresidents.Service{DB: d.DB}).HasProfile,
		SupportEmail: func(ctx context.Context) string {
			v, err := siteConfig.Section(ctx, "identity")
			var id struct {
				SupportEmail string `json:"supportEmail"`
			}
			if err != nil || platformconfig.Decode(v, &id) != nil {
				return ""
			}
			return id.SupportEmail
		}}).Register(v1)

	safetySvc := &safety.Service{DB: d.DB, Guards: guards, Tokens: tokens, Notify: notify, Mail: sender, Audit: log, RT: rt, Cache: cache.New(d.Redis, d.RedisCache),
		AppURL: func(path string) string { return residents.AppURL(cfg.OutboundURL(), path) }}
	safetySvc.Register(v1)
	portal := &residentportal.Handler{DB: d.DB, Guards: guards, Cache: cache.New(d.Redis, d.RedisCache), Safety: safetySvc, Notify: notify, Audit: log, Config: siteConfig, RT: rt, Bump: cache.New(d.Redis, d.RedisCache)}
	portal.Register(v1)
	(&residentaccount.Handler{DB: d.DB, Guards: guards, Limiter: limiter, Auth: authSvc, Cookies: cookies, Audit: log, Notify: notify, Mail: sender, ActivationSecret: cfg.Auth.ActivationCodeSecret}).Register(v1)
	issuer := &users.Issuer{DB: d.DB, Mail: sender, Audit: log, AppURL: strings.TrimRight(cfg.AppURL, "/")}
	appURL := func(path string) string { return residents.AppURL(cfg.OutboundURL(), path) }
	(&hostelleave.Handler{DB: d.DB, Config: siteConfig, Guards: guards, R2: storage.New(cfg.R2), BG: bg, Mail: sender, Audit: log, AppURL: appURL}).Register(v1)
	(&residentfinance.Handler{DB: d.DB, Guards: guards, Production: cfg.IsProduction(), Limiter: limiter, Notify: notify, Audit: log, RT: rt, Bump: cache.New(d.Redis, d.RedisCache), R2: storage.New(cfg.R2),
		Reader: &finance.Reader{DB: d.DB, Cfg: cfg.Evidence, GeminiKeys: cfg.LLM.Keys["gemini"]}}).Register(v1)
	(&expenses.Handler{DB: d.DB, Guards: guards, Notify: notify, Audit: log, RT: rt, Bump: cache.New(d.Redis, d.RedisCache)}).Register(v1)
	(&khata.Handler{DB: d.DB, Guards: guards, Notify: notify, RT: rt, Bump: cache.New(d.Redis, d.RedisCache), Cache: cache.New(d.Redis, d.RedisCache)}).Register(v1)
	(&stock.Handler{DB: d.DB, Guards: guards, Notify: notify, RT: rt, Bump: cache.New(d.Redis, d.RedisCache)}).Register(v1)
	(&community.Handler{DB: d.DB, Guards: guards, Notify: notify, RT: rt, Bump: cache.New(d.Redis, d.RedisCache), BG: bg, LLM: llm.New(cfg.LLM.Keys, cfg.LLM.ProviderOrder)}).Register(v1)
	(&guardian.Service{DB: d.DB, Guards: guards, Notify: notify, Mail: sender, Audit: log, Issuer: issuer, AppURL: appURL}).Register(v1)
	kitchenH := &kitchen.Handler{DB: d.DB, Guards: guards, Cache: cache.New(d.Redis, d.RedisCache), Notify: notify, Push: pushSender, Audit: log, Config: siteConfig, RT: rt, Issuer: issuer}
	kitchenH.Register(v1)
	(&notices.Handler{DB: d.DB, Guards: guards, Cache: cache.New(d.Redis, d.RedisCache)}).Register(v1)
	complaintsSvc := &complaints.Service{DB: d.DB, Guards: guards, Notify: notify, Mail: sender, Audit: log, Config: siteConfig, RT: rt, Cache: cache.New(d.Redis, d.RedisCache), AppURL: appURL}
	complaintsSvc.Register(v1)
	(&attendance.Handler{DB: d.DB, Guards: guards, Audit: log}).Register(v1)
	notifications.NewHandler(d.DB, guards, sender, pushSender, rt, cfg.Pusher).Register(v1)
	sh := &shared{Cfg: cfg, D: d, BG: bg, Tokens: tokens, Cookies: cookies, Guards: guards, Limiter: limiter, Mail: sender, Audit: log, RT: rt, Push: pushSender, Notify: notify,
		Cache: cache.New(d.Redis, d.RedisCache), R2: storage.New(cfg.R2), Config: siteConfig, Claims: claims, Personal: personal, Refs: refs, Bookings: bookingsSvc, Safety: safetySvc, Issuer: issuer, Auth: authSvc,
		Evidence: &finance.Reader{DB: d.DB, Cfg: cfg.Evidence, GeminiKeys: cfg.LLM.Keys["gemini"]}, LLM: llm.New(cfg.LLM.Keys, cfg.LLM.ProviderOrder), AppURL: appURL, Outbound: cfg.OutboundURL(),
		J: &jobHosts{Safety: safetySvc, Portal: portal, Kitchen: kitchenH, Complaints: complaintsSvc, Deletion: deletion}}
	mountHostelAdmin(v1, sh)
	signedBookings := &bookings.Signed{Service: bookingsSvc, Softmato: softmato.New(cfg.Softmato.BaseURL, cfg.Softmato.Secret, cfg.Softmato.WebhookSecret), Guards: guards, Limiter: limiter, Notify: notify, Mail: sender, Audit: log, RT: rt, Bump: cache.New(d.Redis, d.RedisCache), Outbound: cfg.OutboundURL(),
		FinanceKeys: func() ([]crypto.MasterKey, error) {
			return crypto.MasterKeys(cfg.Crypto.FinanceMasterKey, cfg.Crypto.FinanceMasterKeyPrev)
		}, SoftmatoOn: cfg.Softmato.BaseURL != "" && cfg.Softmato.Secret != "" && cfg.Softmato.WebhookSecret != ""}
	signedBookings.Register(v1)
	(&questioncall.Handler{DB: d.DB, Secret: cfg.QuestionCallWebhookSecret, Now: time.Now}).Register(v1)
	settler := &billing.Settler{Service: &billing.Service{DB: d.DB, SiteURL: strings.TrimRight(cfg.AppURL, "/"), SoftmatoBase: cfg.Softmato.BaseURL,
		Softmato: softmato.New(cfg.Softmato.BaseURL, cfg.Softmato.Secret, cfg.Softmato.WebhookSecret), Config: siteConfig, Audit: log, Mail: sender, Outbound: cfg.OutboundURL(),
		PayLinkSecret: cfg.Auth.AccessSecret},
		GoLive: func(ctx context.Context, hostelID bson.ObjectID) error {
			return refs.GoLive(ctx, hostelID, notify, log, time.Now())
		},
		Now: time.Now}
	(&billing.Webhooks{Settler: settler, Secret: strings.TrimSpace(cfg.Softmato.WebhookSecret),
		SettleBooking: func(ctx context.Context, invoiceNo string) (string, string, bool, error) {
			return signedBookings.SettleFromSoftmato(ctx, invoiceNo, time.Now())
		}}).Register(v1)
	(&hostels.RegistrationBilling{DB: d.DB, Guards: guards, Settler: settler}).Register(v1)
	(&billing.PlanCheckout{Settler: settler, Limiter: limiter, RequestOTP: authSvc.PlanCheckoutOTP, VerifyOTP: authSvc.VerifiedIdentifier, Cooldown: authSvc.ResendCooldown, ClaimValid: claims.Valid}).Register(v1)
	mountPlatform(v1, sh, settler)
	sh.J.Gateway = mountGateway(v1, sh)
	sh.J.Bookings, sh.J.Plans = signedBookings, settler.Service
	mountJobs(v1, sh)
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
