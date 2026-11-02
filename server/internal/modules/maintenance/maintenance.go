// Package maintenance is the staff side of modules/maintenance: the request queue,
// its history and comments, and who gets told. The contractor's side is serviceproviders.
package maintenance

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/modules/serviceproviders"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

type Service struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Audit  *audit.Log
	Cache  *cache.Cache
	Config *platformconfig.Service
	Notify *notifications.Service
	RT     *realtime.Client
}

func (s *Service) Register(v1 *gin.RouterGroup) {
	g := v1.Group("/hostel-admin/maintenance")
	g.GET("/requests", s.list)
	g.POST("/requests", s.create)
	g.POST("/requests/:id/comment", s.comment)
	g.PATCH("/requests/:id/provider", s.assign)
	g.PATCH("/requests/:id/status", s.status)
	g.GET("/settings", httpx.ETag(), s.settings)
}

const defaultMinimumCharge = 200

var (
	categories = []string{"PLUMBING", "ELECTRICAL", "INTERNET", "CLEANING", "CARPENTRY", "PAINTING", "WATER", "APPLIANCE", "ROOM_REPAIR", "HEALTH", "OTHER"}
	statuses   = []string{"PENDING", "CONTACTED", "SCHEDULED", "COMPLETED", "CANCELLED"}
)

func errNotFound() error {
	return httpx.NewError(http.StatusNotFound, "MAINTENANCE_REQUEST_NOT_FOUND", "Maintenance request was not found.", nil)
}

type request struct {
	ID            bson.ObjectID  `bson:"_id"`
	Category      string         `bson:"category"`
	CompletedAt   *time.Time     `bson:"completedAt"`
	CostNote      string         `bson:"costNote"`
	CreatedAt     *time.Time     `bson:"createdAt"`
	Description   string         `bson:"description"`
	HostelID      bson.ObjectID  `bson:"hostelId"`
	Location      string         `bson:"location"`
	MinimumCharge *float64       `bson:"minimumCharge"`
	Priority      string         `bson:"priority"`
	ProviderID    *bson.ObjectID `bson:"providerId"`
	Remarks       string         `bson:"remarks"`
	RequestedBy   bson.ObjectID  `bson:"requestedBy"`
	ScheduledFor  *time.Time     `bson:"scheduledFor"`
	Status        string         `bson:"status"`
	Title         string         `bson:"title"`
	UpdatedAt     *time.Time     `bson:"updatedAt"`
	VoiceNote     *bson.ObjectID `bson:"voiceNoteAssetId"`
}

type history struct {
	ID             bson.ObjectID `bson:"_id"`
	Action         string        `bson:"action"`
	ActorID        bson.ObjectID `bson:"actorId"`
	CostNote       string        `bson:"costNote"`
	CreatedAt      *time.Time    `bson:"createdAt"`
	HostelID       bson.ObjectID `bson:"hostelId"`
	NextStatus     *string       `bson:"nextStatus"`
	Note           string        `bson:"note"`
	PreviousStatus *string       `bson:"previousStatus"`
	RequestID      bson.ObjectID `bson:"requestId"`
}

type comment struct {
	ID         bson.ObjectID `bson:"_id"`
	AuthorID   bson.ObjectID `bson:"authorId"`
	CreatedAt  *time.Time    `bson:"createdAt"`
	HostelID   bson.ObjectID `bson:"hostelId"`
	Message    string        `bson:"message"`
	RequestID  bson.ObjectID `bson:"requestId"`
	Visibility string        `bson:"visibility"`
}

func date(t *time.Time) any {
	if t == nil {
		return ordered.Undefined
	}
	return httpx.ISO(*t)
}

func hexOf(id *bson.ObjectID) any {
	if id == nil {
		return ordered.Undefined
	}
	return id.Hex()
}

func strOf(s *string) any {
	if s == nil {
		return ordered.Undefined
	}
	return *s
}

func serializeHistory(h *history) ordered.Map {
	return ordered.Map{{Key: "action", Value: h.Action}, {Key: "actorId", Value: h.ActorID.Hex()}, {Key: "costNote", Value: h.CostNote}, {Key: "createdAt", Value: date(h.CreatedAt)}, {Key: "hostelId", Value: h.HostelID.Hex()},
		{Key: "id", Value: h.ID.Hex()}, {Key: "nextStatus", Value: strOf(h.NextStatus)}, {Key: "note", Value: h.Note}, {Key: "previousStatus", Value: strOf(h.PreviousStatus)}, {Key: "requestId", Value: h.RequestID.Hex()}}
}

