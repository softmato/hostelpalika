package hostelresidents

import (
	"io"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/ratelimit"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Handler mounts /hostel-admin/residents.
type Handler struct {
	*Service
	Guards  *authz.Guards
	Cache   *cache.Cache
	Limiter *ratelimit.Limiter
}

var statuses = []string{"PENDING", "ACTIVE", "SUSPENDED", "MOVED_OUT"}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	staff := authz.Use(h.Guards.RequireHostelStaff)
	reg := hostelrooms.Cap(h.Guards, "registerResidents")
	v1.GET("/hostel-admin/resident-scan", reg, httpx.ETag(), h.scan)
	v1.GET("/hostel-admin/resident-scan/photo", reg, h.scanPhoto)
	v1.GET("/hostel-admin/resident-lookup", reg, httpx.ETag(), h.lookup)
	h.registerIdentity(v1)
	a := v1.Group("/hostel-admin/residents")
	h.registerExisting(a, reg)
	a.GET("", staff, h.list)
	a.POST("", reg, h.create)
	a.GET("/:id", staff, httpx.ETag(), h.get)
	a.PATCH("/:id", reg, h.update)
	a.PATCH("/:id/status", reg, h.status)
	a.DELETE("/:id", reg, h.remove)
	a.GET("/:id/contacts", reg, httpx.ETag(), h.contactsOf)
	a.GET("/:id/photo", staff, h.photo)
	a.GET("/admission-form-link", reg, httpx.ETag(), h.formLink)
	a.PATCH("/admission-form-link", reg, h.formSettings)
	a.GET("/admission-forms", reg, httpx.ETag(), h.forms)
	a.GET("/admission-forms/:formId", reg, httpx.ETag(), h.form)
	a.DELETE("/admission-forms/:formId", reg, h.declineForm)
	a.GET("/admission-forms/:formId/photo", reg, h.formPhoto)
	a.GET("/:id/leave", hostelrooms.Cap(h.Guards, "viewPayments"), httpx.ETag(), h.leaves)
	a.GET("/:id/credit-score", hostelrooms.Cap(h.Guards, "viewPayments"), httpx.ETag(), h.creditScore)
	a.POST("/:id/leave", hostelrooms.Cap(h.Guards, "recordCash"), h.addLeave)
	a.DELETE("/:id/leave/:leaveId", hostelrooms.Cap(h.Guards, "recordCash"), h.cancelLeave)
	a.GET("/:id/move-in", reg, httpx.ETag(), h.moveIn)
	a.POST("/:id/move-in", reg, h.saveMoveIn)
	a.GET("/:id/move-out", reg, httpx.ETag(), h.moveOut)
	a.POST("/:id/move-out", reg, h.saveMoveOut)
	a.POST("/:id/write-off", hostelrooms.Cap(h.Guards, "recordCash"), h.writeOff)
	a.POST("/:id/activation-code", reg, h.activation(http.StatusCreated, "Activation code generated"))
	a.PATCH("/:id/activation-code", reg, h.activation(http.StatusOK, "Activation code regenerated"))
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
	if v == nil {
		ok = false
	}
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

func (h *Handler) leaves(c *gin.Context) {
	hostel, _, ok := scope(c)
	if !ok {
		return
	}
	out, err := h.Leaves(c, hostel, c.Param("id"))
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Days away")
}

var dayRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func (h *Handler) addLeave(c *gin.Context) {
	body, err := valid.Body(c)
	if fail(c, err) {
		return
	}
	f := valid.NewForm(body)
	from, _ := f.Str("from", valid.S{Re: dayRe, ReSrc: `/^\d{4}-\d{2}-\d{2}$/`})
	hid, _ := f.Str("hostelId", valid.S{Opt: true})
	note, _ := f.Str("note", valid.S{Opt: true, Trim: true, Max: 200})
	to, _ := f.Str("to", valid.S{Re: dayRe, ReSrc: `/^\d{4}-\d{2}-\d{2}$/`})
	if fail(c, f.Err()) {
		return
	}
	hostel, ok := hostelrooms.HostelOf(c, hid)
	if !ok {
		return
	}
	out, err := h.AddLeave(c, hostel, c.Param("id"), from, to, note, authz.From(c))
	if fail(c, err) {
		return
	}
	httpx.Write(c, http.StatusCreated, out, "Saved")
}

func (h *Handler) cancelLeave(c *gin.Context) {
	hostel, p, ok := scope(c)
	if !ok {
		return
	}
	out, err := h.CancelLeave(c, hostel, c.Param("id"), c.Param("leaveId"), p)
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Removed")
}

// strList is z.array(z.string().trim().min(1)).max(max).default([]).
func strList(f *valid.Form, key string, max int) []string {
	arr, ok := f.Array(key, true, true)
	if !ok {
		return nil
	}
	out := []string{}
	for i, v := range arr {
		path := key + "." + strconv.Itoa(i)
		str, isStr := v.(string)
		if !isStr {
			f.Is.Add(path, valid.Type("string", valid.Received(v, false)))
			continue
		}
		str = valid.Trim(str)
		if str == "" {
			f.Is.Add(path, valid.TooSmall("string", 1, true))
			continue
		}
		out = append(out, str)
	}
	f.Size(key, len(arr), 0, max, "", false)
	return out
}

func optStr(f *valid.Form, key string, max int) *string {
	if s, ok := f.Str(key, valid.S{Opt: true, Trim: true, Max: max}); ok {
		return &s
	}
	return nil
}

func (h *Handler) moveIn(c *gin.Context) {
	q := valid.Query(c)
	out, err := h.MoveIn(c, c.Param("id"), q["hostelId"], authz.From(c))
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Move-in checklist loaded")
}

func (h *Handler) saveMoveIn(c *gin.Context) {
	body, err := valid.Body(c)
	if fail(c, err) {
		return
	}
	f := valid.NewForm(body)
	var in MoveInIn
	in.BedCondition = optStr(f, "bedCondition", 1000)
	in.DepositAmount, _ = f.Num("depositAmount", valid.N{Opt: true, Min: valid.P(0), Default: valid.P(0)})
	in.DocumentsCollected = strList(f, "documentsCollected", 20)
	hid := hostelrooms.OptionalID(f, "hostelId", "Invalid object id.")
	in.ItemsProvided = strList(f, "itemsProvided", 50)
	in.RoomCondition = optStr(f, "roomCondition", 1000)
	in.RoomPhotoAssetIDs = strList(f, "roomPhotoAssetIds", 20)
	def := false
	in.RulesAccepted, _ = f.Bool("rulesAccepted", true, &def)
	if fail(c, f.Err()) {
		return
	}
	out, err := h.SaveMoveIn(c, c.Param("id"), hid, in, authz.From(c))
	if fail(c, err) {
		return
	}
	httpx.Write(c, http.StatusCreated, out, "Move-in checklist saved")
}

func (h *Handler) moveOut(c *gin.Context) {
	q := valid.Query(c)
	out, err := h.MoveOut(c, c.Param("id"), q["hostelId"], q["date"], authz.From(c))
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Move-out checklist loaded")
}

func (h *Handler) saveMoveOut(c *gin.Context) {
	body, err := valid.Body(c)
	if fail(c, err) {
		return
	}
	f := valid.NewForm(body)
	var in MoveOutIn
	in.DamageNotes = optStr(f, "damageNotes", 2000)
	in.DepositRefundAmount, _ = f.Num("depositRefundAmount", valid.N{Opt: true, Min: valid.P(0), Default: valid.P(0)})
	pending := "PENDING"
	in.DepositRefundDecision, _ = f.Enum("depositRefundDecision", true, &pending, "PENDING", "APPROVED", "PARTIAL", "FORFEITED")
	in.FinalReceiptAssetID = optStr(f, "finalReceiptAssetId", 0)
	hid := hostelrooms.OptionalID(f, "hostelId", "Invalid object id.")
	in.ItemReturnNotes = optStr(f, "itemReturnNotes", 2000)
	if s, ok := f.Str("moveOutDate", valid.S{Opt: true, Re: dayRe, ReSrc: `/^\d{4}-\d{2}-\d{2}$/`}); ok {
		in.MoveOutDate = s
	}
	if s, ok := f.Enum("lastMonthCharge", true, nil, "FULL_MONTH", "TILL_DAY"); ok {
		in.LastMonthCharge = s
	}
	keep := "KEEP"
	in.Dues, _ = f.Enum("dues", true, &keep, "KEEP", "WRITE_OFF")
	if fail(c, f.Err()) {
		return
	}
	p := authz.From(c)
	if in.Dues == "WRITE_OFF" {
		if _, err := h.Guards.RequireHostelCapability(c, "recordCash"); fail(c, err) {
			return
		}
	}
	out, err := h.SaveMoveOut(c, c.Param("id"), hid, in, p)
	if fail(c, err) {
		return
	}
	httpx.Write(c, http.StatusCreated, out, "Move-out checklist saved")
}

func (h *Handler) writeOff(c *gin.Context) {
	reason, hid := "Written off after move-out", ""
	if body, err := valid.Body(c); err == nil {
		if _, isObj := body.(map[string]any); isObj {
			f := valid.NewForm(body)
			hid = hostelrooms.OptionalID(f, "hostelId", "Invalid object id.")
			if s, ok := f.Str("reason", valid.S{Opt: true, Trim: true, Min: 3, Max: 200}); ok {
				reason = s
			}
			if fail(c, f.Err()) {
				return
			}
		}
	}
	out, err := h.WriteOff(c, c.Param("id"), hid, reason, authz.From(c))
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Written off")
}

// truthy is z.coerce.boolean(): Boolean(value).
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0 && x == x
	}
	return true
}

