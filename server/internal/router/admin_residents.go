package router

import (
	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/modules/inquiries"
	"github.com/softmato/hostelpalika/server/internal/modules/movechecklist"
)

// mountAdminResidents is the residents slice of /hostel-admin (Phase 6): rooms,
// room types, residents, resident lookup and scan, move events, inquiries, bookings.
func mountAdminResidents(v1 *gin.RouterGroup, s *shared) {
	capacity := &hostelrooms.Capacity{DB: s.D.DB, RT: s.RT, Bump: s.Cache}
	rooms := &hostelrooms.Service{DB: s.D.DB, Cap: capacity, Notify: s.Notify}
	(&hostelrooms.Handler{Rooms: rooms, Guards: s.Guards}).Register(v1)
	(&inquiries.Handler{DB: s.D.DB, Guards: s.Guards, Cache: s.Cache, Audit: s.Audit}).Register(v1)
	(&movechecklist.Handler{Service: &movechecklist.Service{DB: s.D.DB}, Guards: s.Guards}).Register(v1)
}