func serializeComment(x *comment) ordered.Map {
	return ordered.Map{{Key: "authorId", Value: x.AuthorID.Hex()}, {Key: "createdAt", Value: date(x.CreatedAt)}, {Key: "hostelId", Value: x.HostelID.Hex()}, {Key: "id", Value: x.ID.Hex()},
		{Key: "message", Value: x.Message}, {Key: "requestId", Value: x.RequestID.Hex()}, {Key: "visibility", Value: x.Visibility}}
}

func serialize(r *request, comments []comment, hist []history) ordered.Map {
	cs, hs := make([]ordered.Map, len(comments)), make([]ordered.Map, len(hist))
	for i := range comments {
		cs[i] = serializeComment(&comments[i])
	}
	for i := range hist {
		hs[i] = serializeHistory(&hist[i])
	}
	var minimum any
	if r.MinimumCharge != nil {
		minimum = *r.MinimumCharge
	}
	return ordered.Map{{Key: "category", Value: r.Category}, {Key: "comments", Value: cs}, {Key: "completedAt", Value: date(r.CompletedAt)}, {Key: "costNote", Value: r.CostNote}, {Key: "createdAt", Value: date(r.CreatedAt)},
		{Key: "description", Value: r.Description}, {Key: "history", Value: hs}, {Key: "hostelId", Value: r.HostelID.Hex()}, {Key: "id", Value: r.ID.Hex()}, {Key: "minimumCharge", Value: minimum}, {Key: "priority", Value: r.Priority},
		{Key: "providerId", Value: hexOf(r.ProviderID)}, {Key: "remarks", Value: r.Remarks}, {Key: "requestedBy", Value: r.RequestedBy.Hex()}, {Key: "location", Value: r.Location}, {Key: "scheduledFor", Value: date(r.ScheduledFor)},
		{Key: "status", Value: r.Status}, {Key: "title", Value: r.Title}, {Key: "updatedAt", Value: date(r.UpdatedAt)}, {Key: "voiceNoteAssetId", Value: hexOf(r.VoiceNote)}}
}

func now() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

func (s *Service) auditAndPublish(ctx context.Context, actor bson.ObjectID, r *request, action string, meta bson.D) error {
	if err := s.Audit.Write(ctx, audit.Entry{Action: action, ActorID: actor, EntityID: r.ID.Hex(), EntityType: "MaintenanceRequest", HostelID: r.HostelID, Metadata: meta}); err != nil {
		return err
	}
	realtime.PublishResourceChange(ctx, s.RT, s.Cache, realtime.Change{HostelIDs: []string{r.HostelID.Hex()}, Topics: []realtime.Topic{realtime.Maintenance}})
	return nil
}

func (s *Service) addHistory(ctx context.Context, r *request, actor bson.ObjectID, action, costNote string, next, prev *string, note string) (*history, error) {
	at := now()
	h := &history{ID: bson.NewObjectID(), Action: action, ActorID: actor, CostNote: costNote, CreatedAt: &at, HostelID: r.HostelID, NextStatus: next, Note: note, PreviousStatus: prev, RequestID: r.ID}
	doc := bson.D{{Key: "_id", Value: h.ID}, {Key: "actorId", Value: actor}, {Key: "hostelId", Value: r.HostelID}, {Key: "requestId", Value: r.ID}, {Key: "action", Value: action}}
	if costNote != "" {
		doc = append(doc, bson.E{Key: "costNote", Value: costNote})
	}
	if next != nil {
		doc = append(doc, bson.E{Key: "nextStatus", Value: *next})
	}
	if note != "" {
		doc = append(doc, bson.E{Key: "note", Value: note})
	}
	if prev != nil {
		doc = append(doc, bson.E{Key: "previousStatus", Value: *prev})
	}
	doc = append(doc, bson.E{Key: "createdAt", Value: at}, bson.E{Key: "updatedAt", Value: at}, bson.E{Key: "__v", Value: 0})
	if _, err := s.DB.Collection("maintenancehistories").InsertOne(ctx, doc); err != nil {
		return nil, err
	}
	return h, nil
}

