package notices

import (
	"context"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Admin is the staff side of modules/notices/notice.service.ts: publishing,
// listing and editing the board, and the fan-out a published notice starts.
type Admin struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Cache  *cache.Cache
	Notify *notifications.Service
	Mail   *email.Sender
	Audit  *audit.Log
	Config *platformconfig.Service
	RT     *realtime.Client
	AppURL func(path string) string
}

func (a *Admin) Register(v1 *gin.RouterGroup) {
	v1.GET("/hostel-admin/notices", a.list)
	v1.POST("/hostel-admin/notices", a.create)
	v1.PATCH("/hostel-admin/notices/:id", a.update)
}

var categories = []string{"GENERAL", "URGENT", "EVENT", "RULE", "MAINTENANCE", "PAYMENT", "FOOD"}

func notFound() error {
	return httpx.NewError(http.StatusNotFound, "NOTICE_NOT_FOUND", "Notice was not found.", nil)
}

func (a *Admin) list(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "manageNotices")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	page := opsscope.ReadPage(q, &is)
	category := valid.QueryEnum(q, "category", &is, categories...)
	requested := opsscope.Hostel(q, &is)
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	filter, err := opsscope.Filter(p, requested)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if category != nil {
		filter = append(filter, bson.E{Key: "category", Value: *category})
	}
	key := "notices"
	if c.Request.URL.RawQuery != "" {
		key += "?" + c.Request.URL.RawQuery
	}
	cache.Respond(c, a.Cache, p.HostelIDs, p.UserID, key, "Notices loaded", func() (adminListOut, error) {
		rng := pagination.RangeOf(page)
		coll := a.DB.Collection("notices")
		cur, err := coll.Find(c, filter, options.Find().SetSort(bson.D{{Key: "isUrgent", Value: -1}, {Key: "publishedAt", Value: -1}}).SetSkip(int64(rng.Skip)).SetLimit(int64(rng.Limit)))
		if err != nil {
			return adminListOut{}, err
		}
		var rows []Row
		if err := cur.All(c, &rows); err != nil {
			return adminListOut{}, err
		}
		total, err := coll.CountDocuments(c, filter)
		if err != nil {
			return adminListOut{}, err
		}
		out := adminListOut{Notices: make([]ordered.Map, len(rows)), Pagination: pagination.MetaOf(page, int(total))}
		for i := range rows {
			out.Notices[i] = serialize(&rows[i], nil)
		}
		return out, nil
	})
}

type adminListOut struct {
	Notices    []ordered.Map   `json:"notices"`
	Pagination pagination.Meta `json:"pagination"`
}

type createIn struct {
	Category       string
	Content        string
	ExpiresAt      *time.Time
	HostelID       string
	IsUrgent       bool
	PublishedAt    *time.Time
	TargetAudience string
	Title          string
}

// parseNotice is noticeCreateSchema, or noticeUpdateSchema when update: every
// field optional and no default, so only what was sent comes back in set.
func parseNotice(body any, update bool) (createIn, map[string]bool, error) {
	f := valid.NewForm(body)
	var in createIn
	set := map[string]bool{}
	if raw, present := f.M["hostelId"]; present {
		in.HostelID, _ = valid.ObjectID(raw, "hostelId", "", &f.Is, false)
	}
	if v, ok := f.Str("title", valid.S{Opt: update, Trim: true, Min: 2, Max: 160}); ok {
		in.Title, set["title"] = v, true
	}
	if v, ok := f.Str("content", valid.S{Opt: update, Trim: true, Min: 2, Max: 4000}); ok {
		in.Content, set["content"] = v, true
	}
	var cat, aud *string
	var urgent *bool
	if !update {
		c, a, u := "GENERAL", "ALL", false
		cat, aud, urgent = &c, &a, &u
	}
	if v, ok := f.Enum("category", update, cat, categories...); ok {
		in.Category, set["category"] = v, true
	}
	if v, ok := f.Bool("isUrgent", update, urgent); ok {
		in.IsUrgent, set["isUrgent"] = v, true
	}
	if v, ok := f.Enum("targetAudience", update, aud, "ALL", "RESIDENTS", "GUARDIANS"); ok {
		in.TargetAudience, set["targetAudience"] = v, true
	}
	if t, ok := opsscope.OptDate(f, "publishedAt"); ok {
		in.PublishedAt, set["publishedAt"] = t, true
	}
	if t, ok := opsscope.OptDate(f, "expiresAt"); ok {
		in.ExpiresAt, set["expiresAt"] = t, true
	}
	return in, set, f.Err()
}

