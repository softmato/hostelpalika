package hostelrooms

import (
	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Handler mounts /hostel-admin/rooms, /room-types and the staff's room move.
type Handler struct {
	Rooms  *Service
	Guards *authz.Guards
}

// Cap is a route guard for one warden capability (an admin holds them all).
func Cap(g *authz.Guards, name string) gin.HandlerFunc {
	return authz.Use(func(c *gin.Context) (*authz.Principal, error) {
		return g.RequireHostelCapability(c, authz.Capability(name))
	})
}

// Register mounts the routes under /api/v1.
func (h *Handler) Register(v1 *gin.RouterGroup) {
	staff, admin := authz.Use(h.Guards.RequireHostelStaff), authz.Use(h.Guards.RequireHostelAdmin)
	a := v1.Group("/hostel-admin")
	a.GET("/rooms", staff, httpx.ETag(), h.layout)
	a.POST("/rooms", Cap(h.Guards, "manageRooms"), h.add)
	a.PUT("/rooms/order", admin, h.order)
	a.PUT("/rooms/tracking", admin, h.tracking)
	a.GET("/rooms/requests", staff, httpx.ETag(), h.requests)
	a.POST("/rooms/requests/:requestId", Cap(h.Guards, "registerResidents"), h.answer)
	a.PATCH("/rooms/:roomId", Cap(h.Guards, "manageRooms"), h.update)
	a.DELETE("/rooms/:roomId", Cap(h.Guards, "manageRooms"), h.remove)
	a.GET("/room-types", Cap(h.Guards, "registerResidents"), httpx.ETag(), h.roomTypes)
	a.PUT("/residents/:id/room", Cap(h.Guards, "registerResidents"), h.moveResident)
}

// UserID is the caller's id as an ObjectId, for createdBy/updatedBy.
func UserID(p *authz.Principal) bson.ObjectID {
	id, _ := bson.ObjectIDFromHex(p.UserID)
	return id
}

// HostelOf resolves the hostel a request acts on, answering the refusal itself.
func HostelOf(c *gin.Context, requested string) (bson.ObjectID, bool) {
	id, err := ResolveHostel(authz.From(c), requested)
	if err != nil {
		httpx.Fail(c, err)
		return id, false
	}
	return id, true
}

func (h *Handler) send(c *gin.Context, l *Layout, err error, msg string, status int) {
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, status, l, msg)
}

func (h *Handler) layout(c *gin.Context) {
	hostel, ok := HostelOf(c, valid.Query(c)["hostelId"])
	if !ok {
		return
	}
	l, err := h.Rooms.Layout(c, hostel)
	h.send(c, l, err, "Rooms", 200)
}

func intOf(f *valid.Form, key string, min, max float64, opt bool) (int, bool) {
	n, ok := f.Num(key, valid.N{Opt: opt, Int: true, Coerce: true, Min: valid.P(min), Max: valid.P(max)})
	return int(n), ok
}

func (h *Handler) add(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	var in AddIn
	in.Beds, _ = intOf(f, "beds", 1, 40, false)
	in.Floor, _ = intOf(f, "floor", -5, 200, false)
	hid := OptionalID(f, "hostelId", "Invalid id.")
	if arr, ok := f.Array("numbers", false, false); ok {
		for i, v := range arr {
			path := "numbers." + numStr(int64(i))
			s, isStr := v.(string)
			if !isStr {
				f.Is.Add(path, valid.Type("string", valid.Received(v, false)))
				continue
			}
			s = valid.Trim(s)
			if n := valid.JSLen(s); n < 1 {
				f.Is.Add(path, valid.TooSmall("string", 1, true))
			} else if n > 20 {
				f.Is.Add(path, valid.TooBig("string", 20, true))
			}
			in.Numbers = append(in.Numbers, s)
		}
		f.Size("numbers", len(arr), 1, 100, "", false)
	}
	in.RoomType, _ = f.Str("roomType", valid.S{Trim: true, Min: 1, Max: 80})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, ok := HostelOf(c, hid)
	if !ok {
		return
	}
	l, err := h.Rooms.Add(c, hostel, in, UserID(authz.From(c)))
	h.send(c, l, err, "Rooms added", 201)
}

