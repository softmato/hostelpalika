// Package config reads every environment variable the API uses, once, at boot.
//
// It ports apps/web/src/lib/env.ts plus the variables the TS modules read
// straight from process.env. Defaults and fallback chains are copied from
// those call sites; where TS uses `??` (unset only) vs `||` (unset or empty)
// the difference is kept, because OTP hashes and activation codes have to
// match between the two servers while both are live.
//
// SEED_* are not here: Go has no seeds; local data is a copy of the live
// database (deploy/copy-live-db.ps1).
package config

import (
	"bufio"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Env      string // production | development | test (APP_ENV, replaces NODE_ENV)
	Addr     string // API_ADDR
	AppURL   string // no trailing slash
	LogLevel string // debug | info | warn | error | silent

	MongoURI    string
	RedisURL    string
	CORSOrigins []string
	// COOKIE_SECURE is read by exactly one TS route (public/search/parse);
	// session cookies take `secure` from IsProduction instead.
	CookieSecure   bool
	CookieDomain   string
	TrustedProxies []string
	SchedulerOn    bool
	PprofAddr      string

	Auth     Auth
	OTP      OTP
	Google   Google
	R2       R2
	Email    Email
	Pusher   Pusher
	Push     Push
	Uploads  Uploads
	Limits   Limits
	LLM      LLM
	Crypto   Crypto
	Evidence Evidence
	Sandbox  map[string]GatewayCredentials // ESEWA | KHALTI | FONEPAY; absent = not configured
	Softmato Softmato

	CronSecret                string
	QuestionCallWebhookSecret string
}

type Auth struct {
	AccessSecret         string
	RefreshSecret        string
	AccessTTL            time.Duration
	RefreshTTL           time.Duration
	ActivationCodeSecret string // ACTIVATION_CODE_SECRET ?? JWT_ACCESS_SECRET
}

type OTP struct {
	TTL             time.Duration
	ResendCooldown  time.Duration
	RateLimitWindow time.Duration
	RateLimitMax    int
	HashSecret      string // OTP_HASH_SECRET ?? JWT_ACCESS_SECRET
}

type Google struct {
	ClientID          string
	ClientSecret      string
	MapsAPIKey        string
	DriveClientID     string // GOOGLE_DRIVE_CLIENT_ID || GOOGLE_CLIENT_ID
	DriveClientSecret string // GOOGLE_DRIVE_CLIENT_SECRET || GOOGLE_CLIENT_SECRET
}

type R2 struct {
	Endpoint        string
	AccessKeyID     string
	SecretAccessKey string
	BucketPublic    string
	// Reachable only through presigned reads. Must never get a public URL.
	BucketPrivate string
	KeyPrefix     string
	PublicURL     string
	CORSOrigins   []string
}

func (r R2) Configured() bool {
	return r.Endpoint != "" && r.AccessKeyID != "" && r.SecretAccessKey != "" && r.BucketPublic != "" && r.BucketPrivate != ""
}

type Email struct {
	ResendAPIKey string
	Domain       string // the only part of the sender kept in env; the rest is site config
	ReplyTo      string
}

type Pusher struct {
	AppID, Key, Secret, Cluster string
}

// Configured: with any of the four missing, realtime no-ops and portals poll.
func (p Pusher) Configured() bool {
	return p.AppID != "" && p.Key != "" && p.Secret != "" && p.Cluster != ""
}

type Push struct {
	VAPIDPublicKey  string
	VAPIDPrivateKey string
	VAPIDSubject    string
	ExpoAccessToken string
}

// Uploads mirrors fileAssetLimits() in packages/shared/src/utils/file-assets.ts.
type Uploads struct {
	MaxImageBytes, MaxDocumentBytes, MaxVideoBytes, MaxAudioBytes int64
	ImageMIME, DocumentMIME, VideoMIME, AudioMIME                 []string
}

type Limits struct {
	PublicFormMax    int
	PublicFormWindow time.Duration
}

type LLM struct {
	Keys              map[string][]string // provider → comma-separated keys from <PROVIDER>_API_KEYS
	ProviderOrder     []string
	SearchQuotaSecret string // SEARCH_QUOTA_SECRET || CRON_SECRET
}

type Crypto struct {
	PersonalDataKey      string // 32 bytes, base64 or hex; decoded by internal/platform/crypto
	FinanceMasterKey     string
	FinanceMasterKeyPrev string
}