// createOut is {delivery, notice}.
type createOut struct {
	Delivery Delivery    `json:"delivery"`
	Notice   ordered.Map `json:"notice"`
}

// Delivery is what a broadcast reached.
type Delivery struct {
	Emailed  int `json:"emailed"`
	Notified int `json:"notified"`
}

func (a *Admin) create(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "manageNotices")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, _, err := parseNotice(body, false)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelID, err := opsscope.HostelID(p, in.HostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	row := Row{ID: bson.NewObjectID(), Category: in.Category, Content: in.Content, CreatedAt: &now, ExpiresAt: in.ExpiresAt, HostelID: hostelID, IsUrgent: in.IsUrgent,
		PublishedAt: &now, TargetAudience: in.TargetAudience, Title: in.Title, UpdatedAt: &now}
	if in.PublishedAt != nil {
		row.PublishedAt = in.PublishedAt
	}
	if err := a.insert(c, &row, uid); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "NOTICE_CREATED", ActorID: uid, EntityID: row.ID.Hex(), EntityType: "Notice", HostelID: hostelID, Metadata: bson.D{}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	delivery := a.Broadcast(c.Request.Context(), &row, Options{Email: true})
	httpx.Write(c, http.StatusCreated, createOut{delivery, serialize(&row, nil)}, "Notice created")
}

// insert writes a notice in the schema's field order, with Mongoose's timestamps and __v.
func (a *Admin) insert(ctx context.Context, row *Row, by bson.ObjectID) error {
	doc := bson.D{{Key: "_id", Value: row.ID}, {Key: "hostelId", Value: row.HostelID}, {Key: "title", Value: row.Title}, {Key: "content", Value: row.Content},
		{Key: "category", Value: row.Category}, {Key: "isUrgent", Value: row.IsUrgent}, {Key: "targetAudience", Value: row.TargetAudience}, {Key: "publishedAt", Value: *row.PublishedAt}}
	if row.ExpiresAt != nil {
		doc = append(doc, bson.E{Key: "expiresAt", Value: *row.ExpiresAt})
	}
	doc = append(doc, bson.E{Key: "createdBy", Value: by}, bson.E{Key: "updatedBy", Value: by}, bson.E{Key: "createdAt", Value: *row.CreatedAt}, bson.E{Key: "updatedAt", Value: *row.UpdatedAt}, bson.E{Key: "__v", Value: 0})
	_, err := a.DB.Collection("notices").InsertOne(ctx, doc)
	return err
}

// Publish is publishPushNotice: a residents' notice carrying a push notice's own
// words, no email.
func (a *Admin) Publish(ctx context.Context, actor, hostelID bson.ObjectID, title, body string, urgent bool, expiresAt *time.Time) (bson.ObjectID, Delivery, error) {
	now := time.Now().UTC().Truncate(time.Millisecond)
	row := Row{ID: bson.NewObjectID(), Category: "GENERAL", Content: body, CreatedAt: &now, ExpiresAt: expiresAt, HostelID: hostelID, IsUrgent: urgent, PublishedAt: &now,
		TargetAudience: "RESIDENTS", Title: title, UpdatedAt: &now}
	if err := a.insert(ctx, &row, actor); err != nil {
		return bson.ObjectID{}, Delivery{}, err
	}
	d := a.Broadcast(ctx, &row, Options{Headline: &Headline{Title: title, Body: body}})
	return row.ID, d, nil
}

// Options is BroadcastOptions; mail goes only when Email is set.
type Options struct {
	Email    bool
	Headline *Headline
}

// Headline is what the bell row and push say instead of "New notice".
type Headline struct{ Title, Body string }

