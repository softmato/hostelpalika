// Package feedback is Help & support → Send feedback (modules/feedback).
// Only the sender's side so far: platform staff read the inbox in Phase 7.
package feedback

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ratelimit"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

const (
	perHour = 5
	perDay  = 15
)

type Handler struct {
	db      *mongo.Database
	guards  *authz.Guards
	limiter *ratelimit.Limiter
}

func NewHandler(db *mongo.Database, guards *authz.Guards, limiter *ratelimit.Limiter) *Handler {
	return &Handler{db, guards, limiter}
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.POST("/feedback", h.create)
}

type input struct {
	AppVersion *string
	Kind       string
	Message    string
	Page       *string
	Platform   string
	Screenshot []string
}

// parse is feedbackCreateSchema.
func parse(body any) (input, error) {
	f := valid.NewForm(body)
	var in input
	if v, ok := f.Str("appVersion", valid.S{Opt: true, Trim: true, Max: 40}); ok {
		in.AppVersion = &v
	}
	in.Kind, _ = f.Enum("kind", false, nil, "FEEDBACK", "BUG", "IMPROVEMENT")
	in.Message, _ = f.Str("message", valid.S{Trim: true, Min: 3, MinMsg: "Write a few words.", Max: 4000})
	if v, ok := f.Str("page", valid.S{Opt: true, Trim: true, Max: 300}); ok {
		in.Page = &v
	}
	web := "WEB"
	in.Platform, _ = f.Enum("platform", false, &web, "WEB", "APP")
	if items, ok := f.Array("screenshotAssetIds", false, true); ok {
		aborted := false
		for i, v := range items {
			if _, isStr := v.(string); !isStr {
				aborted = true
			}
			if id, ok := valid.ObjectID(v, "screenshotAssetIds."+strconv.Itoa(i), "Invalid id.", &f.Is, false); ok {
				in.Screenshot = append(in.Screenshot, id)
			}
		}
		f.Size("screenshotAssetIds", len(items), 0, 4, "", aborted)
	}
	return in, f.Err()
}

// quotaReached is feedbackQuotaReached, counted in the database.
func (h *Handler) quotaReached(ctx context.Context, userID bson.ObjectID) (bool, error) {
	now := time.Now()
	count := func(d time.Duration) (int64, error) {
		return h.db.Collection("feedbacks").CountDocuments(ctx,
			bson.D{{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: now.Add(-d)}}}, {Key: "userId", Value: userID}})
	}
	hour, err := count(time.Hour)
	if err != nil {
		return false, err
	}
	day, err := count(24 * time.Hour)
	if err != nil {
		return false, err
	}
	return hour >= perHour || day >= perDay, nil
}

func (h *Handler) create(c *gin.Context) {
	// Burst gate per device first (cheap), then the per-account budget in the database.
	if err := h.limiter.Check(c, "feedback", 3, time.Minute); err != nil {
		httpx.Fail(c, err)
		return
	}
	p, err := h.guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	userID, _ := bson.ObjectIDFromHex(p.UserID)
	reached, err := h.quotaReached(c, userID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if reached {
		httpx.Fail(c, httpx.NewError(http.StatusTooManyRequests, "RATE_LIMITED", "You have sent several messages recently. Please try again in a while.", nil))
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, err := parse(body)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := h.createRow(c, p, userID, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, struct {
		ID string `json:"id"`
	}{id}, "Thanks — we have it.")
}

func (h *Handler) createRow(ctx context.Context, p *authz.Principal, userID bson.ObjectID, in input) (string, error) {
	// Only the sender's own uploads ride along; anything else is dropped, not trusted.
	owned := bson.A{}
	if len(in.Screenshot) > 0 {
		ids := bson.A{}
		for _, s := range in.Screenshot {
			if id, err := bson.ObjectIDFromHex(s); err == nil {
				ids = append(ids, id)
			}
		}
		cur, err := h.db.Collection("fileassets").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "ownerId", Value: userID}},
			options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
		if err != nil {
			return "", err
		}
		var rows []struct {
			ID bson.ObjectID `bson:"_id"`
		}
		if err := cur.All(ctx, &rows); err != nil {
			return "", err
		}
		for _, r := range rows {
			owned = append(owned, r.ID)
		}
	}
	now := time.Now().UTC()
	id := bson.NewObjectID()
	row := bson.D{{Key: "_id", Value: id}}
	if in.AppVersion != nil {
		row = append(row, bson.E{Key: "appVersion", Value: *in.AppVersion})
	}
	if len(p.HostelIDs) > 0 {
		if hid, err := bson.ObjectIDFromHex(p.HostelIDs[0]); err == nil {
			row = append(row, bson.E{Key: "hostelId", Value: hid})
		}
	}
	row = append(row, bson.E{Key: "kind", Value: in.Kind}, bson.E{Key: "message", Value: in.Message})
	if in.Page != nil {
		row = append(row, bson.E{Key: "page", Value: *in.Page})
	}
	row = append(row, bson.E{Key: "platform", Value: in.Platform}, bson.E{Key: "role", Value: string(p.Role)},
		bson.E{Key: "screenshotAssetIds", Value: owned}, bson.E{Key: "userId", Value: userID},
		bson.E{Key: "status", Value: "NEW"}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := h.db.Collection("feedbacks").InsertOne(ctx, row); err != nil {
		return "", err
	}
	return id.Hex(), nil
}
