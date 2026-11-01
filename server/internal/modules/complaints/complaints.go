// Package complaints: the resident's side of modules/complaints. Staff handling lands with Phase 6.
package complaints

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/background"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

type Service struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Notify *notifications.Service
	Mail   *email.Sender
	Audit  *audit.Log
	Config *platformconfig.Service
	RT     *realtime.Client
	Cache  realtime.Bumper
	AppURL func(path string) string
}

func (s *Service) Register(v1 *gin.RouterGroup) {
	v1.GET("/resident/complaints", httpx.ETag(), s.list)
	v1.POST("/resident/complaints", s.create)
	v1.PATCH("/resident/complaints/:id/confirm-resolution", s.confirm)
}

// Row is a stored complaint.
type Row struct {
	ID               bson.ObjectID  `bson:"_id"`
	AdminResponse    string         `bson:"adminResponse"`
	Category         string         `bson:"category"`
	ConfirmedAt      *time.Time     `bson:"confirmedAt"`
	CreatedAt        *time.Time     `bson:"createdAt"`
	Description      string         `bson:"description"`
	HostelID         bson.ObjectID  `bson:"hostelId"`
	IsAnonymous      bool           `bson:"isAnonymous"`
	RejectedAt       *time.Time     `bson:"rejectedAt"`
	ResidentID       bson.ObjectID  `bson:"residentId"`
	ResolvedAt       *time.Time     `bson:"resolvedAt"`
	SlaBreachedAt    *time.Time     `bson:"slaBreachedAt"`
	SlaDueAt         time.Time      `bson:"slaDueAt"`
	Status           string         `bson:"status"`
	Title            string         `bson:"title"`
	UpdatedAt        *time.Time     `bson:"updatedAt"`
	VoiceNoteAssetID *bson.ObjectID `bson:"voiceNoteAssetId"`
}

func (r *Row) overdue() bool {
	return r.Status != "RESOLVED" && r.Status != "REJECTED" && r.SlaDueAt.Before(time.Now())
}

type attachment struct {
	ID          bson.ObjectID `bson:"_id"`
	ComplaintID bson.ObjectID `bson:"complaintId"`
	FileAssetID string        `bson:"fileAssetId"`
	HostelID    bson.ObjectID `bson:"hostelId"`
	UploadedAt  time.Time     `bson:"uploadedAt"`
	UploadedBy  bson.ObjectID `bson:"uploadedBy"`
}

func (a attachment) out() ordered.Map {
	return ordered.Map{{Key: "complaintId", Value: a.ComplaintID.Hex()}, {Key: "fileAssetId", Value: a.FileAssetID}, {Key: "hostelId", Value: a.HostelID.Hex()},
		{Key: "id", Value: a.ID.Hex()}, {Key: "uploadedAt", Value: httpx.ISO(a.UploadedAt)}, {Key: "uploadedBy", Value: a.UploadedBy.Hex()}}
}

type update struct {
	ID             bson.ObjectID `bson:"_id"`
	ActorID        bson.ObjectID `bson:"actorId"`
	ActorRole      string        `bson:"actorRole"`
	ComplaintID    bson.ObjectID `bson:"complaintId"`
	CreatedAt      *time.Time    `bson:"createdAt"`
	HostelID       bson.ObjectID `bson:"hostelId"`
	Message        string        `bson:"message"`
	NextStatus     string        `bson:"nextStatus"`
	PreviousStatus string        `bson:"previousStatus"`
	Type           string        `bson:"type"`
}

func iso(t *time.Time) any {
	if t == nil {
		return ordered.Undefined
	}
	return httpx.ISO(*t)
}

func strOrUndefined(s string) any {
	if s == "" {
		return ordered.Undefined
	}
	return s
}

func (u update) out() ordered.Map {
	return ordered.Map{{Key: "actorId", Value: u.ActorID.Hex()}, {Key: "actorRole", Value: u.ActorRole}, {Key: "complaintId", Value: u.ComplaintID.Hex()}, {Key: "createdAt", Value: iso(u.CreatedAt)},
		{Key: "hostelId", Value: u.HostelID.Hex()}, {Key: "id", Value: u.ID.Hex()}, {Key: "message", Value: u.Message}, {Key: "nextStatus", Value: strOrUndefined(u.NextStatus)},
		{Key: "previousStatus", Value: strOrUndefined(u.PreviousStatus)}, {Key: "type", Value: u.Type}}
}

