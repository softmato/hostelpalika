package httpx

import (
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// ProgressType is the stream a hand-off screen asks for in Accept.
const ProgressType = "application/x-ndjson"

// Progress is progressResponse. A caller that accepts ProgressType gets one JSON
// line per step as it starts, then {"data": …} or {"error": {errorCode, message}}
// mapped exactly as Fail would. Anyone else gets the ordinary envelope.
func Progress(c *gin.Context, message string, run func(step func(name string)) (any, error)) {
	if !strings.Contains(c.GetHeader("accept"), ProgressType) {
		out, err := run(func(string) {})
		if err != nil {
			Fail(c, err)
			return
		}
		OK(c, out, message)
		return
	}
	h := c.Writer.Header()
	h.Set("Cache-Control", "private, no-store")
	h.Set("Content-Type", ProgressType+"; charset=utf-8")
	h.Set("X-Accel-Buffering", "no")
	c.Status(200)
	send := func(v any) {
		if line, err := enc.Marshal(v); err == nil {
			_, _ = c.Writer.Write(append(line, '\n'))
			c.Writer.Flush()
		}
	}
	out, err := run(func(name string) { send(ordered.Map{{Key: "step", Value: name}}) })
	if err != nil {
		_, f := describe(c, err)
		send(ordered.Map{{Key: "error", Value: ordered.Map{{Key: "errorCode", Value: f.ErrorCode}, {Key: "message", Value: f.Message}}}})
		return
	}
	send(ordered.Map{{Key: "data", Value: out}})
}
