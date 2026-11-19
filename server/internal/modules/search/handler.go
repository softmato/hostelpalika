// Package search is public/search/parse: the hero search's sentence → listing
// filters (lib/search wired to its route).
package search

import (
	"time"

	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/llm"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/ratelimit"
	lib "github.com/softmato/hostelpalika/server/internal/platform/search"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// confidenceFloor: above this the keyword pass explained the query well enough
// that an LLM call would only add latency and burn quota.
const confidenceFloor = 0.6

// llmWindow is the cookie quota's window, kept by the server per client.
const llmWindow = 5 * time.Hour

type Handler struct {
	router  *llm.Router
	quota   lib.Quota
	secure  bool // COOKIE_SECURE === "true"
	limiter *ratelimit.Limiter
}

func NewHandler(router *llm.Router, quotaSecret string, secure bool, limiter *ratelimit.Limiter) *Handler {
	return &Handler{router, lib.Quota{Secret: quotaSecret}, secure, limiter}
}

// serverBudget is the quota a client cannot drop. The cookie one starts fresh
// the moment a script stops sending the cookie, and every call is billed.
func (h *Handler) serverBudget(c *gin.Context) bool {
	return h.limiter == nil || h.limiter.Check(c, "search-llm", lib.QuotaLimit, llmWindow) == nil
}

func (h *Handler) Register(v1 *gin.RouterGroup) { v1.POST("/public/search/parse", h.parse) }

type quotaOut struct {
	Limit     int    `json:"limit"`
	Remaining int    `json:"remaining"`
	ResetsAt  string `json:"resetsAt"`
}

type parsed struct {
	Filters lib.Filters `json:"filters"`
	Quota   quotaOut    `json:"quota"`
	Source  string      `json:"source"`
}

// parse answers most queries from keywords; only one it cannot explain reaches
// the LLM, and only while the visitor has quota left. A spent quota degrades
// quietly to the keyword result — it never becomes an error.
func (h *Handler) parse(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	query, _ := f.Str("query", valid.S{Trim: true, Min: 1, Max: 200})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now()
	keyword := lib.ParseSearchQuery(query)
	state := h.quota.CurrentWindow(auth.CookieValue(c.Request, lib.QuotaCookie), now)
	result := keyword
	calledLLM := false
	if keyword.Confidence < confidenceFloor && h.router.Configured() && lib.Remaining(state) > 0 && h.serverBudget(c) {
		// An upstream call was made, not necessarily a useful one: the provider
		// is billed either way, so an unusable answer still costs quota.
		calledLLM = true
		if via := lib.ParseWithLLM(c, h.router, query); via != nil {
			// Keyword hits are literal matches on known place names, so they win
			// on any key the model also filled in — except the raw-sentence `q`
			// placeholder, which would override the model's answer.
			signals := append(ordered.Map{}, keyword.Filters...)
			if keyword.RawTextOnly {
				signals = signals.Delete("q")
			}
			merged := append(ordered.Map{}, via...)
			for _, p := range signals {
				merged = merged.Set(p.Key, p.Value)
			}
			result = lib.ParsedSearch{Confidence: 0.9, Filters: merged, Source: "llm"}
		}
	}
	next := state
	if calledLLM {
		next.Used++
	}
	auth.SetCookie(c.Writer.Header(), lib.QuotaCookie, h.quota.Encode(next), lib.MaxAge(next, now), "/", "", h.secure, now)
	httpx.OK(c, parsed{result.Filters, quotaOut{lib.QuotaLimit, lib.Remaining(next), httpx.ISO(time.UnixMilli(next.WindowEndsAt))}, result.Source}, "Search parsed")
}
