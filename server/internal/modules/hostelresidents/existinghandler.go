package hostelresidents

import (
	"encoding/base64"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

const xlsxType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

var monthKey = regexp.MustCompile(`^\d{4}-\d{2}$`)

func (h *Handler) registerExisting(a *gin.RouterGroup, reg gin.HandlerFunc) {
	a.GET("/existing", reg, h.existingGet)
	a.PUT("/existing", reg, h.existingPut)
	a.DELETE("/existing", reg, h.existingClear)
	a.POST("/existing/add", reg, h.existingAdd)
	a.POST("/existing/file", reg, h.existingFile)
	a.POST("/existing/one", reg, h.existingOne)
	a.GET("/existing/template", reg, h.existingTemplate)
	a.GET("/join-link", reg, h.joinLinkGet)
	a.PATCH("/join-link", reg, h.joinLinkPatch)
	a.GET("/join-requests", reg, h.joinRequests)
	a.POST("/join-requests/:requestId", reg, h.joinDecide)
}

// rupees is `z.coerce.number().int("Write rupees without paisa.").min(0)`.
func rupees(f *valid.Form, key string, nullable bool) *int64 {
	if v, present := f.M[key]; !present || (nullable && v == nil) {
		if !nullable {
			zero := int64(0)
			return &zero
		}
		return nil
	}
	n, ok := f.Num(key, valid.N{Coerce: true, Int: true, IntMsg: "Write rupees without paisa.", Min: valid.P(0)})
	if !ok {
		return nil
	}
	v := int64(n)
	return &v
}

// parseRow is existingResidentRowSchema (withID) or the same minus `id`.
func parseRow(f *valid.Form, withID bool) RowIn {
	var r RowIn
	if withID && f.Present("id") {
		v := f.M["id"]
		r.ID, _ = valid.ObjectID(v, "id", "Invalid string: must match pattern /^[a-f\\d]{24}$/i", &f.Is, false)
	}
	if n := rupees(f, "depositPaid", false); n != nil {
		r.DepositPaid = *n
	}
	r.Email, _ = f.Str("email", valid.S{Opt: true, Trim: true, Max: 160})
	r.FullName, _ = f.Str("fullName", valid.S{Opt: true, Trim: true, Max: 120})
	if v, present := f.M["joinedDate"]; present && v != nil {
		if t, ok := valid.CoerceDate(v); ok {
			r.JoinedDate = &t
		} else {
			f.Is.Add("joinedDate", "Invalid input: expected date, received Date")
		}
	}
	r.MonthlyRent = rupees(f, "monthlyRent", true)
	if n := rupees(f, "oldDues", false); n != nil {
		r.OldDues = *n
	}
	if n := rupees(f, "partPaid", false); n != nil {
		r.PartPaid = *n
	}
	if v, present := f.M["paidTill"]; present && v != nil {
		if s, ok := f.Str("paidTill", valid.S{Re: monthKey, ReMsg: "Choose a month.", ReSrc: `/^\d{4}-\d{2}$/`}); ok {
			r.PaidTill = &s
		}
	}
	r.Phone, _ = f.Str("phone", valid.S{Opt: true, Trim: true, Max: 24})
	r.RoomNumber, _ = f.Str("roomNumber", valid.S{Opt: true, Trim: true, Max: 20})
	r.RoomType, _ = f.Str("roomType", valid.S{Opt: true, Trim: true, Max: 80})
	return r
}

func (h *Handler) existingGet(c *gin.Context) {
	hostel, _, ok := scope(c)
	if !ok {
		return
	}
	out, err := h.ExistingView(c, hostel)
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "List loaded")
}

func (h *Handler) existingClear(c *gin.Context) {
	hostel, _, ok := scope(c)
	if !ok {
		return
	}
	out, err := h.ClearList(c, hostel)
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "List cleared")
}

func (h *Handler) existingPut(c *gin.Context) {
	hostel, p, ok := scope(c)
	if !ok {
		return
	}
	body, err := valid.Body(c)
	if fail(c, err) {
		return
	}
	f := valid.NewForm(body)
	var rows []RowIn
	if items, ok := f.Array("rows", false, false); ok {
		aborted := false
		for i, raw := range items {
			m, isObj := raw.(map[string]any)
			if !isObj {
				aborted = true
				f.Is.Add("rows."+strconv.Itoa(i), valid.Type("object", valid.Received(raw, false)))
				continue
			}
			sub := &valid.Form{M: m}
			rows = append(rows, parseRow(sub, true))
			f.Join("rows."+strconv.Itoa(i), sub)
		}
		_ = aborted
		if len(items) > 500 {
			f.Is.Add("rows", "A list can hold 500 residents.")
		}
	}
	if fail(c, f.Err()) {
		return
	}
	out, err := h.SaveRows(c, hostel, rows, p)
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "List saved")
}

func (h *Handler) existingAdd(c *gin.Context) {
	hostel, p, ok := scope(c)
	if !ok {
		return
	}
	res, view, err := h.AddAll(c, hostel, p, "")
	if fail(c, err) {
		return
	}
	httpx.OK(c, ordered.Map{{Key: "result", Value: res.JSON()}, {Key: "view", Value: view}}, "Residents added")
}

