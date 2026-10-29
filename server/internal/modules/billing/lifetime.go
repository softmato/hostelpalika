// Package billing: the public lifetime-deal counts so far (billing/lifetime.ts);
// plan checkout and hostel registration billing land with their routes.
package billing

import (
	"context"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/plans"
)

type Handler struct {
	db  *mongo.Database
	cfg *platformconfig.Service
}

func NewHandler(db *mongo.Database, cfg *platformconfig.Service) *Handler { return &Handler{db, cfg} }

func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.GET("/public/lifetime", h.lifetime)
}

// SoldLifetimeSeats is soldLifetimeSeats: paid lifetime subscriptions per plan,
// counted, never stored.
func SoldLifetimeSeats(ctx context.Context, db *mongo.Database) (map[string]int, error) {
	cur, err := db.Collection("hostelsubscriptions").Aggregate(ctx, mongo.Pipeline{
		{{Key: "$match", Value: bson.D{{Key: "lifetimeSince", Value: bson.D{{Key: "$type", Value: "date"}}}}}},
		{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$planId"}, {Key: "sold", Value: bson.D{{Key: "$sum", Value: 1}}}}}},
	})
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID   *string `bson:"_id"`
		Sold int     `bson:"sold"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := map[string]int{}
	for _, r := range rows {
		if r.ID != nil && *r.ID != "" {
			out[*r.ID] = r.Sold
		}
	}
	return out, nil
}

type lifetimeOffer struct {
	Left     int     `json:"left"`
	Monthly  float64 `json:"monthly"`
	PlanID   string  `json:"planId"`
	PlanName string  `json:"planName"`
	Price    int64   `json:"price"`
	Seats    int     `json:"seats"`
	Sold     int     `json:"sold"`
}

// LifetimeAvailability is getLifetimeAvailability's answer.
type LifetimeAvailability struct {
	EndsOn   string          `json:"endsOn"`
	Offers   []lifetimeOffer `json:"offers"`
	StartsOn string          `json:"startsOn"`
	Window   string          `json:"window"`
}

// Lifetime is getLifetimeAvailability: every priced offer whose tier still
// exists, with its seats counted.
func Lifetime(ctx context.Context, db *mongo.Database, cfg *platformconfig.Service, now time.Time) (*LifetimeAvailability, error) {
	dealRaw, err := cfg.Section(ctx, "lifetime")
	if err != nil {
		return nil, err
	}
	catalogRaw, err := cfg.Section(ctx, "plans")
	if err != nil {
		return nil, err
	}
	sold, err := SoldLifetimeSeats(ctx, db)
	if err != nil {
		return nil, err
	}
	var deal plans.Lifetime
	var catalog plans.Catalog
	if err := platformconfig.Decode(dealRaw, &deal); err != nil {
		return nil, err
	}
	if err := platformconfig.Decode(catalogRaw, &catalog); err != nil {
		return nil, err
	}
	out := &LifetimeAvailability{EndsOn: deal.EndsOn, Offers: []lifetimeOffer{}, StartsOn: deal.StartsOn, Window: plans.LifetimeWindow(deal, now)}
	for _, o := range deal.Offers {
		var plan *plans.Plan
		for i := range catalog.Plans {
			if catalog.Plans[i].ID == o.PlanID {
				plan = &catalog.Plans[i]
				break
			}
		}
		if plan == nil || plans.LifetimeOfferFor(deal, o.PlanID) == nil {
			continue
		}
		taken := sold[o.PlanID]
		out.Offers = append(out.Offers, lifetimeOffer{Left: plans.LifetimeSeatsLeft(o.Seats, taken), Monthly: plan.Monthly,
			PlanID: plan.ID, PlanName: plan.Name, Price: o.Price, Seats: o.Seats, Sold: taken})
	}
	return out, nil
}

func (h *Handler) lifetime(c *gin.Context) {
	l, err := Lifetime(c, h.db, h.cfg, time.Now())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	// A few seconds, not a minute: "3 seats left" is the number a visitor acts on.
	c.Header("Cache-Control", "public, s-maxage=10, stale-while-revalidate=60")
	httpx.OK(c, gin.H{"lifetime": l}, "Lifetime deal loaded")
}