func (h *Handler) update(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	var in UpdateIn
	if n, ok := intOf(f, "beds", 1, 40, true); ok {
		in.Beds = &n
	}
	if n, ok := intOf(f, "floor", -5, 200, true); ok {
		in.Floor = &n
	}
	hid := OptionalID(f, "hostelId", "Invalid id.")
	if s, ok := f.Str("number", valid.S{Opt: true, Trim: true, Min: 1, Max: 20}); ok {
		in.Number = &s
	}
	if s, ok := f.Str("roomType", valid.S{Opt: true, Trim: true, Min: 1, Max: 80}); ok {
		in.RoomType = &s
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, ok := HostelOf(c, hid)
	if !ok {
		return
	}
	room, err := httpx.OID(c.Param("roomId"), "id")
	if err != nil {
		httpx.Fail(c, roomErr("Room was not found.", "ROOM_NOT_FOUND", 404))
		return
	}
	l, err := h.Rooms.Update(c, hostel, room, in, UserID(authz.From(c)))
	h.send(c, l, err, "Room saved", 200)
}

func (h *Handler) remove(c *gin.Context) {
	hostel, ok := HostelOf(c, valid.Query(c)["hostelId"])
	if !ok {
		return
	}
	room, err := httpx.OID(c.Param("roomId"), "id")
	if err != nil {
		httpx.Fail(c, roomErr("Room was not found.", "ROOM_NOT_FOUND", 404))
		return
	}
	l, err := h.Rooms.Delete(c, hostel, room, UserID(authz.From(c)))
	h.send(c, l, err, "Room removed", 200)
}

func (h *Handler) order(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	floor, _ := intOf(f, "floor", -5, 200, false)
	hid := OptionalID(f, "hostelId", "Invalid id.")
	var ids []bson.ObjectID
	if arr, ok := f.Array("ids", false, false); ok {
		for i, v := range arr {
			if s, ok := valid.ObjectID(v, "ids."+numStr(int64(i)), "Invalid id.", &f.Is, false); ok {
				id, _ := bson.ObjectIDFromHex(s)
				ids = append(ids, id)
			}
		}
		f.Size("ids", len(arr), 1, 300, "", false)
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, ok := HostelOf(c, hid)
	if !ok {
		return
	}
	l, err := h.Rooms.Order(c, hostel, floor, ids)
	h.send(c, l, err, "Saved", 200)
}

func (h *Handler) tracking(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	enabled, _ := f.Bool("enabled", false, nil)
	hid := OptionalID(f, "hostelId", "Invalid id.")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, ok := HostelOf(c, hid)
	if !ok {
		return
	}
	l, err := h.Rooms.SetTracking(c, hostel, enabled, UserID(authz.From(c)))
	h.send(c, l, err, "Saved", 200)
}

type requestsOut struct {
	Requests []Request `json:"requests"`
}

func (h *Handler) requests(c *gin.Context) {
	hostel, ok := HostelOf(c, valid.Query(c)["hostelId"])
	if !ok {
		return
	}
	rows, err := h.Rooms.Requests(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, requestsOut{rows}, "Room requests")
}

func (h *Handler) answer(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	action, _ := f.Enum("action", false, nil, "approve", "decline")
	hid := OptionalID(f, "hostelId", "Invalid id.")
	reason, _ := f.Str("reason", valid.S{Opt: true, Trim: true, Max: 200})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, ok := HostelOf(c, hid)
	if !ok {
		return
	}
	req, err := httpx.OID(c.Param("requestId"), "id")
	if err != nil {
		httpx.Fail(c, roomErr("That request was already answered.", "REQUEST_CLOSED", 409))
		return
	}
	rows, err := h.Rooms.Answer(c, hostel, req, action == "approve", reason, UserID(authz.From(c)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, requestsOut{rows}, "Answered")
}

func (h *Handler) roomTypes(c *gin.Context) {
	var is valid.Issues
	hid := QueryHostelID(valid.Query(c), &is)
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, ok := HostelOf(c, hid)
	if !ok {
		return
	}
	types, err := h.Rooms.Cap.ListAvailable(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, struct {
		RoomTypes []Available `json:"roomTypes"`
	}{types}, "Room types loaded")
}

func (h *Handler) moveResident(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	hid, _ := f.Str("hostelId", valid.S{Opt: true})
	roomID, _ := f.Str("roomId", valid.S{Re: idRe, ReMsg: "Pick a room.", ReSrc: "/^[a-f\\d]{24}$/i"})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, ok := HostelOf(c, hid)
	if !ok {
		return
	}
	rid, err := httpx.OID(c.Param("id"), "id")
	if err != nil {
		httpx.Fail(c, roomErr("Resident was not found.", "RESIDENT_NOT_FOUND", 404))
		return
	}
	room, _ := bson.ObjectIDFromHex(roomID)
	r, err := h.Rooms.Move(c, hostel, rid, room, UserID(authz.From(c)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, struct {
		Room *Room `json:"room"`
	}{r}, "Room set")
}
