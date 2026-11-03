package campaigns

import (
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// RegisterPlatform is /platform/notifications. Reading is any platform staff;
// broadcasting to every resident is a superadmin's call alone.
func (s *Service) RegisterPlatform(v1 *gin.RouterGroup) {
	v1.GET("/platform/notifications", authz.Use(s.Guards.RequirePlatform), httpx.ETag(), s.platformList)
	v1.POST("/platform/notifications", authz.Use(s.Guards.RequireSuperadmin), s.platformCreate)
}

func (s *Service) platformList(c *gin.Context) {
	one, max := 1, 100 // MAX_PAGE_SIZE: the page is fixed, the route takes no query
	s.listWhere(c, bson.D{{Key: "scope", Value: "PLATFORM"}}, pagination.Query{Page: &one, PageSize: &max}, "Platform notification campaigns loaded")
}

var objectIDRe = regexp.MustCompile(`(?i)^[a-f\d]{24}$`)

func (s *Service) platformCreate(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	announcement, normal := "ANNOUNCEMENT", "NORMAL"
	text, _ := f.Str("body", valid.S{Trim: true, Min: 2, Max: 2000})
	category, hasCategory := f.Str("category", valid.S{Opt: true, Trim: true, Min: 2, Max: 60})
	if !hasCategory && !f.Present("category") {
		category = announcement
	}
	priority, _ := f.Enum("priority", false, &normal, "LOW", "NORMAL", "HIGH", "URGENT")
	var scheduled *time.Time
	if raw, ok := f.M["scheduledFor"]; ok {
		if t, ok := valid.CoerceDate(raw); ok {
			u := t.UTC()
			scheduled = &u
		} else {
			f.Hard = true
			f.Is.Add("scheduledFor", valid.Type("date", "Date"))
		}
	}
	title, _ := f.Str("title", valid.S{Trim: true, Min: 2, Max: 160})
	list, _ := f.Array("hostelIds", false, true)
	hostelIDs := make([]bson.ObjectID, 0, len(list))
	for i, v := range list {
		sub := valid.NewForm(map[string]any{"h": v})
		if h, ok := sub.Str("h", valid.S{Re: objectIDRe, ReMsg: "Invalid object id."}); ok && objectIDRe.MatchString(h) {
			id, _ := bson.ObjectIDFromHex(h)
			hostelIDs = append(hostelIDs, id)
		}
		f.JoinScalar("hostelIds."+strconv.Itoa(i), sub)
	}
	f.Size("hostelIds", len(list), 0, 200, "", false)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(authz.From(c).UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if scheduled != nil && scheduled.Before(now.Add(-time.Minute)) {
		httpx.Fail(c, httpx.NewError(http.StatusUnprocessableEntity, "NOTIFICATION_SCHEDULE_IN_PAST", "Pick a delivery time in the future.", nil))
		return
	}
	row := record{ID: bson.NewObjectID(), Audience: "ALL", Body: text, Category: category, CreatedAt: &now, HostelIDs: hostelIDs, Priority: priority, ScheduledFor: scheduled, Scope: "PLATFORM", Status: "SCHEDULED", Title: title}
	doc := bson.D{{Key: "_id", Value: row.ID}, {Key: "audience", Value: "ALL"}, {Key: "body", Value: text}, {Key: "category", Value: category}, {Key: "hostelIds", Value: hostelIDs}, {Key: "priority", Value: priority},
		{Key: "scope", Value: "PLATFORM"}, {Key: "title", Value: title}, {Key: "createdBy", Value: uid}}
	if scheduled != nil {
		doc = append(doc, bson.E{Key: "scheduledFor", Value: *scheduled})
	}
	doc = append(doc, bson.E{Key: "status", Value: "SCHEDULED"}, bson.E{Key: "recipientCount", Value: 0}, bson.E{Key: "residentIds", Value: bson.A{}}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
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
	if err := s.Audit.Write(c, audit.Entry{Action: "NOTIFICATION_CAMPAIGN_CREATED", ActorID: uid, EntityID: row.ID.Hex(), EntityType: "NotificationCampaign",
		Metadata: bson.D{{Key: "audience", Value: "ALL"}, {Key: "recipientCount", Value: saved.Recipients}, {Key: "scheduled", Value: scheduled != nil}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, 201, ordered.Map{{Key: "campaign", Value: serialize(&saved, stats{})}}, "Platform notification sent")
}
