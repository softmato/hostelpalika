package residents

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/files"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/ratelimit"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Public is the resident-facing doors that need no hostel scope: a hostel's
// Form QR (admission-form.service.ts) and the join link (resident-join.service.ts).
type Public struct {
	DB       *mongo.Database
	Guards   *authz.Guards
	Limiter  *ratelimit.Limiter
	Claims   files.Claims
	Personal *crypto.Personal
	Notify   *notifications.Service
	RT       *realtime.Client
	Cache    realtime.Bumper
}

func (p *Public) Register(v1 *gin.RouterGroup) {
	v1.GET("/public/join-requests/me", httpx.ETag(), MyJoinRequest(p.DB, p.Guards))
	v1.GET("/public/admission-form/:token", httpx.ETag(), p.admissionPage)
	v1.POST("/public/admission-form/:token", p.admissionSubmit)
	v1.GET("/public/join/:token", httpx.ETag(), p.joinGet)
	v1.POST("/public/join/:token", p.joinSend)
}

// maxWaiting is MAX_WAITING: forms waiting at once.
const maxWaiting = 60

func admissionErr(status int, code, msg string) *httpx.Error {
	return httpx.NewError(status, code, msg, nil)
}

type admissionLink struct {
	Enabled             bool          `bson:"enabled"`
	GuardianDocRequired bool          `bson:"guardianDocRequired"`
	HostelID            bson.ObjectID `bson:"hostelId"`
}

type hostelBrief struct {
	City string
	Name string
}

// openLink is openLink: the link and a live hostel behind it, or a 404.
func (p *Public) openLink(ctx context.Context, token string) (admissionLink, hostelBrief, error) {
	notFound := admissionErr(http.StatusNotFound, "ADMISSION_FORM_LINK_NOT_FOUND", "This form does not work any more. Ask the hostel for their new QR.")
	var link admissionLink
	err := p.DB.Collection("admissionformlinks").FindOne(ctx, bson.D{{Key: "token", Value: valid.Trim(token)}}).Decode(&link)
	if err == mongo.ErrNoDocuments {
		return link, hostelBrief{}, notFound
	}
	if err != nil {
		return link, hostelBrief{}, err
	}
	var h struct {
		Name     string `bson:"name"`
		Location struct {
			City string `bson:"city"`
		} `bson:"location"`
	}
	err = p.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: link.HostelID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
		options.FindOne().SetProjection(bson.D{{Key: "location.city", Value: 1}, {Key: "name", Value: 1}})).Decode(&h)
	if err == mongo.ErrNoDocuments {
		return link, hostelBrief{}, notFound
	}
	if err != nil {
		return link, hostelBrief{}, err
	}
	return link, hostelBrief{h.Location.City, h.Name}, nil
}

func (p *Public) admissionPage(c *gin.Context) {
	if err := p.Limiter.Check(c, "admission-form-read", 60, p.Limiter.FormWindow); err != nil {
		httpx.Fail(c, err)
		return
	}
	link, hostel, err := p.openLink(c, c.Param("token"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "guardianDocRequired", Value: link.GuardianDocRequired},
		{Key: "hostel", Value: ordered.Map{{Key: "city", Value: hostel.City}, {Key: "name", Value: hostel.Name}}}, {Key: "open", Value: link.Enabled}}, "Form loaded")
}

type docIn struct{ token, id, kind string }

type admissionIn struct {
	first, last, phone, email, residentType string
	details                                 ordered.Map
	photo                                   docIn
	docs                                    []docIn
}

var (
	// JS \s: ASCII whitespace plus the Unicode space separators and BOM.
	phoneShape = regexp.MustCompile(`^\+?[\d\s\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}().-]+$`)
	phoneSrc   = `/^\+?[\d\s().-]+$/`
)

const photoMsg = "That photo could not be read."

// parseUpload is applicantPhotoSchema (+ kind for a document).
func parseUpload(f *valid.Form, withKind bool) docIn {
	var d docIn
	d.token, _ = f.Str("claimToken", valid.S{Trim: true, Min: 10, Max: 200})
	v, present := f.M["fileAssetId"]
	d.id, _ = valid.ObjectID(v, "fileAssetId", photoMsg, &f.Is, !present)
	if withKind {
		d.kind, _ = f.Enum("kind", false, nil, "APPLICANT_ID", "GUARDIAN_ID")
	}
	return d
}

