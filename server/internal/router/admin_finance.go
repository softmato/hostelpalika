package router

import (
	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/modules/expenses"
	"github.com/softmato/hostelpalika/server/internal/modules/financeadmin"
	"github.com/softmato/hostelpalika/server/internal/modules/hostels"
	"github.com/softmato/hostelpalika/server/internal/modules/ledger"
	"github.com/softmato/hostelpalika/server/internal/modules/reports"
)

// mountAdminFinance is /hostel-admin/finance, the money side of the hostel admin.
func mountAdminFinance(v1 *gin.RouterGroup, s *shared) {
	engine := &ledger.Engine{DB: s.D.DB, Audit: s.Audit, Notify: s.Notify, Mail: s.Mail, Config: s.Config, Bump: s.Cache, AppURL: s.AppURL}
	(&financeadmin.Handler{DB: s.D.DB, Guards: s.Guards, Ledger: engine, Audit: s.Audit, Cache: s.Cache, RT: s.RT,
		FinanceKey: s.Cfg.Crypto.FinanceMasterKey, FinancePrev: s.Cfg.Crypto.FinanceMasterKeyPrev, Production: s.Cfg.IsProduction(), R2: s.R2, Reader: s.Evidence,
		Branches: &hostels.Admin{DB: s.D.DB},
		Reports:  &reports.Admin{DB: s.D.DB, Guards: s.Guards, Cache: s.Cache, Spend: &expenses.Handler{DB: s.D.DB, Guards: s.Guards, Notify: s.Notify, Audit: s.Audit, RT: s.RT, Bump: s.Cache}}}).Register(v1)
}
