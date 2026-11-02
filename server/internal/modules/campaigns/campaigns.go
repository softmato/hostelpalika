// Package campaigns is modules/notifications/notification-campaign.service: a broadcast
// to a hostel's residents or guardians, sent now or kept for the cron.
package campaigns

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/push"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

type Service struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Audit  *audit.Log
	Push   *push.Sender
	RT     *realtime.Client
	Bump   realtime.Bumper
}

func (s *Service) Register(v1 *gin.RouterGroup) {
	v1.GET("/hostel-admin/notifications", httpx.ETag(), s.list)
	v1.POST("/hostel-admin/notifications", s.create)
}

type record struct {
	ID            bson.ObjectID   `bson:"_id"`
	Audience      string          `bson:"audience"`
	Body          string          `bson:"body"`
	Category      string          `bson:"category"`
	CreatedAt     *time.Time      `bson:"createdAt"`
	FailureReason string          `bson:"failureReason"`
	HostelID      *bson.ObjectID  `bson:"hostelId"`
	Priority      string          `bson:"priority"`
	Recipients    int             `bson:"recipientCount"`
	ResidentIDs   []bson.ObjectID `bson:"residentIds"`
	ScheduledFor  *time.Time      `bson:"scheduledFor"`
	Scope         string          `bson:"scope"`
	SentAt        *time.Time      `bson:"sentAt"`
	Status        string          `bson:"status"`
	Title         string          `bson:"title"`
}

type stats struct {
	Delivered int `bson:"delivered" json:"delivered"`
	Read      int `bson:"read" json:"read"`
	Sent      int `bson:"sent" json:"sent"`
}

func serialize(r *record, st stats) ordered.Map {
	date := func(t *time.Time) any {
		if t == nil {
			return ordered.Undefined
		}
		return httpx.ISO(*t)
	}
	hostel := any(ordered.Undefined)
	if r.HostelID != nil {
		hostel = r.HostelID.Hex()
	}
	return ordered.Map{{Key: "audience", Value: r.Audience}, {Key: "body", Value: r.Body}, {Key: "category", Value: r.Category}, {Key: "createdAt", Value: date(r.CreatedAt)},
		{Key: "failureReason", Value: r.FailureReason}, {Key: "hostelId", Value: hostel}, {Key: "id", Value: r.ID.Hex()}, {Key: "priority", Value: r.Priority},
		{Key: "recipientCount", Value: r.Recipients}, {Key: "scheduledFor", Value: date(r.ScheduledFor)}, {Key: "scope", Value: r.Scope}, {Key: "sentAt", Value: date(r.SentAt)},
		{Key: "stats", Value: st}, {Key: "status", Value: r.Status}, {Key: "title", Value: r.Title}}
}

