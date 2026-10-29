// Package log sets up slog: JSON to stdout, level from LOG_LEVEL.
// Redaction (tokens, cookies, personal data) arrives with Phase 1.
package log

import (
	"io"
	"log/slog"
	"os"
)

func New(level string) *slog.Logger {
	if level == "silent" {
		return slog.New(slog.NewJSONHandler(io.Discard, nil))
	}
	var l slog.Level
	_ = l.UnmarshalText([]byte(level)) // config already restricted it to debug|info|warn|error
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: l}))
}
