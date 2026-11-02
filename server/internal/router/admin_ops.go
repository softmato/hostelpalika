package router

import (
	"github.com/gin-gonic/gin"

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
}