// parseAdmission is admissionFormInputSchema.
func parseAdmission(body any) (admissionIn, error) {
	f := valid.NewForm(body)
	var in admissionIn
	in.first, _ = f.Str("firstName", valid.S{Trim: true, Min: 1, Max: 80})
	in.last, _ = f.Str("lastName", valid.S{Trim: true, Min: 1, Max: 80})
	in.phone, _ = f.Str("phone", valid.S{Trim: true, Min: 7, Max: 24, Re: phoneShape, ReMsg: "Enter a phone number.", ReSrc: phoneSrc})
	in.email, _ = f.Email("email", false, "Write your email.")
	student := "STUDENT"
	in.residentType, _ = f.Enum("residentType", true, &student, "STUDENT", "WORKING_PROFESSIONAL", "OTHER")
	in.details, _ = ParseDetails(f, "details")
	f.Nest("photo", false, func(s *valid.Form) { in.photo = parseUpload(s, false) })
	if items, ok := f.Array("documents", false, true); ok {
		aborted := false
		for i, raw := range items {
			m, isObj := raw.(map[string]any)
			if !isObj {
				aborted = true
				f.Is.Add("documents."+itoa(i), valid.Type("object", valid.Received(raw, false)))
				continue
			}
			sub := &valid.Form{M: m}
			in.docs = append(in.docs, parseUpload(sub, true))
			f.Join("documents."+itoa(i), sub)
		}
		f.Size("documents", len(items), 0, 4, "", aborted)
	}
	if b, _ := f.M["agreed"].(bool); !b && f.M != nil {
		f.Is.Add("agreed", "Tick that you agree to the hostel's rules.")
	}
	return in, f.Err()
}

func itoa(i int) string { b, _ := json.Marshal(i); return string(b) }