func (s *Service) find(ctx context.Context, rawID string, p *authz.Principal, hostel string) (*request, error) {
	id, err := httpx.OID(rawID, "maintenance request id")
	if err != nil {
		return nil, err
	}
	scope, err := opsscope.Filter(p, hostel)
	if err != nil {
		return nil, err
	}
	var r request
	err = s.DB.Collection("maintenancerequests").FindOne(ctx, append(bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}}, scope...)).Decode(&r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, errNotFound()
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *Service) approvedProvider(ctx context.Context, raw string) (*bson.ObjectID, error) {
	if raw == "" {
		return nil, nil
	}
	id, err := httpx.OID(raw, "service provider id")
	if err != nil {
		return nil, err
	}
	err = s.DB.Collection("serviceproviders").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "APPROVED"}}, options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Err()
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, httpx.NewError(http.StatusNotFound, "SERVICE_PROVIDER_NOT_FOUND", "Approved service provider was not found.", nil)
	}
	if err != nil {
		return nil, err
	}
	return &id, nil
}

func (s *Service) usableVoiceNote(ctx context.Context, raw string, hostel bson.ObjectID) (*bson.ObjectID, error) {
	if raw == "" {
		return nil, nil
	}
	id, err := httpx.OID(raw, "voice note id")
	if err != nil {
		return nil, err
	}
	var a struct {
		HostelID  *bson.ObjectID `bson:"hostelId"`
		Kind      string         `bson:"kind"`
		MimeType  string         `bson:"mimeType"`
		Completed *time.Time     `bson:"uploadCompletedAt"`
	}
	err = s.DB.Collection("fileassets").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}}).Decode(&a)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	if err != nil || a.Completed == nil {
		return nil, httpx.NewError(http.StatusUnprocessableEntity, "VOICE_NOTE_NOT_READY", "That voice note did not finish uploading. Record it again.", nil)
	}
	if a.HostelID == nil || *a.HostelID != hostel {
		return nil, httpx.NewError(http.StatusNotFound, "VOICE_NOTE_NOT_FOUND", "That voice note does not belong to this hostel.", nil)
	}
	if a.Kind != "MAINTENANCE_NOTE" || !strings.HasPrefix(a.MimeType, "audio/") {
		return nil, httpx.NewError(http.StatusUnprocessableEntity, "VOICE_NOTE_INVALID", "A voice note has to be an audio recording.", nil)
	}
	return &id, nil
}

func (s *Service) minimumCharge(ctx context.Context, category string) float64 {
	if v, ok := s.Config.OperationsTyped(ctx).MaintenanceMinimumCharges[category]; ok {
		return float64(v)
	}
	return defaultMinimumCharge
}

// optionalDate is `z.coerce.date().optional()`.
func optionalDate(f *valid.Form, key string) *time.Time {
	raw, ok := f.M[key]
	if !ok {
		return nil
	}
	t, good := valid.CoerceDate(raw)
	if !good {
		f.Is.Add(key, valid.Type("date", "Date"))
		return nil
	}
	u := t.UTC()
	return &u
}

func optionalID(f *valid.Form, key string) string {
	raw, ok := f.M[key]
	if !ok {
		return ""
	}
	v, _ := valid.ObjectID(raw, key, "", &f.Is, false)
	return v
}