// recipients is resolveRecipients for a hostel campaign. Guardians are those whose
// GuardianAccess says they have a login, not every contact the hostel holds.
func (s *Service) recipients(ctx context.Context, r *record) ([]string, error) {
	filter := bson.D{{Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}, {Key: "userId", Value: bson.D{{Key: "$exists", Value: true}, {Key: "$ne", Value: nil}}}}
	if r.HostelID != nil {
		filter = append(filter, bson.E{Key: "hostelId", Value: *r.HostelID})
	}
	if r.Audience == "SPECIFIC" {
		filter = append(filter, bson.E{Key: "_id", Value: bson.D{{Key: "$in", Value: r.ResidentIDs}}})
	}
	cur, err := s.DB.Collection("residents").Find(ctx, filter, options.Find().SetProjection(bson.D{{Key: "userId", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID     bson.ObjectID `bson:"_id"`
		UserID bson.ObjectID `bson:"userId"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	seen, out := map[string]bool{}, []string{}
	add := func(id bson.ObjectID) {
		if h := id.Hex(); !seen[h] {
			seen[h] = true
			out = append(out, h)
		}
	}
	if r.Audience != "GUARDIANS" {
		for _, x := range rows {
			add(x.UserID)
		}
		return out, nil
	}
	ids := make(bson.A, len(rows))
	for i, x := range rows {
		ids[i] = x.ID
	}
	gc, err := s.DB.Collection("guardianaccesses").Find(ctx, bson.D{{Key: "residentId", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "status", Value: "ACTIVE"}}, options.Find().SetProjection(bson.D{{Key: "userId", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var access []struct {
		UserID *bson.ObjectID `bson:"userId"`
	}
	if err := gc.All(ctx, &access); err != nil {
		return nil, err
	}
	for _, a := range access {
		if a.UserID != nil {
			add(*a.UserID)
		}
	}
	return out, nil
}

// Dispatch is dispatchCampaign: one bell row per recipient, the socket once, the push once.
func (s *Service) Dispatch(ctx context.Context, r *record) error {
	ids, err := s.recipients(ctx, r)
	if err != nil {
		return err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if len(ids) > 0 {
		docs := make([]any, 0, len(ids))
		for _, id := range ids {
			uid, err := bson.ObjectIDFromHex(id)
			if err != nil {
				continue
			}
			docs = append(docs, bson.D{{Key: "body", Value: r.Body}, {Key: "campaignId", Value: r.ID}, {Key: "category", Value: r.Category}, {Key: "channel", Value: "IN_APP"},
				{Key: "data", Value: bson.D{{Key: "campaignId", Value: r.ID.Hex()}}}, {Key: "deliveredAt", Value: now}, {Key: "hostelId", Value: r.HostelID}, {Key: "isRead", Value: false}, {Key: "kind", Value: "NORMAL"},
				{Key: "priority", Value: r.Priority}, {Key: "status", Value: "SENT"}, {Key: "title", Value: r.Title}, {Key: "userId", Value: uid}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}})
		}
		if _, err := s.DB.Collection("notifications").InsertMany(ctx, docs, options.InsertMany().SetOrdered(false)); err != nil {
			return err
		}
	}
	if _, err := s.DB.Collection("notificationcampaigns").UpdateOne(ctx, bson.D{{Key: "_id", Value: r.ID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "recipientCount", Value: len(ids)}, {Key: "sentAt", Value: now}, {Key: "status", Value: "SENT"}, {Key: "updatedAt", Value: now}}}}); err != nil {
		return err
	}
	hostel := ""
	if r.HostelID != nil {
		hostel = r.HostelID.Hex()
		realtime.PublishResourceChange(ctx, s.RT, s.Bump, realtime.Change{HostelIDs: []string{hostel}, Topics: []realtime.Topic{realtime.Notifications}})
	}
	if len(ids) > 0 && s.Push != nil {
		s.Push.ToUsers(ctx, ids, push.Payload{Body: r.Body, Category: r.Category, Data: map[string]any{"campaignId": r.ID.Hex()}, HostelID: hostel, Priority: r.Priority, Title: r.Title})
	}
	return nil
}

func (s *Service) create(c *gin.Context) {
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
	all, announcement, normal := "ALL", "ANNOUNCEMENT", "NORMAL"
	text, _ := f.Str("body", valid.S{Trim: true, Min: 2, Max: 2000})
	category, hasCategory := f.Str("category", valid.S{Opt: true, Trim: true, Min: 2, Max: 60})
	if !hasCategory {
		category = announcement
	}
	priority, _ := f.Enum("priority", false, &normal, "LOW", "NORMAL", "HIGH", "URGENT")
	var scheduled *time.Time
	if raw, ok := f.M["scheduledFor"]; ok && raw != nil {
		if t, ok := valid.CoerceDate(raw); ok {
			u := t.UTC()
			scheduled = &u
		} else {
			f.Is.Add("scheduledFor", valid.Type("date", "Date"))
		}
	}
	title, _ := f.Str("title", valid.S{Trim: true, Min: 2, Max: 160})
	audience, _ := f.Enum("audience", false, &all, "ALL", "RESIDENTS", "GUARDIANS", "SPECIFIC")
	hostel := opsscope.BodyHostel(f)
	list, _ := f.Array("residentIds", false, true)
	f.Size("residentIds", len(list), 0, 500, "", false)
	residentIDs := make([]bson.ObjectID, 0, len(list))
	for i, v := range list {
		if h, ok := valid.ObjectID(v, "residentIds."+itoa(i), "", &f.Is, false); ok {
			id, _ := bson.ObjectIDFromHex(h)
			residentIDs = append(residentIDs, id)
		}
	}
	if audience == "SPECIFIC" && len(list) == 0 && len(f.Is) == 0 {
		f.Is.Add("residentIds", "Select at least one resident.")
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelID, err := resolveHostel(p, hostel)
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
	if scheduled != nil && scheduled.Before(now.Add(-time.Minute)) {
		httpx.Fail(c, httpx.NewError(http.StatusUnprocessableEntity, "NOTIFICATION_SCHEDULE_IN_PAST", "Pick a delivery time in the future.", nil))
		return
	}
	row := record{ID: bson.NewObjectID(), Audience: audience, Body: text, Category: category, CreatedAt: &now, HostelID: &hostelID, Priority: priority, ResidentIDs: residentIDs, ScheduledFor: scheduled, Scope: "HOSTEL", Status: "SCHEDULED", Title: title}
	doc := bson.D{{Key: "_id", Value: row.ID}, {Key: "audience", Value: audience}, {Key: "body", Value: text}, {Key: "category", Value: category}, {Key: "hostelId", Value: hostelID}, {Key: "priority", Value: priority},
		{Key: "residentIds", Value: residentIDs}, {Key: "scope", Value: "HOSTEL"}, {Key: "title", Value: title}, {Key: "createdBy", Value: uid}}
	if scheduled != nil {
		doc = append(doc, bson.E{Key: "scheduledFor", Value: *scheduled})
	}
	doc = append(doc, bson.E{Key: "status", Value: "SCHEDULED"}, bson.E{Key: "recipientCount", Value: 0}, bson.E{Key: "hostelIds", Value: bson.A{}}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := s.DB.Collection("notificationcampaigns").InsertOne(c, doc); err != nil {
		httpx.Fail(c, err)
		return
	}
	if scheduled == nil {
		if err := s.Dispatch(c, &row); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	var saved record
	if err := s.DB.Collection("notificationcampaigns").FindOne(c, bson.D{{Key: "_id", Value: row.ID}}).Decode(&saved); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := s.Audit.Write(c, audit.Entry{Action: "NOTIFICATION_CAMPAIGN_CREATED", ActorID: uid, EntityID: row.ID.Hex(), EntityType: "NotificationCampaign", HostelID: hostelID,
		Metadata: bson.D{{Key: "audience", Value: audience}, {Key: "recipientCount", Value: saved.Recipients}, {Key: "scheduled", Value: scheduled != nil}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, 201, ordered.Map{{Key: "campaign", Value: serialize(&saved, stats{})}}, "Notification campaign created")
}

// resolveHostel is this service's own resolveHostelId: its 422 words differ from the shared one.
func resolveHostel(p *authz.Principal, requested string) (bson.ObjectID, error) {
	if requested == "" && len(p.HostelIDs) != 1 {
		return bson.ObjectID{}, httpx.NewError(http.StatusUnprocessableEntity, "HOSTEL_SCOPE_REQUIRED", "A hostelId is required for this action.", nil)
	}
	return opsscope.HostelID(p, requested)
}

type listOut struct {
	Campaigns  []ordered.Map   `json:"campaigns"`
	Pagination pagination.Meta `json:"pagination"`
}

func (s *Service) list(c *gin.Context) {
	p, err := s.Guards.RequireHostelStaff(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	page := opsscope.ReadPage(q, &is)
	hostel := opsscope.Hostel(q, &is)
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	filter, err := opsscope.Filter(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r := pagination.RangeOf(page)
	cur, err := s.DB.Collection("notificationcampaigns").Find(c, filter, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetSkip(int64(r.Skip)).SetLimit(int64(r.Limit)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []record
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	total, err := s.DB.Collection("notificationcampaigns").CountDocuments(c, filter)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	byCampaign := map[bson.ObjectID]stats{}
	if len(rows) > 0 {
		ids := make(bson.A, len(rows))
		for i := range rows {
			ids[i] = rows[i].ID
		}
		ifSet := func(field string) bson.D {
			return bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{bson.D{{Key: "$gt", Value: bson.A{"$" + field, nil}}}, 1, 0}}}}}
		}
		ac, err := s.DB.Collection("notifications").Aggregate(c, bson.A{bson.D{{Key: "$match", Value: bson.D{{Key: "campaignId", Value: bson.D{{Key: "$in", Value: ids}}}}}},
			bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$campaignId"}, {Key: "delivered", Value: ifSet("deliveredAt")}, {Key: "read", Value: ifSet("readAt")}, {Key: "sent", Value: bson.D{{Key: "$sum", Value: 1}}}}}}})
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var tallies []struct {
			ID    bson.ObjectID `bson:"_id"`
			Stats stats         `bson:",inline"`
		}
		if err := ac.All(c, &tallies); err != nil {
			httpx.Fail(c, err)
			return
		}
		for _, t := range tallies {
			byCampaign[t.ID] = t.Stats
		}
	}
	out := listOut{Campaigns: make([]ordered.Map, len(rows)), Pagination: pagination.MetaOf(page, int(total))}
	for i := range rows {
		out.Campaigns[i] = serialize(&rows[i], byCampaign[rows[i].ID])
	}
	httpx.Write(c, 200, out, "Notification campaigns loaded")
}

func itoa(i int) string {
	b := []byte{}
	for {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
		if i == 0 {
			return string(b)
		}
	}
}
