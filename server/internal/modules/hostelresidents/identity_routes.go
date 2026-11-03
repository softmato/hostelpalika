package hostelresidents

import (
	"errors"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// /users/resident-identity/* and /users/:userId/avatar (resident-identity.validation.ts
// for the schemas).

var (
	occupations = []string{"STUDENT", "WORKING_PROFESSIONAL", "OTHER"}
	govIDTypes  = []string{"CITIZENSHIP", "PASSPORT", "DRIVING_LICENSE", "STUDENT_ID", "NATIONAL_ID", "OTHER"}
	dobRe       = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	phoneChars  = regexp.MustCompile(`^\+?[\d\s().-]+$`)
	assetIDRe   = regexp.MustCompile(`(?i)^[a-f\d]{24}$`)
)

const phoneMsg = "Enter a phone number — digits only, with + and the country code if it isn't Nepali."

// isResidentPhone: one leading +, the separators people type, 7 to 15 digits.
func isResidentPhone(v string) bool {
	n := len(nonDigit.ReplaceAllString(v, ""))
	return phoneChars.MatchString(valid.Trim(v)) && n >= 7 && n <= 15
}

type profileForm struct {
	f   *valid.Form
	out ordered.Map
}

func (p *profileForm) put(key string, v any) { p.out = append(p.out, ordered.Pair{Key: key, Value: v}) }

// str is a required `z.string().trim().min().max()`.
func (p *profileForm) str(key string, min, max int) (string, bool) {
	v, ok := p.f.Str(key, valid.S{Trim: true, Min: min, Max: max})
	if ok {
		p.put(key, v)
	}
	return v, ok
}

// text is optionalText(max): blank reads as absent.
func (p *profileForm) text(key string, max int) {
	if !p.f.Present(key) || p.f.Blank(key) {
		return
	}
	if v, ok := p.f.Str(key, valid.S{Opt: true, Trim: true, Max: max}); ok {
		p.put(key, v)
	}
}

func (p *profileForm) phone(key string, opt bool) {
	if opt && (!p.f.Present(key) || p.f.Blank(key)) {
		return
	}
	p.str(key, 7, 24)
}

func (p *profileForm) email(key string) {
	if !p.f.Present(key) || p.f.Blank(key) {
		return
	}
	if v, ok := p.f.Email(key, true, ""); ok {
		p.put(key, v)
	}
}

// enum is enumWithDefault (def != "") or optionalEnum.
func (p *profileForm) enum(key, def string, values ...string) {
	if !p.f.Present(key) || p.f.Blank(key) {
		if def != "" {
			p.put(key, def)
		}
		return
	}
	if v, ok := p.f.Enum(key, true, nil, values...); ok {
		p.put(key, v)
	}
}

// parseProfile is residentProfileDataSchema over f; the output is zod's, in schema order.
func parseProfile(f *valid.Form) ordered.Map {
	p := &profileForm{f: f}
	p.str("fullName", 2, 120)
	if v, ok := f.M["dateOfBirth"].(string); ok && valid.Trim(v) != "" {
		v = valid.Trim(v)
		if !dobRe.MatchString(v) {
			f.Is.Add("dateOfBirth", "Use the YYYY-MM-DD format.")
		}
		if v > time.Now().UTC().Format("2006-01-02") {
			f.Is.Add("dateOfBirth", "Date of birth can't be in the future.")
		}
		p.put("dateOfBirth", v)
	} else {
		f.Hard = true
		f.Is.Add("dateOfBirth", "Enter your date of birth.")
	}
	if v, ok := f.Enum("gender", false, nil, residents.GenderValues...); ok {
		p.put("gender", v)
	}
	p.enum("bloodGroup", "UNKNOWN", residents.BloodGroups...)
	if v, ok := f.Str("primaryPhone", valid.S{Trim: true, Min: 7, Max: 24}); ok {
		if !isResidentPhone(v) {
			f.Is.Add("primaryPhone", phoneMsg)
		}
		p.put("primaryPhone", v)
	}
	p.phone("alternatePhone", true)
	if v, ok := f.Email("primaryEmail", false, ""); ok {
		p.put("primaryEmail", v)
	}
	p.email("backupEmail")
	p.text("permanentAddress", 240)
	p.text("city", 80)
	p.text("province", 80)
	p.text("district", 60)
	p.text("wardNo", 10)
	p.enum("occupation", "STUDENT", occupations...)
	p.text("institution", 160)
	p.text("courseOrDesignation", 120)
	p.text("levelOfStudy", 80)
	p.text("classTime", 60)
	p.str("guardianName", 2, 120)
	p.str("guardianRelation", 2, 60)
	p.phone("guardianPhone", false)
	p.email("guardianEmail")
	p.text("guardianOccupation", 80)
	p.text("secondGuardianName", 120)
	p.text("secondGuardianRelation", 60)
	p.phone("secondGuardianPhone", true)
	p.email("secondGuardianEmail")
	p.text("secondGuardianOccupation", 80)
	p.text("emergencyContactName", 120)
	p.text("emergencyContactRelation", 60)
	p.phone("emergencyContactPhone", true)
	p.text("emergencyContactAddress", 160)
	p.text("emergencyContactOccupation", 80)
	p.enum("dietaryPreference", "NO_PREFERENCE", residents.DietaryValues...)
	p.text("budgetRange", 40)
	p.text("medicalNotes", 500)
	if items, ok := f.Array("interests", false, true); ok {
		var kept []any
		for i, raw := range items {
			sub := &valid.Form{M: map[string]any{"v": raw}}
			if v, ok := sub.Str("v", valid.S{Trim: true, Min: 1, Max: 40}); ok && v != "" && !slices.Contains(kept, any(v)) {
				kept = append(kept, v)
			}
			f.JoinScalar("interests."+strconv.Itoa(i), sub)
		}
		f.Size("interests", len(items), 0, 12, "", false)
		if kept == nil {
			kept = []any{}
		}
		p.put("interests", kept)
	}
	p.enum("governmentIdType", "", govIDTypes...)
	p.text("governmentIdNumber", 40)
	p.text("governmentIdIssuedOn", 20)
	p.text("governmentIdIssuedAt", 80)
	residents.Signature(f, "signature", &p.out)
	if !f.Hard {
		backup, _ := pstr(p.out, "backupEmail")
		primary, _ := pstr(p.out, "primaryEmail")
		if backup != "" && backup == primary {
			f.Is.Add("backupEmail", "The backup email must be different from your account email.")
		}
	}
	return p.out
}

// parseSave is residentIdentitySaveSchema.
func parseSave(body any) (IdentityInput, error) {
	f := valid.NewForm(body)
	var in IdentityInput
	asset := func(key string) string {
		v, present := f.M[key]
		if f.M == nil || !present {
			return ""
		}
		s, _ := valid.ObjectID(v, key, "That is not a valid upload id.", &f.Is, false)
		return s
	}
	in.PhotoAssetID = asset("photoAssetId")
	f.Nest("profile", false, func(sub *valid.Form) { in.Profile = parseProfile(sub) })
	in.SignatureAssetID = asset("signatureAssetId")
	yes := true
	in.SharingEnabled, _ = f.Bool("sharingEnabled", false, &yes)
	if !f.Hard {
		if sig, _ := pstr(in.Profile, "signature"); sig != "" && in.SignatureAssetID != "" {
			f.Is.Add("signatureAssetId", "Send either a drawn signature or a photographed one, not both.")
		}
	}
	return in, f.Err()
}

func (h *Handler) registerIdentity(v1 *gin.RouterGroup) {
	signed := authz.Use(h.Guards.Require)
	g := v1.Group("/users/resident-identity")
	g.GET("", signed, httpx.ETag(), h.identity)
	g.PUT("", signed, h.saveIdentity)
	g.PATCH("", signed, h.setSharing)
	g.GET("/qr", signed, httpx.ETag(), h.identityQR)
	g.GET("/email-check", httpx.ETag(), h.emailCheck)
	g.GET("/phone-check", httpx.ETag(), h.phoneCheck)
	g.GET("/photo", signed, h.ownPhoto)
	g.PUT("/photo", signed, h.setPhoto)
	g.DELETE("/photo", signed, h.clearPhoto)
	g.GET("/signature", signed, h.ownSignature)
	v1.GET("/users/:userId/avatar", signed, h.avatar)
	v1.GET("/account/saved-hostels", signed, h.getSaved)
	v1.POST("/account/saved-hostels", signed, h.postSaved)
}

func caller(c *gin.Context) (bson.ObjectID, bool) {
	id, err := objectID(authz.From(c).UserID, "user id")
	return id, !fail(c, err)
}

func (h *Handler) identity(c *gin.Context) {
	if u, ok := caller(c); ok {
		out, err := h.Identity(c, u)
		if !fail(c, err) {
			httpx.OK(c, out, "Resident identity loaded")
		}
	}
}

func (h *Handler) identityQR(c *gin.Context) {
	if u, ok := caller(c); ok {
		out, err := h.IdentityQR(c, u)
		if !fail(c, err) {
			httpx.OK(c, out, "Resident QR ready")
		}
	}
}

func (h *Handler) saveIdentity(c *gin.Context) {
	u, ok := caller(c)
	if !ok {
		return
	}
	body, err := valid.Body(c)
	if fail(c, err) {
		return
	}
	in, err := parseSave(body)
	if fail(c, err) {
		return
	}
	out, err := h.SaveIdentity(c, u, in)
	if !fail(c, err) {
		httpx.OK(c, out, "Resident profile saved")
	}
}

func (h *Handler) setSharing(c *gin.Context) {
	u, ok := caller(c)
	if !ok {
		return
	}
	body, err := valid.Body(c)
	if fail(c, err) {
		return
	}
	f := valid.NewForm(body)
	on, _ := f.Bool("sharingEnabled", false, nil)
	if fail(c, f.Err()) {
		return
	}
	out, err := h.SetSharing(c, u, on)
	if fail(c, err) {
		return
	}
	msg := "Sharing turned off"
	if on {
		msg = "Sharing turned on"
	}
	httpx.OK(c, out, msg)
}

// check is the email/phone check's order: rate limit, then sign-in, then the query.
func (h *Handler) check(c *gin.Context, ns string) (bson.ObjectID, map[string]string, bool) {
	if h.Limiter != nil && fail(c, h.Limiter.Check(c, ns, 30, h.Limiter.FormWindow)) {
		return bson.ObjectID{}, nil, false
	}
	p, err := h.Guards.Require(c)
	if fail(c, err) {
		return bson.ObjectID{}, nil, false
	}
	u, err := objectID(p.UserID, "user id")
	return u, valid.Query(c), !fail(c, err)
}

func (h *Handler) emailCheck(c *gin.Context) {
	u, q, ok := h.check(c, "resident-email-check")
	if !ok {
		return
	}
	f := valid.NewForm(map[string]any{"email": q["email"]})
	addr, _ := f.Email("email", false, "")
	if valid.JSLen(addr) > 254 {
		f.Is.Add("email", valid.TooBig("string", 254, true))
	}
	if fail(c, f.Err()) {
		return
	}
	st, err := h.emailStatus(c, u, addr)
	if !fail(c, err) {
		httpx.OK(c, ordered.Map{{Key: "email", Value: addr}, {Key: "status", Value: st}}, "Email checked")
	}
}

func (h *Handler) phoneCheck(c *gin.Context) {
	u, q, ok := h.check(c, "resident-phone-check")
	if !ok {
		return
	}
	f := valid.NewForm(map[string]any{"phone": q["phone"]})
	phone, _ := f.Str("phone", valid.S{Trim: true, Min: 7, Max: 24})
	if !isResidentPhone(phone) {
		f.Is.Add("phone", phoneMsg)
	}
	if fail(c, f.Err()) {
		return
	}
	st, err := h.phoneStatus(c, u, phone)
	if !fail(c, err) {
		httpx.OK(c, ordered.Map{{Key: "phone", Value: phone}, {Key: "status", Value: st}}, "Phone checked")
	}
}

func (h *Handler) setPhoto(c *gin.Context) {
	u, ok := caller(c)
	if !ok {
		return
	}
	body, err := valid.Body(c)
	if fail(c, err) {
		return
	}
	f := valid.NewForm(body)
	var id string
	if f.M != nil {
		v, present := f.M["photoAssetId"]
		id, _ = valid.ObjectID(v, "photoAssetId", "That is not a valid upload id.", &f.Is, !present)
	}
	if fail(c, f.Err()) {
		return
	}
	out, err := h.SetPhoto(c, u, id)
	if !fail(c, err) {
		httpx.OK(c, out, "Photo added to your ID card")
	}
}

func (h *Handler) clearPhoto(c *gin.Context) {
	if u, ok := caller(c); ok {
		out, err := h.ClearPhoto(c, u)
		if !fail(c, err) {
			httpx.OK(c, out, "Photo removed from your ID card")
		}
	}
}

func stream(c *gin.Context, rd photoStream, mime string, err error) {
	if fail(c, err) {
		return
	}
	defer rd.Close()
	c.Header("Cache-Control", "private, max-age=300")
	c.Header("Content-Type", mime)
	c.Header("X-Content-Type-Options", "nosniff")
	c.Status(http.StatusOK)
	_, _ = io.Copy(c.Writer, rd)
}

func (h *Handler) ownPhoto(c *gin.Context) {
	if u, ok := caller(c); ok {
		rd, mime, err := h.OwnPhoto(c, u)
		stream(c, rd, mime, err)
	}
}

func (h *Handler) ownSignature(c *gin.Context) {
	if u, ok := caller(c); ok {
		rd, mime, err := h.OwnSignature(c, u)
		stream(c, rd, mime, err)
	}
}

func (h *Handler) avatar(c *gin.Context) {
	raw := c.Param("userId")
	if !assetIDRe.MatchString(raw) {
		fail(c, identityErr("Invalid user id.", "INVALID_OBJECT_ID", http.StatusUnprocessableEntity))
		return
	}
	id, _ := bson.ObjectIDFromHex(strings.ToLower(raw))
	rd, mime, err := h.Avatar(c, id)
	stream(c, rd, mime, err)
}

// savedHostels is saved-hostels.service.ts: the hostels this account has hearted.
func (h *Handler) savedHostels(c *gin.Context, u bson.ObjectID) {
	var row struct {
		IDs []bson.ObjectID `bson:"savedHostelIds"`
	}
	err := h.DB.Collection("users").FindOne(c, bson.D{{Key: "_id", Value: u}}, options.FindOne().SetProjection(bson.D{{Key: "savedHostelIds", Value: 1}})).Decode(&row)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		fail(c, err)
		return
	}
	ids := make([]string, len(row.IDs))
	for i, id := range row.IDs {
		ids[i] = id.Hex()
	}
	msg := "Saved hostels loaded"
	if c.Request.Method == http.MethodPost {
		msg = "Saved hostels updated"
	}
	httpx.OK(c, ordered.Map{{Key: "ids", Value: ids}}, msg)
}

