package router

import (
	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/modules/attendance"
	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/modules/campaigns"
	"github.com/softmato/hostelpalika/server/internal/modules/community"
	"github.com/softmato/hostelpalika/server/internal/modules/complaints"
	"github.com/softmato/hostelpalika/server/internal/modules/kitchen"
	"github.com/softmato/hostelpalika/server/internal/modules/maintenance"
	"github.com/softmato/hostelpalika/server/internal/modules/noticepushes"
	"github.com/softmato/hostelpalika/server/internal/modules/notices"
)

// mountAdminOps is the ops slice of /hostel-admin: notices, push notices,
// complaints, maintenance, attendance, safety, food, community, cooks and the
// staff inbox.
func mountAdminOps(v1 *gin.RouterGroup, s *shared) {
	board := &notices.Admin{DB: s.D.DB, Guards: s.Guards, Cache: s.Cache, Notify: s.Notify, Mail: s.Mail, Audit: s.Audit, Config: s.Config, RT: s.RT, AppURL: s.AppURL}
	board.Register(v1)
	(&noticepushes.Service{DB: s.D.DB, Guards: s.Guards, Notices: board, Audit: s.Audit, RT: s.RT, Cache: s.Cache}).Register(v1)
	s.Safety.RegisterAdmin(v1, s.Cache)
	(&community.Handler{DB: s.D.DB, Guards: s.Guards, Notify: s.Notify, RT: s.RT, Bump: s.Cache, BG: s.BG, LLM: s.LLM}).RegisterAdmin(v1, s.Audit)
	(&campaigns.Service{DB: s.D.DB, Guards: s.Guards, Audit: s.Audit, Push: s.Push, RT: s.RT, Bump: s.Cache}).Register(v1)
	(&complaints.Service{DB: s.D.DB, Guards: s.Guards, Notify: s.Notify, Mail: s.Mail, Audit: s.Audit, Config: s.Config, RT: s.RT, Cache: s.Cache, AppURL: s.AppURL}).RegisterAdmin(v1)
	(&maintenance.Service{DB: s.D.DB, Guards: s.Guards, Audit: s.Audit, Cache: s.Cache, Config: s.Config, Notify: s.Notify, RT: s.RT}).Register(v1)
	(&attendance.Admin{Handler: &attendance.Handler{DB: s.D.DB, Guards: s.Guards, Audit: s.Audit}, Config: s.Config, RT: s.RT, Bump: s.Cache}).Register(v1)
	limits := &billing.Limits{DB: s.D.DB, Config: s.Config, Notify: s.Notify}
	(&kitchen.Admin{Handler: &kitchen.Handler{DB: s.D.DB, Guards: s.Guards, Cache: s.Cache, Notify: s.Notify, Push: s.Push, Audit: s.Audit, Config: s.Config, RT: s.RT, Issuer: s.Issuer}, Mail: s.Mail, Limits: limits, AppURL: s.AppURL}).Register(v1)
}
