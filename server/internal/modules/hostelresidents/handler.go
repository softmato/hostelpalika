package hostelresidents

import (
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Handler mounts /hostel-admin/residents.
type Handler struct {
	*Service
	Guards *authz.Guards
	Cache  *cache.Cache
}

var statuses = []string{"PENDING", "ACTIVE", "SUSPENDED", "MOVED_OUT"}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	staff := authz.Use(h.Guards.RequireHostelStaff)
	reg := hostelrooms.Cap(h.Guards, "registerResidents")
	a := v1.Group("/hostel-admin/residents")
	a.GET("", staff, h.list)
	a.GET("/:id", staff, httpx.ETag(), h.get)
	a.PATCH("/:id", reg, h.update)
	a.DELETE("/:id", reg, h.remove)
	a.GET("/:id/contacts", reg, httpx.ETag(), h.contactsOf)
	a.GET("/:id/photo", staff, h.photo)
	a.POST("/:id/guardians", reg, h.guardian)
	a.POST("/:id/emergency-contacts", reg, h.emergency)
}

func fail(c *gin.Context, err error) bool {
	if err != nil {
		httpx.Fail(c, err)
		return true
	}
	return false
}

// hostelQuery is residentListQuerySchema.pick({ hostelId }).
func hostelQuery(c *gin.Context) (string, bool) {
	var is valid.Issues
	id := queryHostel(valid.Query(c), &is)
	if fail(c, is.Err()) {
		return "", false
	}
	return id, true
}

// queryHostel reads `hostelId: objectIdSchema.optional()` ("" when absent).
func queryHostel(q map[string]string, is *valid.Issues) string {
	v, ok := q["hostelId"]
	if !ok {
		return ""
	}
	id, _ := valid.ObjectID(v, "hostelId", "Invalid object id.", is, false)
	return id
}

func (h *Handler) list(c *gin.Context) {
	p := authz.From(c)
	q := valid.Query(c)
	var is valid.Issues
	in := ListQuery{HostelID: queryHostel(q, &is), Page: hostelrooms.ReadPage(q, &is)}
	if s := valid.QueryString(q, "q", 1, 120, &is); s != nil {
		in.Q = *s
	}
	if s := valid.QueryEnum(q, "residentType", &is, "STUDENT", "WORKING_PROFESSIONAL", "OTHER"); s != nil {
		in.ResidentType = *s
	}
	if s := valid.QueryEnum(q, "status", &is, statuses...); s != nil {
		in.Status = *s
	}
	if fail(c, is.Err()) {
		return
	}
	key := "residents"
	if raw := c.Request.URL.RawQuery; raw != "" {
		key += "?" + raw
	}
	cache.Respond(c, h.Cache, p.HostelIDs, p.UserID, key, "Residents loaded", func() (*ListOut, error) { return h.List(c, in, p) })
}

func (h *Handler) get(c *gin.Context) {
	hid, ok := hostelQuery(c)
	if !ok {
		return
	}
	out, err := h.Get(c, c.Param("id"), hid, authz.From(c))
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Resident loaded")
}

func (h *Handler) remove(c *gin.Context) {
	hid, ok := hostelQuery(c)
	if !ok {
		return
	}
	out, err := h.Delete(c, c.Param("id"), hid, authz.From(c))
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Resident removed")
}

func (h *Handler) contactsOf(c *gin.Context) {
	hid, ok := hostelQuery(c)
	if !ok {
		return
	}
	out, err := h.Contacts(c, c.Param("id"), hid, authz.From(c))
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Resident contacts loaded")
}

func (h *Handler) photo(c *gin.Context) {
	rd, mime, err := h.Photo(c, c.Param("id"), authz.From(c))
	if fail(c, err) {
		return
	}
	defer rd.Close()
	c.Header("Cache-Control", "private, max-age=3600")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Content-Type", mime)
	c.Status(http.StatusOK)
	_, _ = io.Copy(c.Writer, rd)
}