func (p *Public) admissionSubmit(c *gin.Context) {
	if err := p.Limiter.Check(c, "admission-form-send", 8, p.Limiter.FormWindow); err != nil {
		httpx.Fail(c, err)
		return
	}
	principal, err := p.Guards.Load(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, err := parseAdmission(body)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	link, hostel, err := p.openLink(c, c.Param("token"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if !link.Enabled {
		httpx.Fail(c, admissionErr(http.StatusConflict, "ADMISSION_FORM_OFF", "This hostel is not taking forms right now."))
		return
	}
	if gap := CardGap(in.details); gap != "" {
		httpx.Fail(c, admissionErr(http.StatusUnprocessableEntity, "ADMISSION_FORM_INCOMPLETE", gap))
		return
	}
	hasApplicant, hasGuardian := false, false
	for _, d := range in.docs {
		hasApplicant = hasApplicant || d.kind == "APPLICANT_ID"
		hasGuardian = hasGuardian || d.kind == "GUARDIAN_ID"
	}
	if !hasApplicant {
		httpx.Fail(c, admissionErr(http.StatusUnprocessableEntity, "ADMISSION_FORM_DOCUMENT_MISSING", "Add a photo of your citizenship or ID."))
		return
	}
	if link.GuardianDocRequired && !hasGuardian {
		httpx.Fail(c, admissionErr(http.StatusUnprocessableEntity, "ADMISSION_FORM_DOCUMENT_MISSING", "This hostel needs your guardian's citizenship or ID too."))
		return
	}
	photoTypes := []string{"image/jpeg", "image/png", "image/webp"}
	photoID, err := p.Claims.ClaimToHostel(c, p.DB, in.photo.id, in.photo.token, link.HostelID, photoTypes, "photo")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	// One per kind; the last of a kind wins, in the order kinds first appeared.
	var kinds []string
	byKind := map[string]docIn{}
	for _, d := range in.docs {
		if _, seen := byKind[d.kind]; !seen {
			kinds = append(kinds, d.kind)
		}
		byKind[d.kind] = d
	}
	claimed := bson.A{}
	for _, k := range kinds {
		d := byKind[k]
		id, err := p.Claims.ClaimToHostel(c, p.DB, d.id, d.token, link.HostelID, append(photoTypes, "application/pdf"), "document")
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		claimed = append(claimed, bson.D{{Key: "fileAssetId", Value: id}, {Key: "kind", Value: k}})
	}
	var sealed any
	if !DetailsEmpty(in.details) {
		raw, err := json.Marshal(in.details)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		if p.Personal == nil {
			httpx.Fail(c, crypto.ErrPersonalKeyMissing)
			return
		}
		blob, err := p.Personal.Encrypt(raw)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		sealed = blob
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	fields := bson.D{{Key: "detailsData", Value: sealed}, {Key: "documents", Value: claimed}, {Key: "photoAssetId", Value: photoID},
		{Key: "email", Value: in.email}, {Key: "firstName", Value: in.first}, {Key: "lastName", Value: in.last}, {Key: "phone", Value: in.phone},
		{Key: "residentType", Value: in.residentType}, {Key: "submittedAt", Value: now}}
	if principal != nil {
		uid, err := bson.ObjectIDFromHex(principal.UserID)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		fields = append(fields, bson.E{Key: "userId", Value: uid})
	}
	forms := p.DB.Collection("admissionforms")
	set := append(append(bson.D{}, fields...), bson.E{Key: "updatedAt", Value: now})
	res := forms.FindOneAndUpdate(c, bson.D{{Key: "hostelId", Value: link.HostelID}, {Key: "phone", Value: in.phone}, {Key: "status", Value: "PENDING"}},
		bson.D{{Key: "$set", Value: set}})
	if res.Err() != nil && res.Err() != mongo.ErrNoDocuments {
		httpx.Fail(c, res.Err())
		return
	}
	if res.Err() == mongo.ErrNoDocuments {
		waiting, err := forms.CountDocuments(c, bson.D{{Key: "hostelId", Value: link.HostelID}, {Key: "status", Value: "PENDING"}})
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		if waiting >= maxWaiting {
			httpx.Fail(c, admissionErr(http.StatusConflict, "ADMISSION_FORM_FULL", "This hostel has too many forms waiting. Ask them at the desk."))
			return
		}
		doc := bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "hostelId", Value: link.HostelID}}
		if principal == nil {
			doc = append(doc, bson.E{Key: "userId", Value: nil})
		}
		doc = append(doc, fields...)
		doc = append(doc, bson.E{Key: "status", Value: "PENDING"}, bson.E{Key: "decidedAt", Value: nil}, bson.E{Key: "residentId", Value: nil},
			bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
		if _, err := forms.InsertOne(c, doc); err != nil {
			httpx.Fail(c, err)
			return
		}
		p.tellStaff(c, link.HostelID, trimJS(in.first+" "+in.last))
	}
	realtime.PublishResourceChange(c, p.RT, p.Cache, realtime.Change{Topics: []realtime.Topic{realtime.Residents}, HostelIDs: []string{link.HostelID.Hex()}})
	httpx.OK(c, ordered.Map{{Key: "hostelName", Value: hostel.Name}, {Key: "sent", Value: true}}, "Form sent")
}

func trimJS(s string) string { return valid.Trim(s) }

func (p *Public) tellStaff(ctx context.Context, hostelID bson.ObjectID, name string) {
	staff, err := HostelStaffUserIDs(ctx, p.DB, hostelID, false)
	if err != nil {
		slog.WarnContext(ctx, "Admission form: staff were not told", "error", err)
		return
	}
	for _, userID := range staff {
		if _, err := p.Notify.CreateInApp(ctx, notifications.Input{
			ActionURL: "/hostel-admin/residents", Body: "Filled your admission form · choose a bed to register them", Category: "RESIDENT",
			Data: ordered.Map{{Key: "type", Value: notifications.AdmissionFormTyp}}, HostelID: hostelID.Hex(),
			Title: name + " wants to live in your hostel", UserID: userID,
		}); err != nil {
			slog.WarnContext(ctx, "Admission form: staff were not told", "error", err)
			return
		}
	}
}