func serialize(r *Row, atts []attachment, ups []update) ordered.Map {
	attOut, upOut := []ordered.Map{}, []ordered.Map{}
	for _, a := range atts {
		attOut = append(attOut, a.out())
	}
	for _, u := range ups {
		upOut = append(upOut, u.out())
	}
	voice := any(ordered.Undefined)
	if r.VoiceNoteAssetID != nil {
		voice = r.VoiceNoteAssetID.Hex()
	}
	return ordered.Map{{Key: "adminResponse", Value: r.AdminResponse}, {Key: "attachments", Value: attOut}, {Key: "category", Value: r.Category}, {Key: "confirmedAt", Value: iso(r.ConfirmedAt)},
		{Key: "createdAt", Value: iso(r.CreatedAt)}, {Key: "description", Value: r.Description}, {Key: "hostelId", Value: r.HostelID.Hex()}, {Key: "id", Value: r.ID.Hex()},
		{Key: "isAnonymous", Value: r.IsAnonymous}, {Key: "isOverdue", Value: r.overdue()}, {Key: "rejectedAt", Value: iso(r.RejectedAt)}, {Key: "residentId", Value: r.ResidentID.Hex()},
		{Key: "resolvedAt", Value: iso(r.ResolvedAt)}, {Key: "slaBreachedAt", Value: iso(r.SlaBreachedAt)}, {Key: "slaDueAt", Value: httpx.ISO(r.SlaDueAt)}, {Key: "status", Value: r.Status},
		{Key: "title", Value: r.Title}, {Key: "updatedAt", Value: iso(r.UpdatedAt)}, {Key: "updates", Value: upOut}, {Key: "voiceNoteAssetId", Value: voice}}
}

type summaryRow struct {
	Category  string `json:"category"`
	CreatedAt any    `json:"createdAt"`
	ID        string `json:"id"`
	IsOverdue bool   `json:"isOverdue"`
	Status    string `json:"status"`
	Title     string `json:"title"`
}

// Summary is summarizeResidentComplaints, for the dashboard.
type Summary struct {
	OpenCount int64        `json:"openCount"`
	Recent    []summaryRow `json:"recent"`
}

func Summarize(ctx context.Context, db *mongo.Database, r *residents.Record) (Summary, error) {
	filter := bson.D{{Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}}
	coll := db.Collection("complaints")
	cur, err := coll.Find(ctx, filter, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(3))
	if err != nil {
		return Summary{}, err
	}
	var rows []Row
	if err := cur.All(ctx, &rows); err != nil {
		return Summary{}, err
	}
	n, err := coll.CountDocuments(ctx, append(append(bson.D{}, filter...), bson.E{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"PENDING", "IN_PROGRESS"}}}}))
	if err != nil {
		return Summary{}, err
	}
	out := Summary{n, []summaryRow{}}
	for i := range rows {
		x := &rows[i]
		var created any
		if x.CreatedAt != nil {
			created = httpx.ISO(*x.CreatedAt)
		}
		out.Recent = append(out.Recent, summaryRow{x.Category, created, x.ID.Hex(), x.overdue(), x.Status, x.Title})
	}
	return out, nil
}

type listOut struct {
	Complaints []ordered.Map   `json:"complaints"`
	Pagination pagination.Meta `json:"pagination"`
	Resident   ordered.Map     `json:"resident"`
}

