// Package arrivals is "I'm on my way" (modules/arrivals): a signed-in person
// navigating to a hostel tells its staff when they will get there. Only the
// arrival time crosses — never a position, never a route.
package arrivals

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/ratelimit"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

const (
	category = "ARRIVAL"
	// One heads-up per person per hostel in this window; the second is a no-op.
	repeatWindow = 10 * time.Minute
)

type Handler struct {
	db      *mongo.Database
	guards  *authz.Guards
	limiter *ratelimit.Limiter
	notify  *notifications.Service
}

func NewHandler(db *mongo.Database, guards *authz.Guards, limiter *ratelimit.Limiter, notify *notifications.Service) *Handler {
	return &Handler{db, guards, limiter, notify}
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.POST("/public/hostels/:slug/arriving", h.arriving)
	v1.GET("/public/hostels/:slug/arriving", func(c *gin.Context) { c.AbortWithStatus(http.StatusMethodNotAllowed) })
}

type input struct {
	Minutes int
	Mode    string
}

// parse is arrivalSchema.
func parse(body any) (input, error) {
	f := valid.NewForm(body)
	var in input
	if n, ok := f.Num("minutes", valid.N{Int: true, Min: valid.P(1), Max: valid.P(600)}); ok {
		in.Minutes = int(n)
	}
	in.Mode, _ = f.Enum("mode", false, nil, "car", "foot")
	return in, f.Err()
}

type sent struct {
	Sent bool `json:"sent"`
}

func (h *Handler) arriving(c *gin.Context) {
	if err := h.limiter.PublicForm(c, "hostel-arriving"); err != nil {
		httpx.Fail(c, err)
		return
	}
	p, err := h.guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
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
	out, err := h.announce(c, c.Param("slug"), in, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Hostel told")
}

func (h *Handler) announce(ctx context.Context, ref string, in input, p *authz.Principal) (sent, error) {
	filter := bson.D{{Key: "slug", Value: ref}}
	if id, err := bson.ObjectIDFromHex(ref); err == nil {
		filter = bson.D{{Key: "_id", Value: id}}
	}
	var hostel struct {
		ID   bson.ObjectID `bson:"_id"`
		Name string        `bson:"name"`
	}
	err := h.db.Collection("hostels").FindOne(ctx, append(filter, bson.E{Key: "isDeleted", Value: false}, bson.E{Key: "status", Value: "PUBLISHED"}),
		options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}})).Decode(&hostel)
	if err == mongo.ErrNoDocuments {
		return sent{}, httpx.NewError(http.StatusNotFound, "HOSTEL_NOT_FOUND", "Hostel not found.", nil)
	}
	if err != nil {
		return sent{}, err
	}
	all, err := residents.HostelStaffUserIDs(ctx, h.db, hostel.ID, false)
	if err != nil {
		return sent{}, err
	}
	var staff []string
	for _, id := range all {
		if id != p.UserID {
			staff = append(staff, id)
		}
	}
	if len(staff) == 0 {
		return sent{false}, nil
	}
	// Checked on one staff member's rows — `userId` is indexed there.
	first, _ := bson.ObjectIDFromHex(staff[0])
	recent, err := h.db.Collection("notifications").CountDocuments(ctx, bson.D{{Key: "category", Value: category},
		{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: time.Now().Add(-repeatWindow)}}},
		{Key: "data.travellerId", Value: p.UserID}, {Key: "userId", Value: first}}, options.Count().SetLimit(1))
	if err != nil {
		return sent{}, err
	}
	if recent > 0 {
		return sent{true}, nil
	}
	who := "Someone"
	if uid, err := bson.ObjectIDFromHex(p.UserID); err == nil {
		var traveller struct {
			Name string `bson:"name"`
		}
		if err := h.db.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: uid}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}})).Decode(&traveller); err == nil {
			if n := strings.TrimSpace(traveller.Name); n != "" {
				who = n
			}
		}
	}
	how := "by vehicle"
	if in.Mode == "foot" {
		how = "walking"
	}
	for _, userID := range staff {
		_, err := h.notify.CreateInApp(ctx, notifications.Input{
			Body:     fmt.Sprintf("%s is on the way to %s %s — about %d min away.", who, hostel.Name, how, in.Minutes),
			Category: category,
			Data:     ordered.Map{{Key: "minutes", Value: float64(in.Minutes)}, {Key: "mode", Value: in.Mode}, {Key: "travellerId", Value: p.UserID}},
			HostelID: hostel.ID.Hex(),
			Title:    who + " is coming",
			UserID:   userID,
		})
		if err != nil {
			return sent{}, err
		}
	}
	return sent{true}, nil
}