type Evidence struct {
	OCR              bool   // EVIDENCE_OCR != "off"
	Engine           string // lower-cased
	VisionSAKey      string
	VisionRegion     string // lower-cased
	VisionTimeout    time.Duration
	VisionMonthlyCap int // <= 0 means no cap, as in TS
	GeminiModels     []string
	GeminiTimeout    time.Duration
	GeminiMonthlyCap int
}

type GatewayCredentials struct {
	MerchantCode  string
	Secret        string
	WebhookSecret string // <P>_SANDBOX_WEBHOOK_SECRET ?? secret
}

type Softmato struct {
	BaseURL, Secret, WebhookSecret string
}

func (c *Config) IsProduction() bool { return c.Env == "production" }

// Load reads ./.env (when present) into the process env without overriding
// anything already set, then parses the process env.
func Load() (*Config, []string, error) {
	if err := loadDotenv(".env"); err != nil {
		return nil, nil, err
	}
	return Parse(os.LookupEnv)
}

// Parse builds the config from lookup and returns non-fatal warnings beside it.
func Parse(lookup func(string) (string, bool)) (*Config, []string, error) {
	r := reader{lookup: lookup}
	c := &Config{}

	c.Env = r.str("APP_ENV")
	if c.Env == "" {
		c.Env = "development"
	}
	if c.Env != "production" && c.Env != "development" && c.Env != "test" {
		r.fail("APP_ENV must be production, development or test")
	}
	c.Addr = r.str("API_ADDR")
	if c.Addr == "" {
		c.Addr = ":8080"
	}

	c.AppURL = strings.TrimRight(r.str("APP_URL"), "/")
	if u, err := url.Parse(c.AppURL); err != nil || u.Scheme == "" || u.Host == "" {
		r.fail("APP_URL must be an absolute URL")
	}

	c.LogLevel = strings.ToLower(r.str("LOG_LEVEL"))
	switch c.LogLevel {
	case "debug", "info", "warn", "error", "silent":
	default:
		c.LogLevel = "debug"
		if c.IsProduction() {
			c.LogLevel = "info"
		}
	}

	c.MongoURI = r.str("MONGODB_URI")
	if c.MongoURI == "" {
		r.fail("MONGODB_URI is required")
	} else if !c.IsProduction() && strings.Contains(c.MongoURI, ".mongodb.net") {
		// ponytail: any Atlas host is refused outside production, so a dev Atlas
		// cluster can't be used either; add an explicit allow-list if one appears.
		r.fail("MONGODB_URI points at Atlas while APP_ENV=" + c.Env + "; dev and test use a local Mongo (RULES.md §6)")
	}
	c.RedisURL = r.str("REDIS_URL")
	c.CORSOrigins = r.list("CORS_ORIGINS")
	c.CookieSecure = r.str("COOKIE_SECURE") == "true"
	c.CookieDomain = r.str("COOKIE_DOMAIN")
	c.TrustedProxies = r.list("TRUSTED_PROXIES")
	c.SchedulerOn = r.str("SCHEDULER_ENABLED") == "true"
	c.PprofAddr = r.str("PPROF_ADDR")

	access, accessSet := lookup("JWT_ACCESS_SECRET")
	c.Auth = Auth{
		AccessSecret:         access,
		RefreshSecret:        r.str("JWT_REFRESH_SECRET"),
		AccessTTL:            r.ttl("ACCESS_TOKEN_TTL", 15*time.Minute),
		RefreshTTL:           r.ttl("REFRESH_TOKEN_TTL", 30*24*time.Hour),
		ActivationCodeSecret: r.coalesce("ACTIVATION_CODE_SECRET", access),
	}
	if !accessSet || len(access) < 32 {
		r.fail("JWT_ACCESS_SECRET must be at least 32 characters")
	}
	if len(c.Auth.RefreshSecret) < 32 {
		r.fail("JWT_REFRESH_SECRET must be at least 32 characters")
	}

	c.OTP = OTP{
		TTL:             time.Duration(r.int("OTP_TTL_MINUTES", 10)) * time.Minute,
		ResendCooldown:  time.Duration(r.int("OTP_RESEND_COOLDOWN_SECONDS", 60)) * time.Second,
		RateLimitWindow: time.Duration(r.int("OTP_RATE_LIMIT_WINDOW_MINUTES", 15)) * time.Minute,
		RateLimitMax:    r.int("OTP_RATE_LIMIT_MAX", 5),
		HashSecret:      r.coalesce("OTP_HASH_SECRET", access),
	}

	c.Google = Google{
		ClientID:          r.str("GOOGLE_CLIENT_ID"),
		ClientSecret:      r.str("GOOGLE_CLIENT_SECRET"),
		MapsAPIKey:        r.str("GOOGLE_MAPS_API_KEY"),
		DriveClientID:     or(r.str("GOOGLE_DRIVE_CLIENT_ID"), r.str("GOOGLE_CLIENT_ID")),
		DriveClientSecret: or(r.str("GOOGLE_DRIVE_CLIENT_SECRET"), r.str("GOOGLE_CLIENT_SECRET")),
	}

	c.R2 = R2{
		Endpoint:        r.str("R2_ENDPOINT"),
		AccessKeyID:     r.str("R2_ACCESS_KEY_ID"),
		SecretAccessKey: r.str("R2_SECRET_ACCESS_KEY"),
		BucketPublic:    r.str("R2_BUCKET_PUBLIC"),
		BucketPrivate:   r.str("R2_BUCKET_PRIVATE"),
		KeyPrefix:       strings.Trim(r.str("R2_KEY_PREFIX"), "/"),
		PublicURL:       strings.TrimRight(r.str("R2_PUBLIC_URL"), "/"),
		CORSOrigins:     r.list("R2_CORS_ORIGINS"),
	}

	c.Email = Email{
		ResendAPIKey: r.str("RESEND_API_KEY"),
		Domain:       strings.TrimSpace(r.str("EMAIL_DOMAIN")),
		ReplyTo:      strings.TrimSpace(r.str("EMAIL_REPLY_TO")),
	}
	c.Pusher = Pusher{r.str("PUSHER_APP_ID"), r.str("PUSHER_KEY"), r.str("PUSHER_SECRET"), r.str("PUSHER_CLUSTER")}
	c.Push = Push{
		VAPIDPublicKey:  strings.TrimSpace(r.str("VAPID_PUBLIC_KEY")),
		VAPIDPrivateKey: strings.TrimSpace(r.str("VAPID_PRIVATE_KEY")),
		VAPIDSubject:    strings.TrimSpace(r.str("VAPID_SUBJECT")),
		ExpoAccessToken: strings.TrimSpace(r.str("EXPO_ACCESS_TOKEN")),
	}

	c.Uploads = Uploads{
		MaxImageBytes:    r.positive("UPLOAD_MAX_IMAGE_BYTES", 5<<20),
		MaxDocumentBytes: r.positive("UPLOAD_MAX_DOCUMENT_BYTES", 10<<20),
		MaxVideoBytes:    r.positive("UPLOAD_MAX_VIDEO_BYTES", 50<<20),
		MaxAudioBytes:    r.positive("UPLOAD_MAX_AUDIO_BYTES", 10<<20),
		ImageMIME:        r.mime("ALLOWED_IMAGE_MIME_TYPES", DefaultImageMIME),
		DocumentMIME:     r.mime("ALLOWED_DOCUMENT_MIME_TYPES", DefaultDocumentMIME),
		VideoMIME:        r.mime("ALLOWED_VIDEO_MIME_TYPES", DefaultVideoMIME),
		AudioMIME:        r.mime("ALLOWED_AUDIO_MIME_TYPES", DefaultAudioMIME),
	}

	formMax := 10
	if c.Env == "test" {
		formMax = 1000
	}
	c.Limits = Limits{
		PublicFormMax:    int(r.positive("PUBLIC_FORM_RATE_LIMIT_MAX", int64(formMax))),
		PublicFormWindow: time.Duration(r.positive("PUBLIC_FORM_RATE_LIMIT_WINDOW_SECONDS", 60)) * time.Second,
	}

	c.CronSecret = r.str("CRON_SECRET")
	c.LLM = LLM{Keys: map[string][]string{}, ProviderOrder: r.list("LLM_PROVIDER_ORDER")}
	for _, p := range []string{"cerebras", "gemini", "groq", "mistral", "openrouter"} {
		if keys := r.list(strings.ToUpper(p) + "_API_KEYS"); len(keys) > 0 {
			c.LLM.Keys[p] = keys
		}
	}
	c.LLM.SearchQuotaSecret = or(r.str("SEARCH_QUOTA_SECRET"), c.CronSecret)

	c.Crypto = Crypto{
		PersonalDataKey:      r.str("PERSONAL_DATA_ENCRYPTION_KEY"),
		FinanceMasterKey:     r.str("FINANCE_MASTER_KEY"),
		FinanceMasterKeyPrev: r.str("FINANCE_MASTER_KEY_PREVIOUS"),
	}

	c.Evidence = Evidence{
		OCR:              r.str("EVIDENCE_OCR") != "off",
		Engine:           strings.ToLower(r.str("EVIDENCE_ENGINE")),
		VisionSAKey:      r.str("GCP_VISION_SA_KEY"),
		VisionRegion:     strings.ToLower(r.str("GCP_VISION_REGION")),
		VisionTimeout:    time.Duration(r.int("EVIDENCE_VISION_TIMEOUT_MS", 6000)) * time.Millisecond,
		VisionMonthlyCap: r.int("EVIDENCE_VISION_MONTHLY_CAP", 5000),
		GeminiModels:     r.list("EVIDENCE_GEMINI_MODEL"),
		GeminiTimeout:    time.Duration(r.int("EVIDENCE_GEMINI_TIMEOUT_MS", 15000)) * time.Millisecond,
		GeminiMonthlyCap: r.int("EVIDENCE_GEMINI_MONTHLY_CAP", 5000),
	}

	// Sandbox gateway credentials (modules/finance/gateway/secret-store.ts).
	// eSewa publishes public test credentials, so it has defaults; the others don't.
	c.Sandbox = map[string]GatewayCredentials{}
	for _, p := range []struct{ name, code, secret string }{
		{"ESEWA", "EPAYTEST", "8gBm/:&EnhH.1/q"},
		{"FONEPAY", "", ""},
		{"KHALTI", "", ""},
	} {
		code := r.coalesce(p.name+"_SANDBOX_MERCHANT_CODE", p.code)
		secret := r.coalesce(p.name+"_SANDBOX_SECRET", p.secret)
		if code != "" && secret != "" {
			c.Sandbox[p.name] = GatewayCredentials{code, secret, r.coalesce(p.name+"_SANDBOX_WEBHOOK_SECRET", secret)}
		}
	}

	c.Softmato = Softmato{
		BaseURL:       strings.TrimSpace(r.str("SOFTMATO_BASE_URL")),
		Secret:        strings.TrimSpace(r.str("SOFTMATO_SECRET")),
		WebhookSecret: strings.TrimSpace(r.str("SOFTMATO_WEBHOOK_SECRET")),
	}
	c.QuestionCallWebhookSecret = strings.TrimSpace(r.str("QUESTIONCALL_WEBHOOK_SECRET"))

	var warnings []string
	if c.IsProduction() {
		// Absent in production these mean broken, not degraded: every upload
		// throws or every scheduled job answers 500.
		var missing []string
		for _, k := range []string{"R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_PUBLIC", "R2_BUCKET_PRIVATE", "CRON_SECRET", "REDIS_URL"} {
			if r.str(k) == "" {
				missing = append(missing, k)
			}
		}
		if len(missing) > 0 {
			r.fail("missing required production environment: " + strings.Join(missing, ", "))
		}
		warnings = productionWarnings(r)
	}

	if len(r.errs) > 0 {
		return nil, nil, fmt.Errorf("config: %w", errors.Join(r.errs...))
	}
	return c, warnings, nil
}