// calendarDate is `z.coerce.date().transform(hostelCalendarDay)`.
func calendarDate(f *valid.Form, key string, opt bool) (time.Time, bool) {
	v, present := f.M[key]
	if !present && opt {
		return time.Time{}, false
	}
	t, ok := valid.CoerceDate(v)
	if !ok {
		f.Is.Add(key, "Invalid input: expected date, received Date")
		return time.Time{}, false
	}
	return bs.CalendarDay(t), true
}

func (h *Handler) update(c *gin.Context) {
	body, err := valid.Body(c)
	if fail(c, err) {
		return
	}
	f := valid.NewForm(body)
	var in UpdateIn
	nn := valid.N{Opt: true, Coerce: true, Min: valid.P(0)}
	if n, ok := f.Num("depositAmount", nn); ok {
		in.DepositAmount = &n
	}
	if n, ok := f.Num("monthlyFee", nn); ok {
		in.MonthlyFee = &n
	}
	hid := hostelrooms.OptionalID(f, "hostelId", "Invalid object id.")
	str := func(key string, o valid.S) *string {
		o.Opt, o.Trim = true, true
		if s, ok := f.Str(key, o); ok {
			return &s
		}
		return nil
	}
	in.Email = str("email", valid.S{Email: true})
	in.First = str("firstName", valid.S{Min: 1, Max: 80})
	in.Last = str("lastName", valid.S{Min: 1, Max: 80})
	if t, ok := calendarDate(f, "moveInDate", true); ok {
		in.MoveInDate = &t
	}
	in.Phone = str("phone", valid.S{Min: 7, Max: 24})
	if s, ok := f.Enum("residentType", true, nil, "STUDENT", "WORKING_PROFESSIONAL", "OTHER"); ok {
		in.ResidentType = &s
	}
	in.RoomType = str("roomType", valid.S{Min: 1, Max: 80})
	if fail(c, f.Err()) {
		return
	}
	out, err := h.Update(c, c.Param("id"), hid, in, authz.From(c))
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Resident updated")
}

func (h *Handler) guardian(c *gin.Context) {
	body, err := valid.Body(c)
	if fail(c, err) {
		return
	}
	f := valid.NewForm(body)
	var in GuardianIn
	in.Email, _ = f.Str("email", valid.S{Opt: true, Trim: true, Email: true})
	in.First, _ = f.Str("firstName", valid.S{Trim: true, Min: 1, Max: 80})
	def := false
	in.IsPrimary, _ = f.Bool("isPrimary", true, &def)
	in.Last, _ = f.Str("lastName", valid.S{Trim: true, Min: 1, Max: 80})
	in.Phone, _ = f.Str("phone", valid.S{Trim: true, Min: 7, Max: 24})
	in.Relation, _ = f.Str("relation", valid.S{Trim: true, Min: 2, Max: 80})
	if fail(c, f.Err()) {
		return
	}
	out, err := h.AddGuardian(c, c.Param("id"), in, authz.From(c))
	if fail(c, err) {
		return
	}
	httpx.Write(c, http.StatusCreated, out, "Guardian added")
}

func (h *Handler) emergency(c *gin.Context) {
	body, err := valid.Body(c)
	if fail(c, err) {
		return
	}
	f := valid.NewForm(body)
	var in EmergencyIn
	def := false
	in.IsPrimary, _ = f.Bool("isPrimary", true, &def)
	in.Name, _ = f.Str("name", valid.S{Trim: true, Min: 2, Max: 120})
	in.Phone, _ = f.Str("phone", valid.S{Trim: true, Min: 7, Max: 24})
	in.Relation, _ = f.Str("relation", valid.S{Trim: true, Min: 2, Max: 80})
	if fail(c, f.Err()) {
		return
	}
	out, err := h.AddEmergencyContact(c, c.Param("id"), in, authz.From(c))
	if fail(c, err) {
		return
	}
	httpx.Write(c, http.StatusCreated, out, "Emergency contact added")
}
