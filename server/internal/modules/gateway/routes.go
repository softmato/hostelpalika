package gateway

import (
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/ratelimit"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

type Handler struct {
	Service *Service
	Guards  *authz.Guards
	Limiter *ratelimit.Limiter
}

// A provider callback is a few hundred bytes; anything near this is not one.
const maxCallbackBytes = 64 << 10

// callbacksPerMinute bounds what an unauthenticated caller can make us ask a
// provider: each recognised reference costs one verification call.
const callbacksPerMinute = 60

var providers = map[string]bool{"esewa": true, "fonepay": true, "khalti": true}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	resident := authz.Use(h.Guards.RequireResident)
	v1.POST("/resident/finance/invoices/:id/checkout", resident, h.checkout)
	v1.GET("/resident/finance/checkout/:reference", resident, httpx.ETag(), h.status)
	v1.POST("/webhooks/:provider", h.callback)
	v1.GET("/public/payments/:reference/handoff", h.handoff)
}

func (h *Handler) checkout(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	provider, _ := f.Enum("provider", false, nil, "ESEWA", "FONEPAY", "KHALTI")
	if err := f.Is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.Service.CreateIntent(c, authz.From(c), c.Param("id"), provider)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Checkout ready")
}

func (h *Handler) status(c *gin.Context) {
	out, err := h.Service.CheckoutStatus(c, authz.From(c), c.Param("reference"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Checkout status")
}

// callback is POST /webhooks/:provider. Unauthenticated by necessity and trusted
// for nothing: a reference we never issued answers 200 (a provider retries a
// non-2xx for ever, and it is what a probe looks like); a signature that does
// not verify answers 4xx. The answer never says what happened.
func (h *Handler) callback(c *gin.Context) {
	slug := strings.ToLower(c.Param("provider"))
	if !providers[slug] {
		httpx.Fail(c, httpx.NewError(http.StatusNotFound, "NOT_FOUND", "Unknown payment provider.", nil))
		return
	}
	if err := h.Limiter.Check(c, "gateway-callback", callbacksPerMinute, time.Minute); err != nil {
		httpx.Fail(c, err)
		return
	}
	raw, err := io.ReadAll(io.LimitReader(c.Request.Body, maxCallbackBytes+1))
	if err != nil || len(raw) > maxCallbackBytes {
		httpx.Fail(c, httpx.NewError(http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "The request is too large.", nil))
		return
	}
	body := string(raw)
	if q := c.Request.URL.RawQuery; strings.TrimSpace(body) == "" && q != "" {
		body = q // a provider that returns by GET-style query on a POST
	}
	headers := map[string]string{}
	for k := range c.Request.Header {
		headers[strings.ToLower(k)] = c.Request.Header.Get(k)
	}
	out, err := h.Service.Callback(c, strings.ToUpper(slug), body, headers)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	msg := "Received"
	if out.Settled {
		msg = "Settled"
	}
	httpx.OK(c, ordered.Map{{Key: "received", Value: true}}, msg)
}