func (h *Handler) activation(status int, msg string) gin.HandlerFunc {
	return func(c *gin.Context) {
		body, err := valid.Body(c)
		if fail(c, err) {
			return
		}
		f := valid.NewForm(body)
		var in ActivationIn
		if n, ok := f.Num("expiresInHours", valid.N{Opt: true, Coerce: true, Int: true, Min: valid.P(1), Max: valid.P(1440)}); ok {
			in.ExpiresInHours = int(n)
		}
		hid := hostelrooms.OptionalID(f, "hostelId", "Invalid object id.")
		in.SendEmail = true
		if v, present := f.M["sendEmail"]; present {
			in.SendEmail = truthy(v)
		}
		if fail(c, f.Err()) {
			return
		}
		out, err := h.GenerateActivation(c, c.Param("id"), hid, in, authz.From(c))
		if fail(c, err) {
			return
		}
		httpx.Write(c, status, out, msg)
	}
}

func (h *Handler) status(c *gin.Context) {
	body, err := valid.Body(c)
	if fail(c, err) {
		return
	}
	f := valid.NewForm(body)
	hid := hostelrooms.OptionalID(f, "hostelId", "Invalid object id.")
	status, _ := f.Enum("status", false, nil, statuses...)
	if fail(c, f.Err()) {
		return
	}
	out, err := h.UpdateStatus(c, c.Param("id"), hid, status, authz.From(c))
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Resident status updated")
}