func (s *Service) create(c *gin.Context) {
	p, err := s.Guards.RequireHostelCapability(c, "manageMaintenance")
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
	medium := "MEDIUM"
	hostel := opsscope.BodyHostel(f)
	category, _ := f.Enum("category", false, nil, categories...)
	costNote, _ := f.Str("costNote", valid.S{Opt: true, Trim: true, Max: 500})
	description, _ := f.Str("description", valid.S{Opt: true, Trim: true, Max: 1600})
	location, _ := f.Str("location", valid.S{Opt: true, Trim: true, Max: 160})
	priority, _ := f.Enum("priority", false, &medium, "LOW", "MEDIUM", "HIGH", "URGENT")
	providerRaw := optionalID(f, "providerId")
	remarks, _ := f.Str("remarks", valid.S{Opt: true, Trim: true, Max: 800})
	scheduled := optionalDate(f, "scheduledFor")
	title, _ := f.Str("title", valid.S{Trim: true, Min: 2, Max: 180})
	voiceRaw := optionalID(f, "voiceNoteAssetId")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelID, err := opsscope.HostelID(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	provider, err := s.approvedProvider(c, providerRaw)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	voice, err := s.usableVoiceNote(c, voiceRaw, hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	at := now()
	charge := s.minimumCharge(c, category)
	row := request{ID: bson.NewObjectID(), Category: category, CostNote: costNote, CreatedAt: &at, Description: description, HostelID: hostelID, Location: location, MinimumCharge: &charge, Priority: priority,
		ProviderID: provider, Remarks: remarks, RequestedBy: uid, ScheduledFor: scheduled, Status: "PENDING", Title: title, UpdatedAt: &at, VoiceNote: voice}
	doc := bson.D{{Key: "_id", Value: row.ID}, {Key: "category", Value: category}, {Key: "minimumCharge", Value: int32(charge)}, {Key: "createdBy", Value: uid}, {Key: "hostelId", Value: hostelID}, {Key: "priority", Value: priority},
		{Key: "requestedBy", Value: uid}, {Key: "status", Value: "PENDING"}, {Key: "title", Value: title}, {Key: "updatedBy", Value: uid}, {Key: "isDeleted", Value: false}}
	for _, kv := range []bson.E{{Key: "costNote", Value: costNote}, {Key: "description", Value: description}, {Key: "location", Value: location}, {Key: "remarks", Value: remarks}} {
		if kv.Value != "" {
			doc = append(doc, kv)
		}
	}
	if provider != nil {
		doc = append(doc, bson.E{Key: "providerId", Value: *provider})
	}
	if scheduled != nil {
		doc = append(doc, bson.E{Key: "scheduledFor", Value: *scheduled})
	}
	if voice != nil {
		doc = append(doc, bson.E{Key: "voiceNoteAssetId", Value: *voice})
	}
	doc = append(doc, bson.E{Key: "createdAt", Value: at}, bson.E{Key: "updatedAt", Value: at}, bson.E{Key: "__v", Value: 0})
	if _, err := s.DB.Collection("maintenancerequests").InsertOne(c, doc); err != nil {
		httpx.Fail(c, err)
		return
	}
	pending := "PENDING"
	h, err := s.addHistory(c, &row, uid, "MAINTENANCE_REQUEST_CREATED", "", &pending, nil, "Maintenance request created.")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	meta := bson.D{{Key: "category", Value: category}}
	if provider != nil {
		meta = append(meta, bson.E{Key: "providerId", Value: provider.Hex()})
	}
	meta = append(meta, bson.E{Key: "voiceNote", Value: voice != nil})
	if err := s.auditAndPublish(c, uid, &row, "MAINTENANCE_REQUEST_CREATED", meta); err != nil {
		httpx.Fail(c, err)
		return
	}
	s.notifyStaffOfNew(c, &row, p.UserID)
	httpx.Write(c, 201, ordered.Map{{Key: "request", Value: serialize(&row, nil, []history{*h})}}, "Maintenance request created")
}

type summaryOut struct {
	Cancelled int `json:"cancelled"`
	Completed int `json:"completed"`
	Open      int `json:"open"`
	Total     int `json:"total"`
}

type listOut struct {
	Requests []ordered.Map `json:"requests"`
	Summary  summaryOut    `json:"summary"`
}

func (s *Service) list(c *gin.Context) {
	p, err := s.Guards.RequireHostelCapability(c, "manageMaintenance")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	hostel := opsscope.Hostel(q, &is)
	category := valid.QueryEnum(q, "category", &is, categories...)
	var provider string
	if raw, ok := q["providerId"]; ok {
		provider, _ = valid.ObjectID(raw, "providerId", "", &is, false)
	}
	status := valid.QueryEnum(q, "status", &is, statuses...)
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	scope, err := opsscope.Filter(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	key := "maintenance"
	if raw := c.Request.URL.RawQuery; raw != "" {
		key += "?" + raw
	}
	cache.Respond(c, s.Cache, p.HostelIDs, p.UserID, key, "Maintenance requests loaded", func() (listOut, error) {
		filter := append(bson.D{{Key: "isDeleted", Value: false}}, scope...)
		if category != nil {
			filter = append(filter, bson.E{Key: "category", Value: *category})
		}
		if provider != "" {
			id, err := httpx.OID(provider, "service provider id")
			if err != nil {
				return listOut{}, err
			}
			filter = append(filter, bson.E{Key: "providerId", Value: id})
		}
		if status != nil {
			filter = append(filter, bson.E{Key: "status", Value: *status})
		}
		cur, err := s.DB.Collection("maintenancerequests").Find(c, filter, options.Find().SetSort(bson.D{{Key: "status", Value: 1}, {Key: "createdAt", Value: -1}}).SetLimit(150))
		if err != nil {
			return listOut{}, err
		}
		var rows []request
		if err := cur.All(c, &rows); err != nil {
			return listOut{}, err
		}
		ids := make(bson.A, len(rows))
		for i := range rows {
			ids[i] = rows[i].ID
		}
		comments, hist := map[bson.ObjectID][]comment{}, map[bson.ObjectID][]history{}
		if len(rows) > 0 {
			match := bson.D{{Key: "requestId", Value: bson.D{{Key: "$in", Value: ids}}}}
			newest := options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}})
			cc, err := s.DB.Collection("maintenancecomments").Find(c, match, newest)
			if err != nil {
				return listOut{}, err
			}
			var cs []comment
			if err := cc.All(c, &cs); err != nil {
				return listOut{}, err
			}
			for _, x := range cs {
				comments[x.RequestID] = append(comments[x.RequestID], x)
			}
			hc, err := s.DB.Collection("maintenancehistories").Find(c, match, newest)
			if err != nil {
				return listOut{}, err
			}
			var hs []history
			if err := hc.All(c, &hs); err != nil {
				return listOut{}, err
			}
			for _, x := range hs {
				hist[x.RequestID] = append(hist[x.RequestID], x)
			}
		}
		out := listOut{Requests: make([]ordered.Map, len(rows))}
		out.Summary.Total = len(rows)
		for i := range rows {
			out.Requests[i] = serialize(&rows[i], comments[rows[i].ID], hist[rows[i].ID])
			switch rows[i].Status {
			case "CANCELLED":
				out.Summary.Cancelled++
			case "COMPLETED":
				out.Summary.Completed++
			default:
				out.Summary.Open++
			}
		}
		return out, nil
	})
}

