package platformconfig

import (
	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

type Handler struct{ svc *Service }

func NewHandler(svc *Service) *Handler { return &Handler{svc} }

func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.GET("/public/site-config", h.siteConfig)
}

func (h *Handler) siteConfig(c *gin.Context) {
	config, err := h.svc.Public(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.PublicCache(c)
	httpx.OK(c, ordered.Map{{Key: "config", Value: config}}, "Site configuration loaded")
}
