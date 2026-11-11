package residentportal

import (
	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/ledger"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// creditScore is GET /resident/credit-score (getMyCreditScore).
func (h *Handler) creditScore(c *gin.Context) {
	p, err := h.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, h.DB, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var code *string
	if s, err := (&ledger.Engine{DB: h.DB}).EnsureResidentPaymentCode(c, r.HostelID, r.ID, ""); err == nil {
		code = &s
	}
	out, err := finance.CreditScoreOf(c, h.DB, r.ID, code)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Credit score")
}
