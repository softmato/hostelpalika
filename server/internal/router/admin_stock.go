package router

import (
	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/modules/expenses"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelreferrals"
	"github.com/softmato/hostelpalika/server/internal/modules/referrals"
	"github.com/softmato/hostelpalika/server/internal/modules/reports"
	"github.com/softmato/hostelpalika/server/internal/modules/serviceproviders"
	"github.com/softmato/hostelpalika/server/internal/modules/stock"
	"github.com/softmato/hostelpalika/server/internal/modules/wardens"
)

// mountAdminStock is stock, reports, expenses and the smaller staff boards.
func mountAdminStock(v1 *gin.RouterGroup, s *shared) {
	limits := &billing.Limits{DB: s.D.DB, Config: s.Config, Notify: s.Notify}
	(&wardens.Service{DB: s.D.DB, Guards: s.Guards, Audit: s.Audit, Issuer: s.Issuer, Limits: limits, Notify: s.Notify}).Register(v1)
	(&referrals.Admin{DB: s.D.DB, Guards: s.Guards, Audit: s.Audit, Notify: s.Notify}).Register(v1)
	(&hostelreferrals.Admin{Service: hostelreferrals.NewService(s.D.DB), Guards: s.Guards, Audit: s.Audit, Mail: s.Mail, AppURL: s.AppURL}).Register(v1)
	(&serviceproviders.Handler{DB: s.D.DB}).RegisterAdmin(v1, s.Guards)
	spend := &expenses.Handler{DB: s.D.DB, Guards: s.Guards, Notify: s.Notify, Audit: s.Audit, RT: s.RT, Bump: s.Cache}
	(&expenses.Admin{Handler: spend, Cache: s.Cache, R2: s.R2, Evidence: s.Evidence, Limiter: s.Limiter}).Register(v1)
	(&reports.Admin{DB: s.D.DB, Guards: s.Guards, Cache: s.Cache, Spend: spend}).Register(v1)
	(&stock.Admin{Handler: &stock.Handler{DB: s.D.DB, Guards: s.Guards, Notify: s.Notify, RT: s.RT, Bump: s.Cache}, Expenses: spend, Cache: s.Cache}).Register(v1)
}