func (h *Handler) existingFile(c *gin.Context) {
	hostel, p, ok := scope(c)
	if !ok {
		return
	}
	body, err := valid.Body(c)
	if fail(c, err) {
		return
	}
	f := valid.NewForm(body)
	content, _ := f.Str("contentBase64", valid.S{Min: 1, Max: 3_000_000})
	f.Str("fileName", valid.S{Opt: true, Trim: true, Max: 200})
	if fail(c, f.Err()) {
		return
	}
	raw, _ := base64.StdEncoding.DecodeString(content)
	if len(raw) == 0 {
		raw, _ = base64.RawStdEncoding.DecodeString(content)
	}
	out, err := h.AddFile(c, hostel, raw, p)
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "File read")
}

func (h *Handler) existingTemplate(c *gin.Context) {
	hostel, _, ok := scope(c)
	if !ok {
		return
	}
	body, name, err := h.Template(c, hostel)
	if fail(c, err) {
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.Header("Content-Disposition", `attachment; filename="`+name+`"`)
	c.Data(http.StatusOK, xlsxType, body)
}

func (h *Handler) existingOne(c *gin.Context) {
	hostel, p, ok := scope(c)
	if !ok {
		return
	}
	body, err := valid.Body(c)
	if fail(c, err) {
		return
	}
	f := valid.NewForm(body)
	row := parseRow(f, false)
	row.UserResidentID, _ = f.Str("userResidentId", valid.S{Opt: true, Trim: true, Min: 1, Max: 200})
	if f.Present("details") {
		if d, ok := residents.ParseDetails(f, "details"); ok {
			row.Details = d
		}
	}
	row.AdmissionFormID = hostelrooms.OptionalID(f, "admissionFormId", "Invalid string: must match pattern /^[a-f\\d]{24}$/i")
	if f.Present("photo") {
		f.Nest("photo", false, func(s *valid.Form) { u := upload(s, false); row.Photo = &u })
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
			row.Documents = append(row.Documents, upload(sub, true))
			f.Join("documents."+strconv.Itoa(i), sub)
		}
		f.Size("documents", len(items), 0, 4, "", aborted)
	}
	if fail(c, f.Err()) {
		return
	}
	out, err := h.AddOne(c, hostel, row, p)
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Resident added")
}

func (h *Handler) joinLinkGet(c *gin.Context) {
	hostel, p, ok := scope(c)
	if !ok {
		return
	}
	out, err := h.JoinLink(c, hostel, p)
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Join link loaded")
}

func (h *Handler) joinLinkPatch(c *gin.Context) {
	hostel, p, ok := scope(c)
	if !ok {
		return
	}
	body, err := valid.Body(c)
	if fail(c, err) {
		return
	}
	f := valid.NewForm(body)
	var in JoinLinkIn
	if n, ok := f.Num("cap", valid.N{Opt: true, Coerce: true, Int: true, Min: valid.P(1), MinMsg: "Allow at least 1 request.", Max: valid.P(2000)}); ok {
		v := int(n)
		in.Cap = &v
	}
	if b, ok := f.Bool("enabled", true, nil); ok {
		in.Enabled = &b
	}
	if v, present := f.M["renew"]; present {
		if b, isBool := v.(bool); isBool && b {
			in.Renew = true
		} else {
			f.Is.Add("renew", "Invalid input: expected true")
		}
	}
	if fail(c, f.Err()) {
		return
	}
	out, err := h.UpdateJoinLink(c, hostel, in, p)
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Join link saved")
}

func (h *Handler) joinRequests(c *gin.Context) {
	hostel, _, ok := scope(c)
	if !ok {
		return
	}
	out, err := h.JoinRequests(c, hostel)
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Requests loaded")
}

func (h *Handler) joinDecide(c *gin.Context) {
	hostel, p, ok := scope(c)
	if !ok {
		return
	}
	body, err := valid.Body(c)
	if fail(c, err) {
		return
	}
	f := valid.NewForm(body)
	action, _ := f.M["action"].(string)
	if action != "add" && action != "reject" {
		f.Is.Add("action", "Invalid discriminator value. Expected 'add' | 'reject'")
		fail(c, f.Err())
		return
	}
	var out ordered.Map
	var msg string
	switch action {
	case "add":
		room, _ := f.Str("roomNumber", valid.S{Opt: true, Trim: true, Max: 20})
		if fail(c, f.Err()) {
			return
		}
		out, err = h.AddJoinRequest(c, hostel, c.Param("requestId"), p, room)
		msg = "Resident added"
	case "reject":
		reason, _ := f.Str("reason", valid.S{Trim: true, Min: 3, MinMsg: "Say what they need to fix.", Max: 300})
		if fail(c, f.Err()) {
			return
		}
		out, err = h.ReturnJoinRequest(c, hostel, c.Param("requestId"), reason, p)
		msg = "Request sent back"
	}
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, msg)
}

var _ = time.Now
var _ = authz.From