// Missing in production, one feature silently degrades; warned, not refused.
func productionWarnings(r reader) []string {
	var out []string
	for _, w := range []struct {
		keys        []string
		consequence string
	}{
		{[]string{"PUSHER_APP_ID", "PUSHER_KEY", "PUSHER_SECRET", "PUSHER_CLUSTER"}, "realtime is off — portals fall back to polling and the notification bell updates late"},
		{[]string{"RESEND_API_KEY"}, "no email is delivered — OTPs, invitations, receipts and every notification email are dropped"},
		{[]string{"EMAIL_DOMAIN"}, "email falls back to the softmato.com sending domain — correct for a Softmato deployment, wrong for anyone else, and unverified domains bounce"},
		{[]string{"PERSONAL_DATA_ENCRYPTION_KEY"}, "resident identity profiles cannot be read or written — the endpoints fail with a clear message"},
		{[]string{"FINANCE_MASTER_KEY"}, "no hostel can enable a payment gateway — the per-hostel secrets have nothing to wrap them"},
	} {
		allMissing := true
		for _, k := range w.keys {
			if r.str(k) != "" {
				allMissing = false
			}
		}
		if allMissing {
			out = append(out, strings.Join(w.keys, ", ")+" not set — "+w.consequence+".")
		}
	}
	return out
}

