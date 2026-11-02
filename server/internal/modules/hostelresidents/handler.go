package hostelresidents

import (
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
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
	a.GET("/admission-form-link", reg, httpx.ETag(), h.formLink)
	a.PATCH("/admission-form-link", reg, h.formSettings)
	a.GET("/admission-forms", reg, httpx.ETag(), h.forms)
	a.GET("/admission-forms/:formId", reg, httpx.ETag(), h.form)
	a.DELETE("/admission-forms/:formId", reg, h.declineForm)
	a.GET("/admission-forms/:formId/photo", reg, h.formPhoto)
	a.GET("/leaving-today", reg, h.leavingToday)
	a.PATCH("/fees", hostelrooms.Cap(h.Guards, "manageFeeSchedule"), h.fees)
	a.GET("/intake-quote", reg, httpx.ETag(), h.intakeQuote)
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
	sendPhoto(c, rd, mime)
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

func (h *Handler) leavingToday(c *gin.Context) {
	hostel, ok := hostelrooms.HostelOf(c, valid.Query(c)["hostelId"])
	if !ok {
		return
	}
	rows, err := h.LeavingToday(c, hostel)
	if fail(c, err) {
		return
	}
	httpx.OK(c, struct {
		Residents []leaver `json:"residents"`
	}{rows}, "Leaving today")
}

func (h *Handler) fees(c *gin.Context) {
	body, err := valid.Body(c)
	if fail(c, err) {
		return
	}
	f := valid.NewForm(body)
	hid, _ := f.Str("hostelId", valid.S{Opt: true})
	var fee *int64
	if v, present := f.M["monthlyFee"]; present && v == nil {
		fee = nil
	} else if n, ok := f.Num("monthlyFee", valid.N{Coerce: true, Int: true, Min: valid.P(0)}); ok {
		i := int64(n)
		fee = &i
	}
	reason, _ := f.Str("reason", valid.S{Opt: true, Trim: true, Max: 500})
	var ids []string
	if arr, ok := f.Array("residentIds", true, false); ok {
		ids = []string{}
		for i, v := range arr {
			s, isStr := v.(string)
			if !isStr {
				f.Is.Add("residentIds."+strconv.Itoa(i), valid.Type("string", valid.Received(v, false)))
				continue
			}
			ids = append(ids, s)
		}
	}
	if fail(c, f.Err()) {
		return
	}
	hostel, ok := hostelrooms.HostelOf(c, hid)
	if !ok {
		return
	}
	out, err := h.SetFee(c, hostel, fee, reason, ids, authz.From(c))
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Monthly fee updated")
}

func (h *Handler) intakeQuote(c *gin.Context) {
	q := valid.Query(c)
	var is valid.Issues
	num := func(key string) *float64 {
		v := valid.QueryNumber(q, key, false, &is)
		if v == nil {
			return nil
		}
		n := *v
		switch {
		case n != float64(int64(n)):
			is.Add(key, valid.Type("int", "number"))
			return nil
		case n < 0:
			is.Add(key, valid.TooSmall("number", 0, true))
			return nil
		case n > 10_000_000:
			is.Add(key, valid.TooBig("number", 10_000_000, true))
			return nil
		}
		return &n
	}
	var in QuoteIn
	in.AdmissionFee = num("admissionFee")
	if s := valid.QueryEnum(q, "billingCycle", &is, "CALENDAR_MONTH", "SAME_DAY"); s != nil {
		in.BillingCycle = s
	}
	in.DepositAmount, in.FormFee = num("depositAmount"), num("formFee")
	hid := q["hostelId"]
	in.MonthlyFee = num("monthlyFee")
	if raw, ok := q["moveInDate"]; ok {
		if t, ok := valid.CoerceDate(raw); ok {
			in.MoveInDate = t
		} else {
			is.Add("moveInDate", "Invalid input: expected date, received Date")
		}
	}
	if s := valid.QueryString(q, "referralCode", 0, 32, &is); s != nil {
		in.ReferralCode = *s
	}
	if raw, ok := q["roomType"]; !ok {
		is.Add("roomType", valid.Type("string", valid.Received(nil, true)))
	} else if in.RoomType = valid.Trim(raw); in.RoomType == "" {
		is.Add("roomType", "Pick a room type.")
	}
	if fail(c, is.Err()) {
		return
	}
	hostel, ok := hostelrooms.HostelOf(c, hid)
	if !ok {
		return
	}
	quote, err := h.Quote(c, hostel, in)
	if fail(c, err) {
		return
	}
	httpx.OK(c, ordered.Map{{Key: "quote", Value: quote.JSON()}}, "Intake quote")
}

// scope is hostelStaffScope: the registerResidents caller and the hostel acted on.
func scope(c *gin.Context) (bson.ObjectID, *authz.Principal, bool) {
	hostel, ok := hostelrooms.HostelOf(c, valid.Query(c)["hostelId"])
	return hostel, authz.From(c), ok
}

func (h *Handler) formLink(c *gin.Context) {
	hostel, p, ok := scope(c)
	if !ok {
		return
	}
	out, err := h.FormLink(c, hostel, p)
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Form QR loaded")
}

func (h *Handler) formSettings(c *gin.Context) {
	body, err := valid.Body(c)
	if fail(c, err) {
		return
	}
	f := valid.NewForm(body)
	on, _ := f.Bool("guardianDocRequired", false, nil)
	if fail(c, f.Err()) {
		return
	}
	hostel, p, ok := scope(c)
	if !ok {
		return
	}
	out, err := h.FormSettings(c, hostel, on, p)
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Form settings saved")
}

func (h *Handler) forms(c *gin.Context) {
	hostel, _, ok := scope(c)
	if !ok {
		return
	}
	out, err := h.Forms(c, hostel)
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Forms loaded")
}

func (h *Handler) form(c *gin.Context) {
	hostel, _, ok := scope(c)
	if !ok {
		return
	}
	out, err := h.Form(c, hostel, c.Param("formId"))
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Form loaded")
}

func (h *Handler) declineForm(c *gin.Context) {
	hostel, p, ok := scope(c)
	if !ok {
		return
	}
	out, err := h.DeclineForm(c, hostel, c.Param("formId"), p)
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Form declined")
}

func (h *Handler) formPhoto(c *gin.Context) {
	hostel, _, ok := scope(c)
	if !ok {
		return
	}
	rd, mime, err := h.FormPhoto(c, hostel, c.Param("formId"))
	if fail(c, err) {
		return
	}
	sendPhoto(c, rd, mime)
}

func sendPhoto(c *gin.Context, rd photoStream, mime string) {
	defer rd.Close()
	c.Header("Cache-Control", "private, max-age=3600")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Content-Type", mime)
	c.Status(http.StatusOK)
	_, _ = io.Copy(c.Writer, rd)
}