func (s *Service) list(c *gin.Context) {
	p, err := s.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, s.DB, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	filter := bson.D{{Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}}
	size := pagination.MaxPageSize
	q := pagination.Query{PageSize: &size}
	rng := pagination.RangeOf(q)
	coll := s.DB.Collection("complaints")
	cur, err := coll.Find(c, filter, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetSkip(int64(rng.Skip)).SetLimit(int64(rng.Limit)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []Row
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	total, err := coll.CountDocuments(c, filter)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	atts, ups := map[string][]attachment{}, map[string][]update{}
	if len(rows) > 0 {
		ids := bson.A{}
		for _, x := range rows {
			ids = append(ids, x.ID)
		}
		match := bson.D{{Key: "complaintId", Value: bson.D{{Key: "$in", Value: ids}}}}
		cur, err := s.DB.Collection("complaintattachments").Find(c, match, options.Find().SetSort(bson.D{{Key: "uploadedAt", Value: -1}}))
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var as []attachment
		if err := cur.All(c, &as); err != nil {
			httpx.Fail(c, err)
			return
		}
		for _, a := range as {
			atts[a.ComplaintID.Hex()] = append(atts[a.ComplaintID.Hex()], a)
		}
		cur, err = s.DB.Collection("complaintupdates").Find(c, match, options.Find().SetSort(bson.D{{Key: "createdAt", Value: 1}}))
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var us []update
		if err := cur.All(c, &us); err != nil {
			httpx.Fail(c, err)
			return
		}
		for _, u := range us {
			ups[u.ComplaintID.Hex()] = append(ups[u.ComplaintID.Hex()], u)
		}
	}
	out := listOut{Complaints: []ordered.Map{}, Pagination: pagination.MetaOf(q, int(total)), Resident: residents.Summary(r)}
	for i := range rows {
		id := rows[i].ID.Hex()
		out.Complaints = append(out.Complaints, serialize(&rows[i], atts[id], ups[id]))
	}
	httpx.OK(c, out, "Complaints loaded")
}

var categoryLabels = map[string]string{"FOOD": "Food", "MAINTENANCE": "Maintenance", "NOISE": "Noise", "OTHER": "Other", "PAYMENT": "Payment", "ROOM": "Room", "SAFETY": "Safety", "STAFF": "Staff"}

const titleMax = 160

func clamp(v string) string {
	if valid.JSLen(v) <= titleMax {
		return v
	}
	cut := valid.JSPrefix(v, titleMax-1)
	if i := strings.LastIndex(cut, " "); i >= 0 && valid.JSLen(cut[:i]) > titleMax/2 {
		cut = cut[:i]
	}
	return strings.TrimRightFunc(cut, func(r rune) bool { return valid.Trim(string(r)) == "" }) + "…"
}

// Title is complaintTitle: what was typed, else the description's first real
// line, else what kind of complaint it is.
func Title(category, description, title string, hasVoice bool) string {
	if typed := valid.Trim(title); valid.JSLen(typed) >= 2 {
		return clamp(typed)
	}
	for _, line := range strings.Split(description, "\n") {
		if l := valid.Trim(line); valid.JSLen(l) >= 2 {
			return clamp(l)
		}
	}
	label := categoryLabels[category]
	if label == "" {
		label = "Other"
	}
	if hasVoice {
		return label + " — voice note"
	}
	return label + " complaint"
}

func (s *Service) voiceNote(ctx context.Context, assetID string, hostelID bson.ObjectID, userID string) (*bson.ObjectID, error) {
	id, err := httpx.OID(assetID, "voice note id")
	if err != nil {
		return nil, err
	}
	var a struct {
		ID                bson.ObjectID  `bson:"_id"`
		HostelID          *bson.ObjectID `bson:"hostelId"`
		Kind              string         `bson:"kind"`
		MimeType          string         `bson:"mimeType"`
		OwnerID           *bson.ObjectID `bson:"ownerId"`
		UploadCompletedAt *time.Time     `bson:"uploadCompletedAt"`
	}
	err = s.DB.Collection("fileassets").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}}).Decode(&a)
	if err != nil && err != mongo.ErrNoDocuments {
		return nil, err
	}
	if err == mongo.ErrNoDocuments || a.UploadCompletedAt == nil {
		return nil, httpx.NewError(422, "VOICE_NOTE_NOT_READY", "That recording did not finish uploading. Record it again.", nil)
	}
	if a.HostelID == nil || *a.HostelID != hostelID || a.OwnerID == nil || a.OwnerID.Hex() != userID {
		return nil, httpx.NewError(404, "VOICE_NOTE_NOT_FOUND", "That recording was not found. Record it again.", nil)
	}
	if a.Kind != "COMPLAINT_NOTE" || !strings.HasPrefix(a.MimeType, "audio/") {
		return nil, httpx.NewError(422, "VOICE_NOTE_INVALID", "A voice note has to be an audio recording.", nil)
	}
	return &a.ID, nil
}

type createOut struct {
	Complaint ordered.Map `json:"complaint"`
	Resident  ordered.Map `json:"resident"`
}