func (s *Service) status(c *gin.Context) {
	p, err := s.Guards.RequireHostelCapability(c, "manageMaintenance")
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
	hostel := opsscope.BodyHostel(f)
	costNote, _ := f.Str("costNote", valid.S{Opt: true, Trim: true, Max: 500})
	note, _ := f.Str("note", valid.S{Opt: true, Trim: true, Max: 800})
	scheduled := optionalDate(f, "scheduledFor")
	status, _ := f.Enum("status", false, nil, statuses...)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := s.find(c, c.Param("id"), p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	at := now()
	set := bson.D{{Key: "status", Value: status}, {Key: "updatedBy", Value: uid}, {Key: "updatedAt", Value: at}}
	if costNote != "" {
		set = append(set, bson.E{Key: "costNote", Value: costNote})
	}
	if scheduled != nil {
		set = append(set, bson.E{Key: "scheduledFor", Value: *scheduled})
	}
	update := bson.D{{Key: "$set", Value: set}}
	if status == "COMPLETED" {
		update = bson.D{{Key: "$set", Value: append(set, bson.E{Key: "completedAt", Value: at})}}
	} else {
		update = append(update, bson.E{Key: "$unset", Value: bson.D{{Key: "completedAt", Value: ""}}})
	}
	var updated request
	err = s.DB.Collection("maintenancerequests").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: r.ID}, {Key: "isDeleted", Value: false}}, update, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&updated)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, errNotFound())
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	previous := r.Status
	h, err := s.addHistory(c, &updated, uid, "MAINTENANCE_STATUS_UPDATED", costNote, &updated.Status, &previous, note)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := s.auditAndPublish(c, uid, &updated, "MAINTENANCE_STATUS_UPDATED", bson.D{{Key: "nextStatus", Value: updated.Status}, {Key: "previousStatus", Value: previous}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	s.notifyProviderOfStatus(c, &updated, previous)
	s.notifyStaffOfProgress(c, &updated, previous, p.UserID)
	httpx.Write(c, 200, ordered.Map{{Key: "request", Value: serialize(&updated, nil, []history{*h})}}, "Maintenance status updated")
}

func (s *Service) assign(c *gin.Context) {
	p, err := s.Guards.RequireHostelStaff(c)
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
	hostel := opsscope.BodyHostel(f)
	raw, _ := valid.ObjectID(f.M["providerId"], "providerId", "", &f.Is, !f.Present("providerId"))
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := s.find(c, c.Param("id"), p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	taken := httpx.NewError(http.StatusConflict, "MAINTENANCE_ALREADY_ASSIGNED", "This request already has somebody assigned. Cancel it and raise a new one to change who is coming.", nil)
	if r.ProviderID != nil {
		httpx.Fail(c, taken)
		return
	}
	if r.Status == "CANCELLED" || r.Status == "COMPLETED" {
		httpx.Fail(c, httpx.NewError(http.StatusConflict, "MAINTENANCE_REQUEST_CLOSED", "This request is closed, so nobody can be assigned to it.", nil))
		return
	}
	provider, err := s.approvedProvider(c, raw)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var updated request
	err = s.DB.Collection("maintenancerequests").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: r.ID}, {Key: "isDeleted", Value: false}, {Key: "providerId", Value: bson.D{{Key: "$exists", Value: false}}}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "providerId", Value: *provider}, {Key: "updatedBy", Value: uid}, {Key: "updatedAt", Value: now()}}}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&updated)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, httpx.NewError(http.StatusConflict, "MAINTENANCE_ALREADY_ASSIGNED", "This request already has somebody assigned.", nil))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h, err := s.addHistory(c, &updated, uid, "MAINTENANCE_PROVIDER_ASSIGNED", "", nil, nil, "Assigned to a service provider.")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := s.auditAndPublish(c, uid, &updated, "MAINTENANCE_PROVIDER_ASSIGNED", bson.D{{Key: "providerId", Value: provider.Hex()}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	s.notifyProviderOfAssignment(c, &updated)
	httpx.Write(c, 200, ordered.Map{{Key: "request", Value: serialize(&updated, nil, []history{*h})}}, "Provider assigned")
}

func (s *Service) comment(c *gin.Context) {
	p, err := s.Guards.RequireHostelCapability(c, "manageMaintenance")
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
	internal := "INTERNAL"
	hostel := opsscope.BodyHostel(f)
	message, _ := f.Str("message", valid.S{Trim: true, Min: 1, Max: 1000})
	visibility, _ := f.Enum("visibility", false, &internal, "INTERNAL", "PROVIDER_NOTE")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := s.find(c, c.Param("id"), p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	at := now()
	row := comment{ID: bson.NewObjectID(), AuthorID: uid, CreatedAt: &at, HostelID: r.HostelID, Message: message, RequestID: r.ID, Visibility: visibility}
	if _, err := s.DB.Collection("maintenancecomments").InsertOne(c, bson.D{{Key: "_id", Value: row.ID}, {Key: "authorId", Value: uid}, {Key: "hostelId", Value: r.HostelID}, {Key: "message", Value: message}, {Key: "requestId", Value: r.ID},
		{Key: "visibility", Value: visibility}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if _, err := s.addHistory(c, r, uid, "MAINTENANCE_COMMENT_ADDED", "", nil, nil, message); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := s.auditAndPublish(c, uid, r, "MAINTENANCE_COMMENT_ADDED", nil); err != nil {
		httpx.Fail(c, err)
		return
	}
	if visibility != "INTERNAL" {
		s.notifyProviderOfNote(c, r, message)
	}
	httpx.Write(c, 201, ordered.Map{{Key: "comment", Value: serializeComment(&row)}, {Key: "request", Value: serialize(r, nil, nil)}}, "Maintenance comment added")
}

type chargeOut struct {
	Amount   float64 `json:"amount"`
	Category string  `json:"category"`
}

type settingsOut struct {
	HostelID       string      `json:"hostelId"`
	MinimumCharges []chargeOut `json:"minimumCharges"`
}

func (s *Service) settings(c *gin.Context) {
	p, err := s.Guards.RequireHostelStaff(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	hostelID, err := opsscope.HostelID(p, q["hostelId"])
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := settingsOut{HostelID: hostelID.Hex(), MinimumCharges: make([]chargeOut, len(categories))}
	configured := s.Config.OperationsTyped(c).MaintenanceMinimumCharges
	for i, cat := range categories {
		amount := float64(defaultMinimumCharge)
		if v, ok := configured[cat]; ok {
			amount = float64(v)
		}
		out.MinimumCharges[i] = chargeOut{amount, cat}
	}
	httpx.Write(c, 200, out, "Maintenance settings loaded")
}

// The notifications below are best effort, as in maintenance-notify.ts: the row is
// saved and the queue holds it either way.

var statusWords = map[string]string{"CANCELLED": "cancelled", "COMPLETED": "completed", "CONTACTED": "picked up", "PENDING": "reopened", "SCHEDULED": "scheduled"}

func readable(category string) string { return strings.ReplaceAll(strings.ToLower(category), "_", " ") }

func where(r *request) string {
	if r.Location == "" {
		return ""
	}
	return " at " + r.Location
}

func notifyPriority(r *request) string {
	if r.Priority == "URGENT" || r.Priority == "HIGH" {
		return r.Priority
	}
	return "NORMAL"
}

func jobPriority(r *request) string {
	if r.Priority == "URGENT" {
		return "URGENT"
	}
	return "HIGH"
}

func word(status string) string {
	if w, ok := statusWords[status]; ok {
		return w
	}
	return strings.ToLower(status)
}

func (s *Service) providerUser(ctx context.Context, id bson.ObjectID) string {
	var x struct {
		Status string         `bson:"status"`
		UserID *bson.ObjectID `bson:"userId"`
	}
	if err := s.DB.Collection("serviceproviders").FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&x); err != nil || x.UserID == nil || x.Status != "APPROVED" {
		return ""
	}
	return x.UserID.Hex()
}

func (s *Service) notifyProviderOfAssignment(ctx context.Context, r *request) {
	if r.ProviderID == nil {
		return
	}
	user := s.providerUser(ctx, *r.ProviderID)
	if user == "" {
		return
	}
	name, err := residents.HostelName(ctx, s.DB, r.HostelID)
	if err != nil {
		return
	}
	_, _ = s.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/jobs", Body: name + " has sent you a " + readable(r.Category) + " job: " + r.Title + where(r) + ".", Category: "MAINTENANCE",
		Data: ordered.Map{{Key: "maintenanceRequestId", Value: r.ID.Hex()}, {Key: "priority", Value: r.Priority}}, HostelID: r.HostelID.Hex(), Priority: jobPriority(r), Title: "New job for you", UserID: user})
}

func (s *Service) notifyProvidersOfOpen(ctx context.Context, r *request) {
	roles := serviceproviders.RolesFor(r.Category)
	cur, err := s.DB.Collection("serviceproviders").Find(ctx, bson.D{{Key: "$or", Value: bson.A{bson.D{{Key: "categories", Value: bson.D{{Key: "$in", Value: roles}}}}, bson.D{{Key: "category", Value: bson.D{{Key: "$in", Value: roles}}}}}},
		{Key: "isDeleted", Value: false}, {Key: "status", Value: "APPROVED"}, {Key: "userId", Value: bson.D{{Key: "$exists", Value: true}}}}, options.Find().SetProjection(bson.D{{Key: "userId", Value: 1}}))
	if err != nil {
		return
	}
	var rows []struct {
		UserID bson.ObjectID `bson:"userId"`
	}
	if cur.All(ctx, &rows) != nil || len(rows) == 0 {
		return
	}
	name, err := residents.HostelName(ctx, s.DB, r.HostelID)
	if err != nil {
		return
	}
	fee := ""
	if r.MinimumCharge != nil {
		fee = " Minimum fee NPR " + thousands(int64(*r.MinimumCharge)) + "."
	}
	seen := map[bson.ObjectID]bool{}
	for _, x := range rows {
		if seen[x.UserID] {
			continue
		}
		seen[x.UserID] = true
		_, _ = s.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/jobs", Body: name + ": " + r.Title + where(r) + "." + fee + " Open the app to accept it.", Category: "MAINTENANCE",
			Data: ordered.Map{{Key: "maintenanceRequestId", Value: r.ID.Hex()}, {Key: "priority", Value: r.Priority}}, HostelID: r.HostelID.Hex(), Priority: jobPriority(r), Title: "New " + readable(r.Category) + " job", UserID: x.UserID.Hex()})
	}
}

