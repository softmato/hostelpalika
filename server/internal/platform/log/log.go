// Package log sets up slog: JSON to stdout, level from LOG_LEVEL, the request
// id on every line logged with a request's context, and credentials redacted.
package log

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
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

func New(level string) *slog.Logger { return NewTo(os.Stdout, level) }

func NewTo(w io.Writer, level string) *slog.Logger {
	if level == "silent" {
		w = io.Discard
	}
	var l slog.Level
	_ = l.UnmarshalText([]byte(level)) // config already restricted it to debug|info|warn|error
	return slog.New(handler{slog.NewJSONHandler(w, &slog.HandlerOptions{Level: l, ReplaceAttr: redact})})
}

// Keys whose values never reach a log line, whatever logged them.
var secret = map[string]bool{
	"authorization": true, "cookie": true, "set-cookie": true, "password": true, "secret": true,
	"token": true, "accesstoken": true, "refreshtoken": true, "pin": true, "otp": true,
}

func redact(_ []string, a slog.Attr) slog.Attr {
	if secret[strings.ToLower(a.Key)] {
		return slog.String(a.Key, "[redacted]")
	}
	return a
}

type handler struct{ slog.Handler }

func (h handler) Handle(ctx context.Context, r slog.Record) error {
	if id := RequestID(ctx); id != "" {
		r.AddAttrs(slog.String("request_id", id))
	}
	return h.Handler.Handle(ctx, r)
}

func (h handler) WithAttrs(as []slog.Attr) slog.Handler { return handler{h.Handler.WithAttrs(as)} }
func (h handler) WithGroup(n string) slog.Handler       { return handler{h.Handler.WithGroup(n)} }
