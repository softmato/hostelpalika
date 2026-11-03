package router

import (
	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/modules/bookings"
	"github.com/softmato/hostelpalika/server/internal/modules/financeadmin"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelresidents"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/modules/inquiries"
	"github.com/softmato/hostelpalika/server/internal/modules/ledger"
	"github.com/softmato/hostelpalika/server/internal/modules/movechecklist"
	"github.com/softmato/hostelpalika/server/internal/modules/residentfinance"
)

// mountAdminResidents is the residents slice of /hostel-admin (Phase 6): rooms,
// room types, residents, resident lookup and scan, move events, inquiries, bookings.
func mountAdminResidents(v1 *gin.RouterGroup, s *shared) {
	capacity := &hostelrooms.Capacity{DB: s.D.DB, RT: s.RT, Bump: s.Cache}
	rooms := &hostelrooms.Service{DB: s.D.DB, Cap: capacity, Notify: s.Notify}
	(&hostelrooms.Handler{Rooms: rooms, Guards: s.Guards}).Register(v1)
	engine := &ledger.Engine{DB: s.D.DB, Audit: s.Audit, Notify: s.Notify, Mail: s.Mail, Config: s.Config, Bump: s.Cache, AppURL: s.AppURL}
	(&inquiries.Handler{DB: s.D.DB, Guards: s.Guards, Cache: s.Cache, Audit: s.Audit}).Register(v1)
	(&movechecklist.Handler{Service: &movechecklist.Service{DB: s.D.DB}, Guards: s.Guards}).Register(v1)
	signed := &bookings.Signed{Service: s.Bookings, Guards: s.Guards, Limiter: s.Limiter, Notify: s.Notify, Mail: s.Mail, Audit: s.Audit, RT: s.RT, Bump: s.Cache, Outbound: s.Outbound,
		SoftmatoOn: s.Cfg.Softmato.BaseURL != "" && s.Cfg.Softmato.Secret != "" && s.Cfg.Softmato.WebhookSecret != ""}
	(&bookings.Hostel{Signed: signed, Claim: capacity.Claim}).Register(v1)
	pay := &residentfinance.Handler{DB: s.D.DB, Production: s.Cfg.IsProduction()}
	(&hostelresidents.Handler{Service: &hostelresidents.Service{DB: s.D.DB, Cap: capacity, Notify: s.Notify, Audit: s.Audit, Mail: s.Mail, Ledger: engine,
		Personal: s.Personal, R2: s.R2, Claims: s.Claims, AppURL: s.AppURL, Outbound: s.Outbound, Config: s.Config, ActivationSecret: s.Cfg.Auth.ActivationCodeSecret,
		Rooms: rooms, Limits: &billing.Limits{DB: s.D.DB, Config: s.Config, Notify: s.Notify}, Bookings: signed, PayMethods: pay.HostelPayMethods, Ledger2: (&financeadmin.Handler{DB: s.D.DB}).ResidentLedger, After: s.BG.After}, Guards: s.Guards, Cache: s.Cache, Limiter: s.Limiter}).Register(v1)
}
