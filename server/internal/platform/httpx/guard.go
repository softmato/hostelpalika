package httpx

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	// JSONBodyLimit is what Vercel let through to the TS routes (4.5 MB).
	JSONBodyLimit = 5 << 20
	// FormBodyLimit fits the largest upload door (10 MB) plus multipart framing.
	FormBodyLimit = 12 << 20
	// DefaultDeadline bounds a request that has no entry in the route's budget.
	DefaultDeadline = 30 * time.Second
	// writeGrace leaves time to send the 504 after the handler's context ends.
	writeGrace = 5 * time.Second
)

// BodyLimit stops a client from filling memory: every read past the limit
// fails, and Fail turns that into a 413.
func BodyLimit() gin.HandlerFunc {
	return func(c *gin.Context) {
		limit := int64(JSONBodyLimit)
		if strings.HasPrefix(c.ContentType(), "multipart/") {
			limit = FormBodyLimit
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		c.Next()
	}
}

// Deadline gives every request a bounded life, so a stuck Mongo or provider
// cannot pin a goroutine and a pool connection for ever. budgets holds the
// routes that may run longer (TS's maxDuration), by Gin path. Install it before
// anything that wraps the writer: the write deadline needs Gin's own writer.
func Deadline(budgets map[string]time.Duration) gin.HandlerFunc {
	return func(c *gin.Context) {
		d, ok := budgets[c.FullPath()]
		if !ok {
			d = DefaultDeadline
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), d)
		defer cancel()
		c.Request = c.Request.WithContext(ctx)
		// Unsupported only under httptest. A slow reader must not hold the handler.
		_ = http.NewResponseController(c.Writer).SetWriteDeadline(time.Now().Add(d + writeGrace))
		c.Next()
	}
}

// SecurityHeaders is next.config.ts SECURITY_HEADERS, which Next adds to every
// API response, plus its noindex on the public JSON.
func SecurityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.Writer.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(self), interest-cohort=()")
		h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		h.Set("Cross-Origin-Opener-Policy", "same-origin-allow-popups")
		if strings.HasPrefix(c.Request.URL.Path, "/api/v1/public/") {
			h.Set("X-Robots-Tag", "noindex")
		}
		c.Next()
	}
}

// NotFound answers a path no route serves in the API's own envelope.
func NotFound(c *gin.Context) {
	abort(c, http.StatusNotFound, failure{false, "Not found", "NOT_FOUND", nil})
}