func upload(f *valid.Form, withKind bool) Upload {
	var u Upload
	u.Token, _ = f.Str("claimToken", valid.S{Trim: true, Min: 10, Max: 200})
	v, present := f.M["fileAssetId"]
	u.AssetID, _ = valid.ObjectID(v, "fileAssetId", "That photo could not be read.", &f.Is, !present)
	if withKind {
		u.Kind, _ = f.Enum("kind", false, nil, "APPLICANT_ID", "GUARDIAN_ID")
	}
	return u
}

func (h *Handler) create(c *gin.Context) {
	body, err := valid.Body(c)
	if fail(c, err) {
		return
	}
	f := valid.NewForm(body)
	var in CreateIn
	fee := valid.N{Opt: true, Coerce: true, Int: true, Min: valid.P(0), Max: valid.P(10_000_000)}
	num := func(key string) *float64 {
		if n, ok := f.Num(key, fee); ok {
			return &n
		}
		return nil
	}
	in.HostelID = hostelrooms.OptionalID(f, "hostelId", "Invalid object id.")
	in.MonthlyFee, in.AdmissionFee, in.FormFee = num("monthlyFee"), num("admissionFee"), num("formFee")
	in.FeeReason, _ = f.Str("feeReason", valid.S{Opt: true, Trim: true, Min: 3, Max: 120})
	in.RoomID = hostelrooms.OptionalID(f, "roomId", "Invalid object id.")
	in.DepositAmount = num("depositAmount")
	in.Email, _ = f.Str("email", valid.S{Opt: true, Trim: true, Email: true})
	in.First, _ = f.Str("firstName", valid.S{Trim: true, Min: 1, Max: 80})
	in.Last, _ = f.Str("lastName", valid.S{Trim: true, Min: 1, Max: 80})
	if t, ok := calendarDate(f, "moveInDate", false); ok {
		in.MoveInDate = t
	}
	in.Phone, _ = f.Str("phone", valid.S{Trim: true, Min: 7, Max: 24})
	in.ReferralCode, _ = f.Str("referralCode", valid.S{Opt: true, Trim: true, Min: 4, Max: 32})
	student, active := "STUDENT", "ACTIVE"
	in.ResidentType, _ = f.Enum("residentType", true, &student, "STUDENT", "WORKING_PROFESSIONAL", "OTHER")
	in.RoomType, _ = f.Str("roomType", valid.S{Trim: true, Min: 1, Max: 80})
	if s, ok := f.Enum("billingCycle", true, nil, "CALENDAR_MONTH", "SAME_DAY"); ok && s != "" {
		in.BillingCycle = &s
	}
	in.Status, _ = f.Enum("status", true, &active, statuses...)
	in.UserResidentID, _ = f.Str("userResidentId", valid.S{Opt: true, Trim: true, Min: 1, Max: 200})
	if f.Present("details") {
		if d, ok := residents.ParseDetails(f, "details"); ok {
			in.Details = d
		}
	}
	in.AdmissionFormID = hostelrooms.OptionalID(f, "admissionFormId", "Invalid object id.")
	if f.Present("photo") {
		f.Nest("photo", false, func(s *valid.Form) { u := upload(s, false); in.Photo = &u })
	}
	if items, ok := f.Array("documents", true, true); ok {
		aborted := false
		for i, raw := range items {
			m, isObj := raw.(map[string]any)
			if !isObj {
				aborted = true
				f.Is.Add("documents."+strconv.Itoa(i), valid.Type("object", valid.Received(raw, false)))
				continue
			}
			sub := &valid.Form{M: m}
			in.Documents = append(in.Documents, upload(sub, true))
			f.Join("documents."+strconv.Itoa(i), sub)
		}
		f.Size("documents", len(items), 0, 4, "", aborted)
	}
	anyFee := in.MonthlyFee != nil || in.AdmissionFee != nil || in.FormFee != nil || in.DepositAmount != nil
	if anyFee && in.FeeReason == "" {
		f.Is.Add("feeReason", "Say why this resident pays a different fee.")
	}
	if fail(c, f.Err()) {
		return
	}
	hostel, ok := hostelrooms.HostelOf(c, in.HostelID)
	if !ok {
		return
	}
	out, err := h.Create(c, hostel, in, authz.From(c))
	if fail(c, err) {
		return
	}
	httpx.Write(c, http.StatusCreated, out, "Resident created")
}