func thousands(n int64) string {
	s := strconv.FormatInt(n, 10)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

func (s *Service) notifyStaffOfNew(ctx context.Context, r *request, actor string) {
	staff, err := residents.HostelStaffUserIDs(ctx, s.DB, r.HostelID, false)
	name, nameErr := residents.HostelName(ctx, s.DB, r.HostelID)
	if err == nil && nameErr == nil {
		for _, u := range staff {
			if u == actor {
				continue
			}
			_, _ = s.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/hostel-admin/maintenance", Body: r.Title + where(r) + " — " + readable(r.Category) + ", " + strings.ToLower(r.Priority) + " priority.", Category: "MAINTENANCE",
				Data: ordered.Map{{Key: "maintenanceRequestId", Value: r.ID.Hex()}}, HostelID: r.HostelID.Hex(), Priority: notifyPriority(r), Title: "Maintenance raised at " + name, UserID: u})
		}
	}
	if r.ProviderID != nil {
		s.notifyProviderOfAssignment(ctx, r)
	} else {
		s.notifyProvidersOfOpen(ctx, r)
	}
}

func (s *Service) notifyStaffOfProgress(ctx context.Context, r *request, previous, actor string) {
	if previous == r.Status {
		return
	}
	staff, err := residents.HostelStaffUserIDs(ctx, s.DB, r.HostelID, false)
	if err != nil {
		return
	}
	priority := notifyPriority(r)
	if r.Status == "COMPLETED" {
		priority = "NORMAL"
	}
	w := word(r.Status)
	for _, u := range staff {
		if u == actor {
			continue
		}
		_, _ = s.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/hostel-admin/maintenance", Body: `The hostel ` + w + ` "` + r.Title + `"` + where(r) + ".", Category: "MAINTENANCE",
			Data: ordered.Map{{Key: "maintenanceRequestId", Value: r.ID.Hex()}, {Key: "status", Value: r.Status}}, HostelID: r.HostelID.Hex(), Priority: priority, Title: "Maintenance " + w, UserID: u})
	}
}

