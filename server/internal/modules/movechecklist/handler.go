package movechecklist

import (
	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Handler mounts the move-checklist routes under /hostel-admin.
type Handler struct {
	*Service
	Guards *authz.Guards
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	a := v1.Group("/hostel-admin")
	a.GET("/move-events", hostelrooms.Cap(h.Guards, "registerResidents"), httpx.ETag(), h.events)
}

func (h *Handler) events(c *gin.Context) {
	events, err := h.Events(c, authz.From(c), valid.Query(c)["hostelId"])
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, struct {
		Events []Event `json:"events"`
	}{events}, "Move events loaded")
}
