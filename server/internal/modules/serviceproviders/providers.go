// Package serviceproviders is modules/service-providers: the public directory,
// a tradesperson's application and the jobs they pick up from hostels.
package serviceproviders

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/files"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/ratelimit"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

type Handler struct {
	DB       *mongo.Database
	Guards   *authz.Guards
	Limiter  *ratelimit.Limiter
	Claims   files.Claims
	Mail     *email.Sender
	Notify   *notifications.Service
	Audit    *audit.Log
	RT       *realtime.Client
	Cache    realtime.Bumper
	Outbound string
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.GET("/public/service-providers", httpx.ETag(), h.list)
	v1.POST("/public/service-providers/register", h.register)
	v1.GET("/public/service-providers/me", httpx.ETag(), h.me)
	v1.GET("/public/service-providers/me/jobs", httpx.ETag(), h.jobs)
	v1.PATCH("/public/service-providers/me/jobs/:id", h.updateJob)
	v1.POST("/public/service-providers/me/jobs/:id/accept", h.accept)
}

var categories = []string{"PLUMBER", "ELECTRICIAN", "DOCTOR_CLINIC", "INTERNET_TECHNICIAN", "CLEANER", "CARPENTER", "PAINTER", "WATER_SUPPLIER", "APPLIANCE_REPAIR", "ROOM_REPAIR", "OTHER"}

// roleCategory is categoryForRole: the maintenance category a trade serves.
var roleCategory = map[string]string{
	"PLUMBER": "PLUMBING", "ELECTRICIAN": "ELECTRICAL", "INTERNET_TECHNICIAN": "INTERNET", "CLEANER": "CLEANING", "CARPENTER": "CARPENTRY",
	"PAINTER": "PAINTING", "WATER_SUPPLIER": "WATER", "APPLIANCE_REPAIR": "APPLIANCE", "ROOM_REPAIR": "ROOM_REPAIR", "DOCTOR_CLINIC": "HEALTH",
}

func categoryForRole(role string) string {
	if c, ok := roleCategory[role]; ok {
		return c
	}
	return "OTHER"
}

type provider struct {
	ID              bson.ObjectID  `bson:"_id"`
	Area            string         `bson:"area"`
	Availability    string         `bson:"availability"`
	Categories      []string       `bson:"categories"`
	Category        string         `bson:"category"`
	City            *string        `bson:"city"`
	CreatedAt       *time.Time     `bson:"createdAt"`
	Description     string         `bson:"description"`
	Email           string         `bson:"email"`
	Experience      string         `bson:"experience"`
	FullName        string         `bson:"fullName"`
	Phone           string         `bson:"phone"`
	PhotoAssetID    *bson.ObjectID `bson:"photoAssetId"`
	RatingSummary   bson.Raw       `bson:"ratingSummary"`
	RejectionReason string         `bson:"rejectionReason"`
	Status          string         `bson:"status"`
	UserID          *bson.ObjectID `bson:"userId"`
}

func (p provider) cats() []string {
	if len(p.Categories) > 0 {
		return p.Categories
	}
	return []string{p.Category}
}

func (p provider) city() string {
	if p.City != nil {
		return *p.City
	}
	return "Kathmandu"
}

func iso(t *time.Time) any {
	if t == nil {
		return ordered.Undefined
	}
	return httpx.ISO(*t)
}

func oidOrUndefined(id *bson.ObjectID) any {
	if id == nil {
		return ordered.Undefined
	}
	return id.Hex()
}

func (p provider) rating() any {
	if len(p.RatingSummary) == 0 {
		return ordered.Map{{Key: "averageRating", Value: 0}, {Key: "totalReviews", Value: 0}}
	}
	return ordered.FromBSON(bson.RawValue{Type: bson.TypeEmbeddedDocument, Value: p.RatingSummary})
}

func serErr(msg, code string, status int) *httpx.Error { return httpx.NewError(status, code, msg, nil) }

func objectID(v, label string) (bson.ObjectID, error) {
	id, err := bson.ObjectIDFromHex(v)
	if err != nil {
		return bson.ObjectID{}, serErr("Invalid "+label+".", "INVALID_OBJECT_ID", http.StatusUnprocessableEntity)
	}
	return id, nil
}

// findOwn is findOwnProvider: by the userId link or the account's own email.
func (h *Handler) findOwn(ctx context.Context, userID string, extra bson.D) (*provider, error) {
	uid, err := objectID(userID, "user id")
	if err != nil {
		return nil, err
	}
	var account struct {
		Email string `bson:"email"`
	}
	_ = h.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: uid}}, options.FindOne().SetProjection(bson.D{{Key: "email", Value: 1}})).Decode(&account)
	or := bson.A{bson.D{{Key: "userId", Value: uid}}}
	if e := strings.ToLower(strings.TrimSpace(account.Email)); e != "" {
		or = append(or, bson.D{{Key: "email", Value: e}})
	}
	filter := append(append(bson.D{}, extra...), bson.E{Key: "isDeleted", Value: false}, bson.E{Key: "$or", Value: or})
	var p provider
	err = h.DB.Collection("serviceproviders").FindOne(ctx, filter, options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}})).Decode(&p)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	return &p, err
}

