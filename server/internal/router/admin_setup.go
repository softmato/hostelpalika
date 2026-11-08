package router

import (
	"context"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/modules/backup"
	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelleave"
	"github.com/softmato/hostelpalika/server/internal/modules/hostels"
	"github.com/softmato/hostelpalika/server/internal/platform/maps"
	"github.com/softmato/hostelpalika/server/internal/platform/softmato"
)

// mountAdminSetup is the hostel owner's setup slice: KYC, leave, backup, settings,
// profile, branches, billing, subscription and the payout account.
func mountAdminSetup(v1 *gin.RouterGroup, s *shared) {
	plan := &billing.Service{DB: s.D.DB, Cache: s.Cache, SiteURL: strings.TrimRight(s.Cfg.AppURL, "/"), SoftmatoBase: s.Cfg.Softmato.BaseURL,
		Softmato: softmato.New(s.Cfg.Softmato.BaseURL, s.Cfg.Softmato.Secret, s.Cfg.Softmato.WebhookSecret), Config: s.Config, Audit: s.Audit, Mail: s.Mail, Outbound: s.Outbound, PayLinkSecret: s.Cfg.Auth.AccessSecret}
	(&billing.Admin{Service: plan, Guards: s.Guards, Cache: s.Cache, Audit: s.Audit, Mail: s.Mail}).Register(v1)
	(&hostels.Admin{DB: s.D.DB, Guards: s.Guards, Audit: s.Audit, Mail: s.Mail, Notify: s.Notify, Cache: s.Cache, Billing: plan, Outbound: s.Outbound,
		FinanceKey: s.Cfg.Crypto.FinanceMasterKey, FinancePrev: s.Cfg.Crypto.FinanceMasterKeyPrev, PersonalKey: s.Cfg.Crypto.PersonalDataKey, RT: s.RT, Claims: s.Claims, Config: s.Config, R2: s.R2, BG: s.BG, Maps: maps.NewClient(s.Cfg.Google.MapsAPIKey, s.Cfg.AppURL)}).Register(v1)
	(&hostelleave.Owner{Handler: &hostelleave.Handler{DB: s.D.DB, Guards: s.Guards, R2: s.R2, BG: s.BG, Mail: s.Mail, Audit: s.Audit, AppURL: s.AppURL, Public: s.Cache}, Notify: s.Notify, RT: s.RT, Cache: s.Cache,
		HoldBounds: func(ctx context.Context) (int, int) {
			ops := s.Config.OperationsTyped(ctx)
			return ops.LeaveHoldMinDays, ops.LeaveHoldMaxDays
		}}).Register(v1)
	s.J.Backup = &backup.Handler{DB: s.D.DB, Guards: s.Guards, Audit: s.Audit, Config: s.Config, Drive: backup.NewDrive(s.Cfg.Google.DriveClientID, s.Cfg.Google.DriveClientSecret),
		AppURL: strings.TrimRight(s.Cfg.AppURL, "/"), JWTSecret: s.Cfg.Auth.AccessSecret, FinanceKey: s.Cfg.Crypto.FinanceMasterKey, FinancePrev: s.Cfg.Crypto.FinanceMasterKeyPrev}
	s.J.Backup.Register(v1)
}
