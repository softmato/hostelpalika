package httpx

import (
	"net/http"
	"slices"

	"github.com/gin-gonic/gin"
)

// CORS allows the web origins to call the API with cookies (API.md §8). The app
// sends no Origin and passes straight through, as does any origin not listed:
// the browser then refuses to hand that page the answer.
func CORS(origins []string) gin.HandlerFunc {
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin == "" {
			c.Next()
			return
		}
		h := c.Writer.Header()
		h.Add("Vary", "Origin")
		if !slices.Contains(origins, origin) {
			c.Next()
			return
		}
		h.Set("Access-Control-Allow-Origin", origin)
		h.Set("Access-Control-Allow-Credentials", "true")
		// A browser hides every other response header from a cross-origin
		// fetch: browserApi reads ETag, the downloader Content-Disposition.
		h.Set("Access-Control-Expose-Headers", "Content-Disposition, ETag, Retry-After, Server-Timing")
		h.Set("Timing-Allow-Origin", origin)
		if c.Request.Method == http.MethodOptions && c.GetHeader("Access-Control-Request-Method") != "" {
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE")
			h.Set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type, If-None-Match, x-checkout-token, x-hostel-id, x-hostelhub-client")
			h.Set("Access-Control-Max-Age", "86400")
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}