var (
	DefaultImageMIME    = []string{"image/jpeg", "image/png", "image/webp"}
	DefaultVideoMIME    = []string{"video/mp4", "video/webm", "video/quicktime"}
	DefaultAudioMIME    = []string{"audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac", "audio/webm"}
	DefaultDocumentMIME = []string{
		"application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain", "text/csv",
		// application/octet-stream is deliberately absent: it would let any binary
		// through every document upload, payment proofs and ID documents included.
		"application/vnd.ms-excel",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	}
)

type reader struct {
	lookup func(string) (string, bool)
	errs   []error
}

func (r *reader) fail(msg string) { r.errs = append(r.errs, errors.New(msg)) }

func (r *reader) str(k string) string { v, _ := r.lookup(k); return v }

// coalesce is TS `??`: the fallback applies only when k is unset, not when empty.
func (r *reader) coalesce(k, fallback string) string {
	if v, ok := r.lookup(k); ok {
		return v
	}
	return fallback
}

// or is TS `||`.
func or(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func (r *reader) list(k string) []string {
	var out []string
	for _, s := range strings.Split(r.str(k), ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func (r *reader) mime(k string, fallback []string) []string {
	out := r.list(k)
	for i := range out {
		out[i] = strings.ToLower(out[i])
	}
	if len(out) == 0 {
		return fallback
	}
	return out
}

// int: unset → fallback; set but not an integer → boot error (TS would carry NaN).
func (r *reader) int(k string, fallback int) int {
	v := strings.TrimSpace(r.str(k))
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		r.fail(k + " must be an integer")
	}
	return n
}

func (r *reader) positive(k string, fallback int64) int64 {
	n := int64(r.int(k, int(fallback)))
	if n <= 0 {
		r.fail(k + " must be a positive integer")
	}
	return n
}

var ttlPattern = regexp.MustCompile(`^(\d+)([smhd])$`)

// ttl ports parseDurationSeconds in lib/auth.ts: plain seconds or `<n>[smhd]`.
// TS silently falls back on anything else; here that is a boot error.
func (r *reader) ttl(k string, fallback time.Duration) time.Duration {
	d, ok := parseTTL(r.str(k), fallback)
	if !ok {
		r.fail(k + ` must be seconds or <n>s|m|h|d, e.g. "15m"`)
	}
	return d
}

func parseTTL(v string, fallback time.Duration) (time.Duration, bool) {
	if v == "" {
		return fallback, true
	}
	if secs, err := strconv.ParseFloat(v, 64); err == nil {
		return time.Duration(secs * float64(time.Second)), true
	}
	m := ttlPattern.FindStringSubmatch(v)
	if m == nil {
		return fallback, false
	}
	n, _ := strconv.Atoi(m[1]) // regexp guarantees digits
	unit := map[string]time.Duration{"s": time.Second, "m": time.Minute, "h": time.Hour, "d": 24 * time.Hour}[m[2]]
	return time.Duration(n) * unit, true
}

// loadDotenv sets KEY=VALUE lines from path into the process env, never
// overriding a variable that is already set. A missing file is not an error:
// in Docker the env comes from compose.
func loadDotenv(path string) error {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	defer f.Close() //nolint:errcheck // read-only

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		k, v, ok := parseDotenvLine(sc.Text())
		if !ok {
			continue
		}
		if _, set := os.LookupEnv(k); !set {
			if err := os.Setenv(k, v); err != nil {
				return fmt.Errorf("config: %w", err)
			}
		}
	}
	return sc.Err()
}

func parseDotenvLine(line string) (key, value string, ok bool) {
	line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "export "))
	if line == "" || line[0] == '#' {
		return "", "", false
	}
	key, value, ok = strings.Cut(line, "=")
	if !ok {
		return "", "", false
	}
	key, value = strings.TrimSpace(key), strings.TrimSpace(value)
	if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
		value = value[1 : len(value)-1]
	} else if i := strings.Index(value, " #"); i >= 0 {
		value = strings.TrimSpace(value[:i])
	}
	return key, value, key != ""
}
