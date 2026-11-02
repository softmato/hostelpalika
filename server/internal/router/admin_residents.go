package router

import (
	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/modules/bookings"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelresidents"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/modules/inquiries"
	"github.com/softmato/hostelpalika/server/internal/modules/ledger"
	"github.com/softmato/hostelpalika/server/internal/modules/movechecklist"
)

// mountAdminResidents is the residents slice of /hostel-admin (Phase 6): rooms,
// room types, residents, resident lookup and scan, move events, inquiries, bookings.
func mountAdminResidents(v1 *gin.RouterGroup, s *shared) {
	capacity := &hostelrooms.Capacity{DB: s.D.DB, RT: s.RT, Bump: s.Cache}
	rooms := &hostelrooms.Service{DB: s.D.DB, Cap: capacity, Notify: s.Notify}
	(&hostelrooms.Handler{Rooms: rooms, Guards: s.Guards}).Register(v1)
	engine := &ledger.Engine{DB: s.D.DB, Audit: s.Audit, Notify: s.Notify, Mail: s.Mail, Config: s.Config, Bump: s.Cache, AppURL: s.AppURL}
	(&hostelresidents.Handler{Service: &hostelresidents.Service{DB: s.D.DB, Cap: capacity, Notify: s.Notify, Audit: s.Audit, Mail: s.Mail, Ledger: engine,
		Personal: s.Personal, R2: s.R2, Claims: s.Claims, AppURL: s.AppURL, Outbound: s.Outbound, Config: s.Config, ActivationSecret: s.Cfg.Auth.ActivationCodeSecret}, Guards: s.Guards, Cache: s.Cache}).Register(v1)
	(&inquiries.Handler{DB: s.D.DB, Guards: s.Guards, Cache: s.Cache, Audit: s.Audit}).Register(v1)
	(&movechecklist.Handler{Service: &movechecklist.Service{DB: s.D.DB}, Guards: s.Guards}).Register(v1)
	signed := &bookings.Signed{Service: s.Bookings, Guards: s.Guards, Limiter: s.Limiter, Notify: s.Notify, Mail: s.Mail, Audit: s.Audit, RT: s.RT, Bump: s.Cache, Outbound: s.Outbound,
		SoftmatoOn: s.Cfg.Softmato.BaseURL != "" && s.Cfg.Softmato.Secret != "" && s.Cfg.Softmato.WebhookSecret != ""}
	(&bookings.Hostel{Signed: signed, Claim: capacity.Claim}).Register(v1)
}