// ── public directory ──

func (h *Handler) list(c *gin.Context) {
	q := valid.Query(c)
	var is valid.Issues
	area := valid.QueryString(q, "area", 1, 120, &is)
	category := valid.QueryEnum(q, "category", &is, categories...)
	city := valid.QueryString(q, "city", 1, 120, &is)
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	scope := bson.D{{Key: "isDeleted", Value: false}, {Key: "status", Value: "APPROVED"}}
	if area != nil {
		scope = append(scope, bson.E{Key: "area", Value: bson.Regex{Pattern: regexp.QuoteMeta(*area), Options: "i"}})
	}
	if city != nil {
		scope = append(scope, bson.E{Key: "city", Value: bson.Regex{Pattern: regexp.QuoteMeta(*city), Options: "i"}})
	}
	listFilter := append(bson.D{}, scope...)
	if category != nil {
		listFilter = append(listFilter, bson.E{Key: "$or", Value: bson.A{bson.D{{Key: "categories", Value: *category}}, bson.D{{Key: "category", Value: *category}}}})
	}
	col := h.DB.Collection("serviceproviders")
	cur, err := col.Find(c, listFilter, options.Find().SetSort(bson.D{{Key: "category", Value: 1}, {Key: "area", Value: 1}, {Key: "fullName", Value: 1}}).SetLimit(120))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var providers []provider
	if err := cur.All(c, &providers); err != nil {
		httpx.Fail(c, err)
		return
	}
	agg, err := col.Aggregate(c, bson.A{
		bson.D{{Key: "$match", Value: scope}},
		bson.D{{Key: "$project", Value: bson.D{{Key: "category", Value: bson.D{{Key: "$cond", Value: bson.A{
			bson.D{{Key: "$gt", Value: bson.A{bson.D{{Key: "$size", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$categories", bson.A{}}}}}}, 0}}},
			"$categories", bson.A{"$category"}}}}}}}},
		bson.D{{Key: "$unwind", Value: "$category"}},
		bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$category"}, {Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}}}}},
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var counts []struct {
		ID    string `bson:"_id"`
		Count int    `bson:"count"`
	}
	if err := agg.All(c, &counts); err != nil {
		httpx.Fail(c, err)
		return
	}
	total, err := col.CountDocuments(c, scope)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	byCat := ordered.Map{}
	for _, e := range counts {
		byCat = append(byCat, ordered.Pair{Key: e.ID, Value: e.Count})
	}
	out := make([]any, 0, len(providers))
	for _, p := range providers {
		out = append(out, ordered.Map{
			{Key: "area", Value: p.Area}, {Key: "availability", Value: p.Availability}, {Key: "categories", Value: p.cats()}, {Key: "category", Value: p.Category},
			{Key: "city", Value: p.city()}, {Key: "description", Value: p.Description}, {Key: "experience", Value: p.Experience}, {Key: "fullName", Value: p.FullName},
			{Key: "id", Value: p.ID.Hex()}, {Key: "photoAssetId", Value: oidOrUndefined(p.PhotoAssetID)}, {Key: "ratingSummary", Value: p.rating()}, {Key: "verified", Value: true},
		})
	}
	httpx.PublicCache(c)
	httpx.OK(c, ordered.Map{{Key: "countsByCategory", Value: byCat}, {Key: "providers", Value: out}, {Key: "total", Value: total}}, "Service providers loaded")
}

// ── the signed-in account's own application ──

func (h *Handler) me(c *gin.Context) {
	p, err := h.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	pr, err := h.findOwn(c, p.UserID, nil)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if pr == nil {
		httpx.OK(c, ordered.Map{{Key: "provider", Value: nil}}, "Service provider application loaded")
		return
	}
	if pr.UserID == nil {
		uid, _ := bson.ObjectIDFromHex(p.UserID)
		_, _ = h.DB.Collection("serviceproviders").UpdateOne(c, bson.D{{Key: "_id", Value: pr.ID}, {Key: "userId", Value: bson.D{{Key: "$exists", Value: false}}}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "userId", Value: uid}}}})
	}
	n, err := h.DB.Collection("serviceproviderdocuments").CountDocuments(c, bson.D{{Key: "isDeleted", Value: false}, {Key: "providerId", Value: pr.ID}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "provider", Value: ordered.Map{
		{Key: "area", Value: pr.Area}, {Key: "availability", Value: pr.Availability}, {Key: "categories", Value: pr.cats()}, {Key: "category", Value: pr.Category},
		{Key: "city", Value: pr.city()}, {Key: "description", Value: pr.Description}, {Key: "documentCount", Value: n}, {Key: "email", Value: pr.Email},
		{Key: "experience", Value: pr.Experience}, {Key: "fullName", Value: pr.FullName}, {Key: "id", Value: pr.ID.Hex()}, {Key: "phone", Value: pr.Phone},
		{Key: "rejectionReason", Value: pr.RejectionReason}, {Key: "status", Value: pr.Status}, {Key: "submittedAt", Value: iso(pr.CreatedAt)},
	}}}, "Service provider application loaded")
}
