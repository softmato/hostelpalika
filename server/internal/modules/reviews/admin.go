package reviews

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Moderation is /platform/reviews: the queue, and hiding or showing a review
// (review.service listPlatformReviews, moderateReview).
type Moderation struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Audit  *audit.Log
	RT     *realtime.Client
	Cache  *cache.Cache
}

func (m *Moderation) Register(v1 *gin.RouterGroup) {
	staff := authz.Use(m.Guards.RequirePlatform)
	v1.GET("/platform/reviews", staff, httpx.ETag(), m.list)
	v1.PATCH("/platform/reviews/:id/hide", staff, func(c *gin.Context) { m.moderate(c, "HIDE") })
	v1.PATCH("/platform/reviews/:id/unhide", staff, func(c *gin.Context) { m.moderate(c, "UNHIDE") })
}

type review struct {
	ID          bson.ObjectID  `bson:"_id"`
	Cleanliness *float64       `bson:"cleanlinessRating"`
	Comment     *string        `bson:"comment"`
	CreatedAt   *time.Time     `bson:"createdAt"`
	Food        *float64       `bson:"foodRating"`
	HiddenAt    *time.Time     `bson:"hiddenAt"`
	HiddenBy    *bson.ObjectID `bson:"hiddenBy"`
	HostelID    bson.ObjectID  `bson:"hostelId"`
	Location    *float64       `bson:"locationRating"`
	Management  *float64       `bson:"managementRating"`
	Overall     float64        `bson:"overallRating"`
	ResidentID  bson.ObjectID  `bson:"residentId"`
	Room        *float64       `bson:"roomRating"`
	Safety      *float64       `bson:"safetyRating"`
	Status      string         `bson:"status"`
	UpdatedAt   *time.Time     `bson:"updatedAt"`
	UserID      bson.ObjectID  `bson:"userId"`
}

// out is serializeReview; an undefined field is left out, as JSON.stringify does.
func (r *review) out() ordered.Map {
	m := ordered.Map{}
	opt := func(k string, v any, ok bool) {
		if ok {
			m = append(m, ordered.Pair{Key: k, Value: v})
		}
	}
	num := func(k string, f *float64) {
		if f != nil {
			m = append(m, ordered.Pair{Key: k, Value: *f})
		}
	}
	comment := ""
	if r.Comment != nil {
		comment = *r.Comment
	}
	num("cleanlinessRating", r.Cleanliness)
	m = append(m, ordered.Pair{Key: "comment", Value: comment})
	if r.CreatedAt != nil {
		opt("createdAt", httpx.ISO(*r.CreatedAt), true)
	}
	num("foodRating", r.Food)
	if r.HiddenAt != nil {
		opt("hiddenAt", httpx.ISO(*r.HiddenAt), true)
	}
	if r.HiddenBy != nil {
		opt("hiddenBy", r.HiddenBy.Hex(), true)
	}
	m = append(m, ordered.Pair{Key: "hostelId", Value: r.HostelID.Hex()}, ordered.Pair{Key: "id", Value: r.ID.Hex()})
	num("locationRating", r.Location)
	num("managementRating", r.Management)
	m = append(m, ordered.Pair{Key: "overallRating", Value: r.Overall}, ordered.Pair{Key: "residentId", Value: r.ResidentID.Hex()})
	num("roomRating", r.Room)
	num("safetyRating", r.Safety)
	m = append(m, ordered.Pair{Key: "status", Value: r.Status})
	if r.UpdatedAt != nil {
		opt("updatedAt", httpx.ISO(*r.UpdatedAt), true)
	}
	return append(m, ordered.Pair{Key: "userId", Value: r.UserID.Hex()})
}

func invalidID(label string) error {
	return httpx.NewError(http.StatusUnprocessableEntity, "INVALID_OBJECT_ID", "Invalid "+label+".", nil)
}

func (m *Moderation) list(c *gin.Context) {
	q := valid.Query(c)
	var is valid.Issues
	page := valid.Page(q, &is)
	hostel, hasHostel := q["hostelId"]
	if hasHostel {
		valid.ObjectID(hostel, "hostelId", "", &is, false) // review.validation.ts has its own objectIdSchema
	}
	status := valid.QueryEnum(q, "status", &is, "VISIBLE", "HIDDEN")
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	filter := bson.D{}
	if hasHostel {
		oid, _ := bson.ObjectIDFromHex(hostel)
		filter = append(filter, bson.E{Key: "hostelId", Value: oid})
	}
	if status != nil {
		filter = append(filter, bson.E{Key: "status", Value: *status})
	}
	r := pagination.RangeOf(page)
	cur, err := m.DB.Collection("ratingreviews").Find(c, filter, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetSkip(int64(r.Skip)).SetLimit(int64(r.Limit)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []review
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	total, err := m.DB.Collection("ratingreviews").CountDocuments(c, filter)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]ordered.Map, len(rows))
	for i := range rows {
		out[i] = rows[i].out()
	}
	httpx.OK(c, ordered.Map{{Key: "pagination", Value: pagination.MetaOf(page, int(total))}, {Key: "reviews", Value: out}}, "Reviews loaded")
}

func (m *Moderation) moderate(c *gin.Context, action string) {
	p := authz.From(c)
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	reason, hasReason := f.Str("reason", valid.S{Opt: true, Trim: true, Max: 1000})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		httpx.Fail(c, invalidID("review id"))
		return
	}
	actor, _ := bson.ObjectIDFromHex(p.UserID)
	now := time.Now().UTC().Truncate(time.Millisecond)
	update := bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "VISIBLE"}, {Key: "updatedAt", Value: now}}}, {Key: "$unset", Value: bson.D{{Key: "hiddenAt", Value: ""}, {Key: "hiddenBy", Value: ""}}}}
	msg := "Review unhidden"
	if action == "HIDE" {
		update = bson.D{{Key: "$set", Value: bson.D{{Key: "hiddenAt", Value: now}, {Key: "hiddenBy", Value: actor}, {Key: "status", Value: "HIDDEN"}, {Key: "updatedAt", Value: now}}}}
		msg = "Review hidden"
	}
	var r review
	if err := m.DB.Collection("ratingreviews").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}}, update, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&r); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			err = httpx.NewError(http.StatusNotFound, "REVIEW_NOT_FOUND", "Review was not found.", nil)
		}
		httpx.Fail(c, err)
		return
	}
	logRow := bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "action", Value: action}, {Key: "actorId", Value: actor}, {Key: "hostelId", Value: r.HostelID}}
	var reasonMeta any
	if hasReason {
		logRow = append(logRow, bson.E{Key: "reason", Value: reason})
		reasonMeta = reason
	}
	logRow = append(logRow, bson.E{Key: "reviewId", Value: r.ID}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if err := m.write(c, logRow); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := m.Audit.Write(c, audit.Entry{Action: "REVIEW_" + action, ActorID: actor, EntityID: r.ID.Hex(), EntityType: "RatingReview", HostelID: r.HostelID,
		Metadata: bson.D{{Key: "reason", Value: reasonMeta}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	realtime.PublishResourceChange(c, m.RT, m.Cache, realtime.Change{HostelIDs: []string{r.HostelID.Hex()}, Platform: true, Topics: []realtime.Topic{realtime.Reviews}})
	httpx.OK(c, ordered.Map{{Key: "review", Value: r.out()}}, msg)
}

func (m *Moderation) write(ctx context.Context, row bson.D) error {
	_, err := m.DB.Collection("reviewmoderationlogs").InsertOne(ctx, row)
	return err
}