func (s *Service) notifyProviderOfStatus(ctx context.Context, r *request, previous string) {
	if r.ProviderID == nil || previous == r.Status {
		return
	}
	user := s.providerUser(ctx, *r.ProviderID)
	if user == "" {
		return
	}
	name, err := residents.HostelName(ctx, s.DB, r.HostelID)
	if err != nil {
		return
	}
	w := word(r.Status)
	title, priority := "Job "+w, "NORMAL"
	if r.Status == "CANCELLED" {
		title, priority = "Job cancelled", "HIGH"
	}
	_, _ = s.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/jobs", Body: name + " " + w + ` "` + r.Title + `"` + where(r) + ".", Category: "MAINTENANCE",
		Data: ordered.Map{{Key: "maintenanceRequestId", Value: r.ID.Hex()}, {Key: "status", Value: r.Status}}, HostelID: r.HostelID.Hex(), Priority: priority, Title: title, UserID: user})
}

func (s *Service) notifyProviderOfNote(ctx context.Context, r *request, body string) {
	if r.ProviderID == nil {
		return
	}
	user := s.providerUser(ctx, *r.ProviderID)
	if user == "" {
		return
	}
	name, err := residents.HostelName(ctx, s.DB, r.HostelID)
	if err != nil {
		return
	}
	if runes := []rune(body); len(runes) > 140 {
		body = string(runes[:137]) + "…"
	}
	_, _ = s.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/jobs", Body: body, Category: "MAINTENANCE", Data: ordered.Map{{Key: "maintenanceRequestId", Value: r.ID.Hex()}}, HostelID: r.HostelID.Hex(), Title: name + ` on "` + r.Title + `"`, UserID: user})
}