func (s *Service) create(c *gin.Context) {
	p, err := s.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	ids := []string{}
	if list, ok := f.Array("attachmentAssetIds", false, true); ok {
		for i, raw := range list {
			sub := &valid.Form{M: map[string]any{"v": raw}}
			if v, ok := sub.Str("v", valid.S{Trim: true, Min: 1}); ok {
				ids = append(ids, v)
			}
			f.JoinScalar("attachmentAssetIds."+strconv.Itoa(i), sub)
		}
		f.Size("attachmentAssetIds", len(list), 0, 5, "", false)
	}
	def := "OTHER"
	category, _ := f.Enum("category", false, &def, "FOOD", "ROOM", "MAINTENANCE", "SAFETY", "PAYMENT", "STAFF", "NOISE", "OTHER")
	clientID, _ := f.Str("clientRequestId", valid.S{Opt: true, Trim: true, Min: 8, Max: 64})
	description, _ := f.Str("description", valid.S{Opt: true, Trim: true, Min: 2, Max: 4000})
	no := false
	anon, _ := f.Bool("isAnonymous", false, &no)
	title, _ := f.Str("title", valid.S{Opt: true, Trim: true, Min: 2, Max: 160})
	voice := ""
	if v, present := f.M["voiceNoteAssetId"]; present {
		voice, _ = valid.ObjectID(v, "voiceNoteAssetId", "", &f.Is, false)
	}
	if f.M != nil && len(f.Is) == 0 && description == "" && voice == "" {
		f.Is.Add("description", "Say what happened, either typed or recorded.")
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, s.DB, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	coll := s.DB.Collection("complaints")
	if clientID != "" {
		var ex Row
		err := coll.FindOne(c, bson.D{{Key: "clientRequestId", Value: clientID}, {Key: "residentId", Value: r.ID}}).Decode(&ex)
		if err == nil {
			httpx.Write(c, http.StatusCreated, createOut{serialize(&ex, nil, nil), residents.Summary(r)}, "Complaint submitted")
			return
		}
		if err != mongo.ErrNoDocuments {
			httpx.Fail(c, err)
			return
		}
	}
	sla := s.Config.OperationsTyped(c).ComplaintSlaHours
	var voiceID *bson.ObjectID
	if voice != "" {
		if voiceID, err = s.voiceNote(c, voice, r.HostelID, p.UserID); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	row := Row{ID: bson.NewObjectID(), Category: category, CreatedAt: &now, Description: description, HostelID: r.HostelID, IsAnonymous: anon, ResidentID: r.ID,
		SlaDueAt: now.Add(time.Duration(sla) * time.Hour), Status: "PENDING", Title: Title(category, description, title, voiceID != nil), UpdatedAt: &now, VoiceNoteAssetID: voiceID}
	doc := bson.D{{Key: "_id", Value: row.ID}, {Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}, {Key: "title", Value: row.Title}}
	if description != "" {
		doc = append(doc, bson.E{Key: "description", Value: description})
	}
	if voiceID != nil {
		doc = append(doc, bson.E{Key: "voiceNoteAssetId", Value: *voiceID})
	}
	doc = append(doc, bson.E{Key: "category", Value: category}, bson.E{Key: "isAnonymous", Value: anon})
	if clientID != "" {
		doc = append(doc, bson.E{Key: "clientRequestId", Value: clientID})
	} else {
		doc = append(doc, bson.E{Key: "clientRequestId", Value: nil})
	}
	doc = append(doc, bson.E{Key: "status", Value: "PENDING"}, bson.E{Key: "slaDueAt", Value: row.SlaDueAt}, bson.E{Key: "createdBy", Value: uid}, bson.E{Key: "updatedBy", Value: uid},
		bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := coll.InsertOne(c, doc); err != nil {
		httpx.Fail(c, err)
		return
	}
	atts := []attachment{}
	for _, id := range ids {
		a := attachment{bson.NewObjectID(), row.ID, id, r.HostelID, now, uid}
		_, err := s.DB.Collection("complaintattachments").InsertOne(c, bson.D{{Key: "_id", Value: a.ID}, {Key: "hostelId", Value: r.HostelID}, {Key: "complaintId", Value: row.ID},
			{Key: "fileAssetId", Value: id}, {Key: "uploadedBy", Value: uid}, {Key: "uploadedAt", Value: now}, {Key: "__v", Value: 0}})
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		atts = append(atts, a)
	}
	up, err := s.addUpdate(c, &row, p, uid, "CREATED", "Complaint submitted by resident.", "PENDING")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	meta := bson.D{{Key: "category", Value: category}, {Key: "isAnonymous", Value: anon}}
	if err := s.Audit.Write(c, audit.Entry{Action: "COMPLAINT_CREATED", ActorID: uid, EntityID: row.ID.Hex(), EntityType: "Complaint", HostelID: r.HostelID, Metadata: meta}); err != nil {
		httpx.Fail(c, err)
		return
	}
	s.notifyAdmins(c.Request.Context(), &row, r)
	httpx.Write(c, http.StatusCreated, createOut{serialize(&row, atts, []update{up}), residents.Summary(r)}, "Complaint submitted")
}

func (s *Service) addUpdate(ctx context.Context, row *Row, p *authz.Principal, uid bson.ObjectID, kind, message, next string) (update, error) {
	now := time.Now().UTC().Truncate(time.Millisecond)
	u := update{bson.NewObjectID(), uid, string(p.Role), row.ID, &now, row.HostelID, message, next, "", kind}
	doc := bson.D{{Key: "_id", Value: u.ID}, {Key: "hostelId", Value: row.HostelID}, {Key: "complaintId", Value: row.ID}, {Key: "actorId", Value: uid}, {Key: "actorRole", Value: string(p.Role)}, {Key: "type", Value: kind}}
	if message != "" {
		doc = append(doc, bson.E{Key: "message", Value: message})
	}
	if next != "" {
		doc = append(doc, bson.E{Key: "nextStatus", Value: next})
	}
	doc = append(doc, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "__v", Value: 0})
	_, err := s.DB.Collection("complaintupdates").InsertOne(ctx, doc)
	return u, err
}

// notifyAdmins is notifyAdminsOfNewComplaint; wholly best-effort.
func (s *Service) notifyAdmins(ctx context.Context, row *Row, r *residents.Record) {
	hostelName, err := residents.HostelName(ctx, s.DB, row.HostelID)
	var admins []residents.Contact
	if err == nil {
		admins, err = residents.HostelAdminContacts(ctx, s.DB, row.HostelID)
	}
	if err != nil {
		slog.WarnContext(ctx, "complaint_created_notify_failed", "error", err)
		return
	}
	author := r.FullName()
	if row.IsAnonymous {
		author = "An anonymous resident"
	}
	body := author + " filed a " + strings.ToLower(row.Category) + " complaint: " + row.Title
	content := email.NewComplaint(s.AppURL("/hostel-admin/complaints"), author, hostelName, row.Title, row.Category)
	var sends []func()
	for _, a := range admins {
		sends = append(sends, func() {
			s.Mail.Notify(ctx, email.Notification{Action: "complaint_created", HTML: content.HTML, Subject: content.Subject, To: a.Email, Category: content.Category, Topic: "COMPLAINT_ALERTS"})
		})
		if a.UserID != "" {
			sends = append(sends, func() {
				_, _ = s.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/hostel-admin/complaints", Body: body, Category: "COMPLAINT",
					Data: ordered.Map{{Key: "complaintId", Value: row.ID.Hex()}}, HostelID: row.HostelID.Hex(), Kind: "ACTION", Title: "New complaint", UserID: a.UserID})
			})
		}
	}
	background.Parallel(ctx, sends...)
	realtime.PublishResourceChange(ctx, s.RT, s.Cache, realtime.Change{HostelIDs: []string{row.HostelID.Hex()}, Topics: []realtime.Topic{realtime.Complaints}})
}

