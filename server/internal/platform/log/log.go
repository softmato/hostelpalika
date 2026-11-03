// Package log sets up slog: JSON to stdout, level from LOG_LEVEL, the request
// id on every line logged with a request's context, credentials and personal
// data redacted, a category on every line, and (once Attach runs) warn-and-up
// lines kept in Mongo for the superadmin log viewer.
package log

import (
	"context"
	"io"
	"log/slog"
	"os"
	"runtime"
	"strings"
	"sync/atomic"
)

type ctxKey struct{}

// WithRequestID tags ctx so every log line under it carries the id.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, ctxKey{}, id)
}

func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(ctxKey{}).(string)
	return id
}

// Categories is the one list a line's category comes from (PHASES.md Phase 7).
var Categories = []string{"http", "auth", "security", "payments", "email", "push", "realtime",
	"database", "redis", "storage", "jobs", "llm"}

func isCategory(s string) bool {
	for _, c := range Categories {
		if c == s {
			return true
		}
	}
	return false
}

// byPackage: a line with no "category" attr takes the category of the package
// that logged it; first match wins, anything unlisted is "http".
var byPackage = []struct{ path, cat string }{
	{"/platform/authz", "security"}, {"/platform/ratelimit", "security"}, {"/platform/crypto", "security"},
	{"/platform/auth", "auth"}, {"/modules/auth", "auth"},
	{"/platform/email", "email"},
	{"/platform/push", "push"}, {"/modules/noticepushes", "push"},
	{"/platform/realtime", "realtime"},
	{"/platform/mongo", "database"},
	{"/platform/redis", "redis"}, {"/platform/cache", "redis"},
	{"/platform/storage", "storage"}, {"/platform/images", "storage"}, {"/modules/files", "storage"},
	{"/platform/background", "jobs"},
	{"/platform/llm", "llm"},
	{"/platform/softmato", "payments"}, {"/modules/finance", "payments"}, {"/modules/billing", "payments"},
	{"/modules/ledger", "payments"}, {"/modules/residentfinance", "payments"}, {"/modules/khata", "payments"},
}

func categoryOf(pc uintptr) string {
	if pc == 0 {
		return "http"
	}
	f, _ := runtime.CallersFrames([]uintptr{pc}).Next()
	for _, p := range byPackage {
		if strings.Contains(f.Function, p.path) {
			return p.cat
		}
	}
	return "http"
}

var (
	global    slog.LevelVar
	overrides atomic.Pointer[map[string]slog.Level]
	floor     atomic.Int64 // the lowest level any category accepts, for Enabled
)

// SetCategoryLevels replaces the per-category levels (site config `logs`);
// a category left out follows LOG_LEVEL. Safe to call while logging.
func SetCategoryLevels(m map[string]slog.Level) {
	low := global.Level()
	for _, l := range m {
		low = min(low, l)
	}
	overrides.Store(&m)
	floor.Store(int64(low))
}

func threshold(cat string) slog.Level {
	if m := overrides.Load(); m != nil {
		if l, ok := (*m)[cat]; ok {
			return l
		}
	}
	return global.Level()
}

func New(level string) *slog.Logger { return NewTo(os.Stdout, level) }

func NewTo(w io.Writer, level string) *slog.Logger {
	if level == "silent" {
		w = io.Discard
	}
	var l slog.Level
	_ = l.UnmarshalText([]byte(level)) // config already restricted it to debug|info|warn|error
	global.Set(l)
	SetCategoryLevels(nil)
	base := slog.NewJSONHandler(w, &slog.HandlerOptions{Level: slog.LevelDebug, ReplaceAttr: redact})
	return slog.New(handler{Handler: base})
}

// Keys whose values never reach a log line, stdout or store, whatever logged
// them (RULES.md: no tokens, cookies, passwords, PINs, OTPs, personal data or
// coordinates).
var secret = map[string]bool{
	"authorization": true, "cookie": true, "set-cookie": true, "password": true, "secret": true,
	"token": true, "accesstoken": true, "refreshtoken": true, "pin": true, "otp": true,
	"email": true, "phone": true, "mobile": true, "address": true, "dob": true, "citizenship": true,
	"lat": true, "lng": true, "latitude": true, "longitude": true, "coords": true, "coordinates": true,
}

func redact(_ []string, a slog.Attr) slog.Attr {
	if secret[strings.ToLower(a.Key)] {
		return slog.String(a.Key, "[redacted]")
	}
	return a
}

type handler struct {
	slog.Handler
	pre []slog.Attr // WithAttrs values, which the store needs and the record lacks
}

func (h handler) Enabled(_ context.Context, l slog.Level) bool { return int64(l) >= floor.Load() }

func (h handler) Handle(ctx context.Context, r slog.Record) error {
	cat, operational := "", false
	scan := func(a slog.Attr) bool {
		switch a.Key {
		case "category":
			cat = a.Value.String()
		case "operational":
			operational = a.Value.Kind() == slog.KindBool && a.Value.Bool()
		}
		return true
	}
	for _, a := range h.pre {
		scan(a)
	}
	r.Attrs(scan)
	if !isCategory(cat) {
		cat = categoryOf(r.PC)
	}
	if r.Level < threshold(cat) {
		return nil
	}
	out := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
	r.Attrs(func(a slog.Attr) bool {
		if a.Key != "category" && a.Key != "operational" {
			out.AddAttrs(a)
		}
		return true
	})
	out.AddAttrs(slog.String("category", cat))
	id := RequestID(ctx)
	if id != "" {
		out.AddAttrs(slog.String("request_id", id))
	}
	if r.Level >= slog.LevelWarn || operational {
		keep(r, h.pre, cat, id)
	}
	return h.Handler.Handle(ctx, out)
}

func (h handler) WithAttrs(as []slog.Attr) slog.Handler {
	return handler{h.Handler.WithAttrs(as), append(h.pre[:len(h.pre):len(h.pre)], as...)}
}

// ponytail: groups are flattened in the store; nothing here logs under one.
func (h handler) WithGroup(n string) slog.Handler { return handler{h.Handler.WithGroup(n), h.pre} }
