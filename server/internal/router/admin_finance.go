package router

import (
	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/modules/financeadmin"
	"github.com/softmato/hostelpalika/server/internal/modules/ledger"
)

// mountAdminFinance is /hostel-admin/finance, the money side of the hostel admin.
func mountAdminFinance(v1 *gin.RouterGroup, s *shared) {
	engine := &ledger.Engine{DB: s.D.DB, Audit: s.Audit, Notify: s.Notify, Mail: s.Mail, Config: s.Config, Bump: s.Cache, AppURL: s.AppURL}
	(&financeadmin.Handler{DB: s.D.DB, Guards: s.Guards, Ledger: engine, Audit: s.Audit, Cache: s.Cache, RT: s.RT,
		FinanceKey: s.Cfg.Crypto.FinanceMasterKey, FinancePrev: s.Cfg.Crypto.FinanceMasterKeyPrev, Production: s.Cfg.IsProduction(), R2: s.R2, Reader: s.Evidence}).Register(v1)
}
