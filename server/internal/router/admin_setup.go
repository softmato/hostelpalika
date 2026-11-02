package router

import (
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/modules/hostels"
)

// mountAdminSetup is the hostel owner's setup slice: KYC, leave, backup, settings,
// profile, branches, billing, subscription and the payout account.
func mountAdminSetup(v1 *gin.RouterGroup, s *shared) {
	plan := &billing.Service{DB: s.D.DB, SiteURL: strings.TrimRight(s.Cfg.AppURL, "/"), SoftmatoBase: s.Cfg.Softmato.BaseURL}
	(&billing.Admin{Service: plan, Guards: s.Guards, Cache: s.Cache}).Register(v1)
	(&hostels.Admin{DB: s.D.DB, Guards: s.Guards, Audit: s.Audit, Mail: s.Mail, Notify: s.Notify, Cache: s.Cache, Billing: plan, Outbound: s.Outbound,
		FinanceKey: s.Cfg.Crypto.FinanceMasterKey, FinancePrev: s.Cfg.Crypto.FinanceMasterKeyPrev, PersonalKey: s.Cfg.Crypto.PersonalDataKey}).Register(v1)
}