func (h *Handler) getSaved(c *gin.Context) {
	if u, ok := caller(c); ok {
		h.savedHostels(c, u)
	}
}

// postSaved merges `add` in and takes `remove` out; it is also how a browser's
// anonymous hearts are bound at login. Ids that are not ObjectIds are dropped.
func (h *Handler) postSaved(c *gin.Context) {
	u, ok := caller(c)
	if !ok {
		return
	}
	body, err := valid.Body(c)
	if fail(c, err) {
		return
	}
	f := valid.NewForm(body)
	list := func(key string) bson.A {
		items, ok := f.Array(key, true, false)
		if !ok {
			return nil
		}
		out := bson.A{}
		for i, raw := range items {
			sub := &valid.Form{M: map[string]any{"v": raw}}
			if v, ok := sub.Str("v", valid.S{Max: 40}); ok {
				if oid, err := bson.ObjectIDFromHex(v); err == nil && len(v) == 24 {
					out = append(out, oid)
				}
			}
			f.JoinScalar(key+"."+strconv.Itoa(i), sub)
		}
		f.Size(key, len(items), 0, 200, "", false)
		return out
	}
	add, remove := list("add"), list("remove")
	if fail(c, f.Err()) {
		return
	}
	users := h.DB.Collection("users")
	if len(add) > 0 {
		if _, err := users.UpdateOne(c, bson.D{{Key: "_id", Value: u}}, bson.D{{Key: "$addToSet", Value: bson.D{{Key: "savedHostelIds", Value: bson.D{{Key: "$each", Value: add}}}}}}); fail(c, err) {
			return
		}
	}
	if len(remove) > 0 {
		if _, err := users.UpdateOne(c, bson.D{{Key: "_id", Value: u}}, bson.D{{Key: "$pull", Value: bson.D{{Key: "savedHostelIds", Value: bson.D{{Key: "$in", Value: remove}}}}}}); fail(c, err) {
			return
		}
	}
	h.savedHostels(c, u)
}
