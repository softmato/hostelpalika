package community

import (
	"context"
	"errors"
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
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// RegisterAdmin is the hostel portal's moderation queue and announcements.
func (h *Handler) RegisterAdmin(v1 *gin.RouterGroup, log *audit.Log) {
	g := v1.Group("/hostel-admin/community")
	g.GET("", httpx.ETag(), h.moderation)
	g.POST("", h.announce)
	g.PATCH("/:postId/hide", func(c *gin.Context) { h.setHidden(c, log, true) })
	g.DELETE("/:postId/hide", func(c *gin.Context) { h.setHidden(c, log, false) })
}

func scopeRequired() error {
	return httpx.NewError(http.StatusUnprocessableEntity, "HOSTEL_SCOPE_REQUIRED", "A hostelId is required for this hostel admin action.", nil)
}

// moderationScope is moderationScopeFilter for hostel staff; platform roles never
// reach these routes.
func moderationScope(p *authz.Principal, requested string) (bson.D, error) {
	if requested == "" && len(opsscope.IDs(p)) == 0 {
		return nil, scopeRequired()
	}
	return opsscope.Filter(p, requested)
}

// moderatorView adds the four fields only a moderator sees, in their sorted places.
func moderatorView(row *post, base ordered.Map) ordered.Map {
	out := make(ordered.Map, 0, len(base)+4)
	for _, kv := range base {
		switch kv.Key {
		case "hostelId":
			if row.FlaggedAt != nil {
				out = append(out, ordered.Pair{Key: "flaggedAt", Value: httpx.ISO(*row.FlaggedAt)})
			}
			if row.FlaggedReason != nil {
				out = append(out, ordered.Pair{Key: "flaggedReason", Value: *row.FlaggedReason})
			}
			if row.HiddenReason != nil {
				out = append(out, ordered.Pair{Key: "hiddenReason", Value: *row.HiddenReason})
			}
		case "spaceType":
			out = append(out, ordered.Pair{Key: "reportCount", Value: row.ReportCount})
		}
		out = append(out, kv)
	}
	return out
}

func (h *Handler) decorateModerator(ctx context.Context, rows []post, p *authz.Principal) ([]ordered.Map, error) {
	out, err := h.decorate(ctx, rows, p)
	if err != nil {
		return nil, err
	}
	for i := range out {
		out[i] = moderatorView(&rows[i], out[i])
	}
	return out, nil
}

type moderationSummary struct {
	Flagged int64 `json:"flagged"`
	Hidden  int64 `json:"hidden"`
	Total   int64 `json:"total"`
}

type moderationOut struct {
	Pagination pagination.Meta   `json:"pagination"`
	Posts      []ordered.Map     `json:"posts"`
	Summary    moderationSummary `json:"summary"`
}

func (h *Handler) moderation(c *gin.Context) {
	p, err := h.Guards.RequireHostelStaff(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	page := opsscope.ReadPage(q, &is)
	hostel := opsscope.Hostel(q, &is)
	name := valid.QueryEnum(q, "filter", &is, "flagged", "hidden", "all")
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	scope, err := moderationScope(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	flaggedF := append(append(bson.D{}, scope...), bson.E{Key: "flaggedAt", Value: bson.D{{Key: "$ne", Value: nil}}}, bson.E{Key: "status", Value: "VISIBLE"})
	hiddenF := append(append(bson.D{}, scope...), bson.E{Key: "status", Value: "HIDDEN"})
	filter := flaggedF
	if name != nil && *name == "hidden" {
		filter = hiddenF
	} else if name != nil && *name == "all" {
		filter = scope
	}
	posts := h.DB.Collection("communityposts")
	r := pagination.RangeOf(page)
	cur, err := posts.Find(c, filter, options.Find().SetSort(bson.D{{Key: "flaggedAt", Value: -1}, {Key: "reportCount", Value: -1}, {Key: "createdAt", Value: -1}}).SetSkip(int64(r.Skip)).SetLimit(int64(r.Limit)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []post
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	out := moderationOut{}
	if out.Summary.Total, err = posts.CountDocuments(c, filter); err != nil {
		httpx.Fail(c, err)
		return
	}
	if out.Summary.Flagged, err = posts.CountDocuments(c, flaggedF); err != nil {
		httpx.Fail(c, err)
		return
	}
	if out.Summary.Hidden, err = posts.CountDocuments(c, hiddenF); err != nil {
		httpx.Fail(c, err)
		return
	}
	if out.Posts, err = h.decorateModerator(c, rows, p); err != nil {
		httpx.Fail(c, err)
		return
	}
	out.Pagination = pagination.MetaOf(page, int(out.Summary.Total))
	httpx.Write(c, 200, out, "Community posts loaded")
}

func (h *Handler) setHidden(c *gin.Context, log *audit.Log, hide bool) {
	p, err := h.Guards.RequireHostelStaff(c)
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
	reason, _ := f.Str("reason", valid.S{Trim: true, Min: 3, Max: 500})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	scope, err := moderationScope(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := httpx.OID(c.Param("postId"), "post id")
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
	update := bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "VISIBLE"}, {Key: "updatedAt", Value: now}}},
		{Key: "$unset", Value: bson.D{{Key: "flaggedAt", Value: ""}, {Key: "flaggedReason", Value: ""}, {Key: "hiddenAt", Value: ""}, {Key: "hiddenBy", Value: ""}, {Key: "hiddenReason", Value: ""}}}}
	verdict, action, message := "DISMISSED", "COMMUNITY_POST_RESTORED", "Post restored"
	if hide {
		update = bson.D{{Key: "$set", Value: bson.D{{Key: "hiddenAt", Value: now}, {Key: "hiddenBy", Value: uid}, {Key: "hiddenReason", Value: reason}, {Key: "status", Value: "HIDDEN"}, {Key: "updatedAt", Value: now}}},
			{Key: "$unset", Value: bson.D{{Key: "flaggedAt", Value: ""}, {Key: "flaggedReason", Value: ""}}}}
		verdict, action, message = "ACTIONED", "COMMUNITY_POST_HIDDEN", "Post hidden"
	}
	var row post
	err = h.DB.Collection("communityposts").FindOneAndUpdate(c, append(bson.D{{Key: "_id", Value: id}}, scope...), update, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, httpx.NewError(http.StatusNotFound, "POST_NOT_FOUND", "Post was not found.", nil))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if _, err := h.DB.Collection("communityreports").UpdateMany(c, bson.D{{Key: "postId", Value: row.ID}, {Key: "status", Value: "OPEN"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "reviewedAt", Value: now}, {Key: "reviewedBy", Value: uid}, {Key: "status", Value: verdict}, {Key: "updatedAt", Value: now}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	entry := audit.Entry{Action: action, ActorID: uid, EntityID: row.ID.Hex(), EntityType: "CommunityPost", Metadata: bson.D{{Key: "reason", Value: reason}}}
	if row.HostelID != nil {
		entry.HostelID = *row.HostelID
	}
	if err := log.Write(c, entry); err != nil {
		httpx.Fail(c, err)
		return
	}
	decorated, err := h.decorateModerator(c, []post{row}, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.publish(c, &row)
	httpx.Write(c, 200, postOut{decorated[0]}, message)
}

func (h *Handler) announce(c *gin.Context) {
	p, err := h.Guards.RequireHostelStaff(c)
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
	text, _ := f.Str("body", valid.S{Trim: true, Min: 1, Max: 4000})
	hostel := opsscope.BodyHostel(f)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	if hostel == "" {
		if len(p.HostelIDs) == 0 {
			httpx.Fail(c, scopeRequired())
			return
		}
		hostel = p.HostelIDs[0]
	}
	hostelID, err := opsscope.HostelID(p, hostel)
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
	row := post{ID: bson.NewObjectID(), AuthorID: &uid, Body: text, CreatedAt: &now, HostelID: &hostelID, IsAnnouncement: true, SpaceType: "HOSTEL", Status: "VISIBLE", Visibility: "HOSTEL_ONLY"}
	if _, err := h.DB.Collection("communityposts").InsertOne(c, bson.D{{Key: "_id", Value: row.ID}, {Key: "authorId", Value: uid}, {Key: "body", Value: text}, {Key: "hostelId", Value: hostelID}, {Key: "isAnnouncement", Value: true},
		{Key: "spaceType", Value: "HOSTEL"}, {Key: "status", Value: "VISIBLE"}, {Key: "visibility", Value: "HOSTEL_ONLY"}, {Key: "commentCount", Value: 0}, {Key: "reactionCount", Value: 0}, {Key: "reportCount", Value: 0},
		{Key: "media", Value: bson.A{}}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	decorated, err := h.decorateModerator(c, []post{row}, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.publish(c, &row)
	authorName, _ := decorated[0].Get("authorName")
	hostelName, _ := decorated[0].Get("hostelName")
	name, _ := authorName.(string)
	where, _ := hostelName.(string)
	userID := p.UserID
	notify := func(ctx context.Context) error {
		h.notifyNewPost(ctx, name, userID, text, &hostelID, where, row.ID.Hex())
		return nil
	}
	if h.BG != nil {
		h.BG.After(c, notify)
	} else {
		_ = notify(c)
	}
	httpx.Write(c, 201, postOut{decorated[0]}, "Announcement posted")
}