func (s *Service) confirm(c *gin.Context) {
	p, err := s.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	note, _ := f.Str("note", valid.S{Opt: true, Trim: true, Min: 2, Max: 1000})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, s.DB, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := httpx.OID(c.Param("id"), "complaint id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	notFound := httpx.NewError(404, "COMPLAINT_NOT_FOUND", "Complaint was not found.", nil)
	coll := s.DB.Collection("complaints")
	var row Row
	err = coll.FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}}).Decode(&row)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, notFound)
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if row.Status != "RESOLVED" {
		httpx.Fail(c, httpx.NewError(409, "COMPLAINT_NOT_RESOLVED", "Only resolved complaints can be confirmed.", nil))
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	err = coll.FindOneAndUpdate(c, bson.D{{Key: "_id", Value: row.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "confirmedAt", Value: now}, {Key: "updatedBy", Value: uid}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&row)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, notFound)
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	up, err := s.addUpdate(c, &row, p, uid, "RESIDENT_CONFIRMATION", note, "")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := s.Audit.Write(c, audit.Entry{Action: "COMPLAINT_RESOLUTION_CONFIRMED", ActorID: uid, EntityID: row.ID.Hex(), EntityType: "Complaint", HostelID: r.HostelID, Metadata: bson.D{}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, createOut{serialize(&row, nil, []update{up}), residents.Summary(r)}, "Complaint resolution confirmed")
}