// Broadcast is broadcastNotice: a bell row for every reachable active resident,
// plus mail for an urgent notice when the platform has notice emails on. A
// delivery problem never fails the publish.
func (a *Admin) Broadcast(ctx context.Context, n *Row, o Options) Delivery {
	d, err := a.deliver(ctx, n, o)
	if err != nil {
		slog.WarnContext(ctx, "notice_broadcast_failed", "noticeId", n.ID.Hex(), "error", err)
		return Delivery{}
	}
	return d
}

func (a *Admin) deliver(ctx context.Context, n *Row, o Options) (Delivery, error) {
	if n.TargetAudience == "GUARDIANS" {
		return Delivery{}, nil
	}
	sendMail := o.Email && n.IsUrgent && a.Config.OperationsTyped(ctx).SendNoticeEmails
	hostelName := "your hostel"
	var h struct {
		Name string `bson:"name"`
	}
	if err := a.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: n.HostelID}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}})).Decode(&h); err == nil && h.Name != "" {
		hostelName = h.Name
	}
	recipients, err := opsscope.ActiveResidents(ctx, a.DB, n.HostelID)
	if err != nil {
		return Delivery{}, err
	}
	mail := email.ResidentNewNotice(n.Content, n.Category, hostelName, n.IsUrgent, a.AppURL("/resident/notices"), n.Title)
	title, text, priority := "New notice", n.Title, "NORMAL"
	if n.IsUrgent {
		title, priority = "Urgent notice", "URGENT"
	}
	if o.Headline != nil {
		title, text = o.Headline.Title, o.Headline.Body
	}
	var emailed atomic.Int64
	opsscope.Each(len(recipients), 16, func(i int) {
		r := recipients[i]
		if r.UserID != "" {
			// A notice is an announcement, not a request: NORMAL even when urgent. Urgency rides on priority.
			_, _ = a.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/resident/notices", Body: text, Category: "NOTICE", Data: ordered.Map{{Key: "noticeId", Value: n.ID.Hex()}},
				HostelID: n.HostelID.Hex(), Kind: "NORMAL", Priority: priority, Title: title, UserID: r.UserID})
		}
		if sendMail && a.Mail.Notify(ctx, email.Notification{Action: "resident_new_notice", HTML: mail.HTML, Subject: mail.Subject, To: r.Email, Category: mail.Category, Topic: "NOTICES"}) {
			emailed.Add(1)
		}
	})
	realtime.PublishResourceChange(ctx, a.RT, a.Cache, realtime.Change{HostelIDs: []string{n.HostelID.Hex()}, Topics: []realtime.Topic{realtime.Notices}})
	return Delivery{int(emailed.Load()), len(recipients)}, nil
}

func (a *Admin) update(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "manageNotices")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := opsscope.Param(c.Param("id"), "notice id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, set, err := parseNotice(body, true)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	scope, err := opsscope.Filter(p, in.HostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	coll := a.DB.Collection("notices")
	var existing Row
	err = coll.FindOne(c, append(bson.D{{Key: "_id", Value: id}}, scope...)).Decode(&existing)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, notFound())
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	// Only what was sent: a PATCH naming the title must leave category, urgency
	// and audience alone (ops-1).
	fields := bson.D{}
	add := func(k string, v any) {
		if set[k] {
			fields = append(fields, bson.E{Key: k, Value: v})
		}
	}
	add("title", in.Title)
	add("content", in.Content)
	add("category", in.Category)
	add("isUrgent", in.IsUrgent)
	add("targetAudience", in.TargetAudience)
	if set["publishedAt"] {
		fields = append(fields, bson.E{Key: "publishedAt", Value: *in.PublishedAt})
	}
	if set["expiresAt"] {
		fields = append(fields, bson.E{Key: "expiresAt", Value: *in.ExpiresAt})
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	fields = append(fields, bson.E{Key: "updatedBy", Value: uid}, bson.E{Key: "updatedAt", Value: now})
	var row Row
	err = coll.FindOneAndUpdate(c, bson.D{{Key: "_id", Value: existing.ID}}, bson.D{{Key: "$set", Value: fields}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&row)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, notFound())
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "NOTICE_UPDATED", ActorID: uid, EntityID: existing.ID.Hex(), EntityType: "Notice", HostelID: existing.HostelID, Metadata: bson.D{}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, struct {
		Notice ordered.Map `json:"notice"`
	}{serialize(&row, nil)}, "Notice updated")
}
