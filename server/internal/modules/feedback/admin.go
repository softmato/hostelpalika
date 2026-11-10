package feedback

import (
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// The platform's feedback inbox (feedback.service listFeedback, setFeedbackStatus).

var roleShape = regexp.MustCompile(`^[A-Z_]{2,40}$`)

func (h *Handler) RegisterPlatform(v1 *gin.RouterGroup) {
	staff := authz.Use(h.guards.RequirePlatform)
	v1.GET("/platform/feedback", staff, httpx.ETag(), h.inbox)
	v1.PATCH("/platform/feedback/:id", staff, h.setStatus)
	v1.GET("/platform/guide-feedback", staff, httpx.ETag(), h.guideInbox)
}

// countsOf groups by field; keys sorted so the answer is stable (Mongo's group
// order is not, and TS passed it through as it came).
func countsOf(rows []struct {
	ID    *string `bson:"_id"`
	Count int     `bson:"count"`
}, nullAs string) ordered.Map {
	sort.Slice(rows, func(i, j int) bool { return deref(rows[i].ID, nullAs) < deref(rows[j].ID, nullAs) })
	out := ordered.Map{}
	for _, r := range rows {
		out = append(out, ordered.Pair{Key: deref(r.ID, nullAs), Value: r.Count})
	}
	return out
}

func deref(s *string, d string) string {
	if s == nil {
		return d
	}
	return *s
}

func (h *Handler) inbox(c *gin.Context) {
	status := c.Query("status")
	if status != "NEW" && status != "SEEN" && status != "DONE" {
		status = ""
	}
	role := strings.TrimSpace(c.Query("role"))
	if !roleShape.MatchString(role) {
		role = ""
	}
	statusFilter, roleFilter := bson.D{}, bson.D{}
	if status != "" {
		statusFilter = bson.D{{Key: "status", Value: status}}
	}
	if role != "" {
		roleFilter = bson.D{{Key: "role", Value: role}}
	}
	coll := h.db.Collection("feedbacks")
	cur, err := coll.Find(c, append(append(bson.D{}, statusFilter...), roleFilter...), options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(200))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []struct {
		ID          bson.ObjectID   `bson:"_id"`
		AppVersion  *string         `bson:"appVersion"`
		CreatedAt   time.Time       `bson:"createdAt"`
		HostelID    *bson.ObjectID  `bson:"hostelId"`
		Kind        string          `bson:"kind"`
		Message     string          `bson:"message"`
		Page        *string         `bson:"page"`
		Platform    *string         `bson:"platform"`
		Role        *string         `bson:"role"`
		Screenshots []bson.ObjectID `bson:"screenshotAssetIds"`
		Status      string          `bson:"status"`
		UserID      bson.ObjectID   `bson:"userId"`
	}
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	userIDs, hostelIDs, assetIDs := bson.A{}, bson.A{}, bson.A{}
	for _, r := range rows {
		userIDs = append(userIDs, r.UserID)
		if r.HostelID != nil {
			hostelIDs = append(hostelIDs, *r.HostelID)
		}
		for _, a := range r.Screenshots {
			assetIDs = append(assetIDs, a)
		}
	}
	type person struct {
		ID       bson.ObjectID `bson:"_id"`
		Email    *string       `bson:"email"`
		FullName *string       `bson:"fullName"`
		Name     *string       `bson:"name"`
		Phone    *string       `bson:"phone"`
	}
	users := map[bson.ObjectID]person{}
	if len(userIDs) > 0 {
		ucur, err := h.db.Collection("users").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: userIDs}}}})
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var us []person
		if err := ucur.All(c, &us); err != nil {
			httpx.Fail(c, err)
			return
		}
		for _, u := range us {
			users[u.ID] = u
		}
	}
	hostels := map[bson.ObjectID]string{}
	if len(hostelIDs) > 0 {
		hcur, err := h.db.Collection("hostels").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: hostelIDs}}}}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}))
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var hs []struct {
			ID   bson.ObjectID `bson:"_id"`
			Name string        `bson:"name"`
		}
		if err := hcur.All(c, &hs); err != nil {
			httpx.Fail(c, err)
			return
		}
		for _, x := range hs {
			hostels[x.ID] = x.Name
		}
	}
	videos := map[bson.ObjectID]bool{}
	if len(assetIDs) > 0 {
		acur, err := h.db.Collection("fileassets").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: assetIDs}}}}, options.Find().SetProjection(bson.D{{Key: "mimeType", Value: 1}}))
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var as []struct {
			ID   bson.ObjectID `bson:"_id"`
			Mime string        `bson:"mimeType"`
		}
		if err := acur.All(c, &as); err != nil {
			httpx.Fail(c, err)
			return
		}
		for _, a := range as {
			videos[a.ID] = strings.HasPrefix(a.Mime, "video/")
		}
	}
	group := func(match bson.D, field string) ([]struct {
		ID    *string `bson:"_id"`
		Count int     `bson:"count"`
	}, error) {
		cur, err := coll.Aggregate(c, bson.A{bson.D{{Key: "$match", Value: match}}, bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$" + field}, {Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}}}}}})
		if err != nil {
			return nil, err
		}
		var out []struct {
			ID    *string `bson:"_id"`
			Count int     `bson:"count"`
		}
		return out, cur.All(c, &out)
	}
	byStatus, err := group(roleFilter, "status")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	byRole, err := group(statusFilter, "role")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	items := make([]ordered.Map, len(rows))
	for i, r := range rows {
		var hostel, version, page, rowRole any
		if r.HostelID != nil {
			if n, ok := hostels[*r.HostelID]; ok {
				hostel = n
			}
		}
		if r.AppVersion != nil {
			version = *r.AppVersion
		}
		if r.Page != nil {
			page = *r.Page
		}
		if r.Role != nil {
			rowRole = *r.Role
		}
		shots := make([]ordered.Map, len(r.Screenshots))
		for j, a := range r.Screenshots {
			shots[j] = ordered.Map{{Key: "id", Value: a.Hex()}, {Key: "video", Value: videos[a]}}
		}
		u := users[r.UserID]
		var mail, phone any
		if u.Email != nil {
			mail = *u.Email
		}
		if u.Phone != nil {
			phone = *u.Phone
		}
		name := "Unknown"
		if u.FullName != nil {
			name = *u.FullName
		} else if u.Name != nil {
			name = *u.Name
		}
		items[i] = ordered.Map{{Key: "appVersion", Value: version}, {Key: "createdAt", Value: httpx.ISO(r.CreatedAt)}, {Key: "hostel", Value: hostel}, {Key: "id", Value: r.ID.Hex()},
			{Key: "kind", Value: r.Kind}, {Key: "message", Value: r.Message}, {Key: "page", Value: page}, {Key: "platform", Value: deref(r.Platform, "WEB")}, {Key: "role", Value: rowRole},
			{Key: "screenshots", Value: shots}, {Key: "sender", Value: ordered.Map{{Key: "email", Value: mail}, {Key: "name", Value: name}, {Key: "phone", Value: phone}}}, {Key: "status", Value: r.Status}}
	}
	httpx.OK(c, ordered.Map{{Key: "counts", Value: countsOf(byStatus, "null")}, {Key: "roleCounts", Value: countsOf(byRole, "UNKNOWN")}, {Key: "items", Value: items}}, "Request successful")
}

var hex24 = regexp.MustCompile(`(?i)^[a-f\d]{24}$`)

// setStatus is setFeedbackStatus. An unknown id is a 404 (P7-22): TS answered
// success for a row that did not exist.
func (h *Handler) setStatus(c *gin.Context) {
	p := authz.From(c)
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	status, _ := f.Enum("status", false, nil, "NEW", "SEEN", "DONE")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	id := c.Param("id")
	if !hex24.MatchString(id) {
		var is valid.Issues
		is.Add("", "Invalid id.")
		httpx.Fail(c, is.Err())
		return
	}
	oid, _ := bson.ObjectIDFromHex(id)
	actor, _ := bson.ObjectIDFromHex(p.UserID)
	res, err := h.db.Collection("feedbacks").UpdateOne(c, bson.D{{Key: "_id", Value: oid}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "handledAt", Value: time.Now().UTC().Truncate(time.Millisecond)}, {Key: "handledBy", Value: actor}, {Key: "status", Value: status}, {Key: "updatedAt", Value: time.Now().UTC().Truncate(time.Millisecond)}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if res.MatchedCount == 0 {
		httpx.Fail(c, httpx.NewError(http.StatusNotFound, "FEEDBACK_NOT_FOUND", "That feedback was not found.", nil))
		return
	}
	httpx.OK(c, ordered.Map{{Key: "id", Value: id}, {Key: "status", Value: status}}, "Updated")
}
