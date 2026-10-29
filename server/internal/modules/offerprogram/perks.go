// Package offerprogram: so far the public perk catalogue
// (offer-program.service.ts getPublicOfferPerks); awards land with Phase 7.
package offerprogram

import (
	"context"
	"fmt"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

const platformName = "HostelPalika" // PLATFORM_NAME

type Handler struct{ db *mongo.Database }

func NewHandler(db *mongo.Database) *Handler { return &Handler{db} }

func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.GET("/public/offer-perks", h.perks)
}

// QuarterOf is offerQuarterOf: the BS quarter an instant falls in, "2083-Q2".
func QuarterOf(t time.Time) (string, error) {
	period, err := bs.PeriodOf(t)
	if err != nil {
		return "", err
	}
	y, m, _ := bs.PeriodParts(period)
	return fmt.Sprintf("%d-Q%d", y, (m+2)/3), nil
}

// QuarterLabel is offerQuarterBounds(q).label: "Shrawan – Aswin 2083 BS".
func QuarterLabel(quarter string) string {
	var y, q int
	_, _ = fmt.Sscanf(quarter, "%d-Q%d", &y, &q)
	first := (q-1)*3 + 1
	return fmt.Sprintf("%s – %s %d BS", bs.MonthName(first), bs.MonthName(first+2), y)
}

type perk struct {
	Description any    `json:"description"`
	GiftValue   any    `json:"giftValue"`
	ID          string `json:"id"`
	ImageURL    any    `json:"imageUrl"`
	Kind        any    `json:"kind"`
	Partner     any    `json:"partner"`
	PercentOff  any    `json:"percentOff"`
	Title       any    `json:"title"`
}

func or(r bson.Raw, key string, fallback any) any {
	v := r.Lookup(key)
	if v.Type == 0 || v.Type == bson.TypeNull {
		return fallback
	}
	return ordered.FromBSON(v)
}

func publicPerks(ctx context.Context, db *mongo.Database) (ordered.Map, error) {
	cur, err := db.Collection("offerperks").Find(ctx, bson.D{{Key: "isActive", Value: true}},
		options.Find().SetSort(bson.D{{Key: "sortOrder", Value: 1}, {Key: "createdAt", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []bson.Raw
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	perks := []perk{}
	for _, r := range rows {
		id, _ := r.Lookup("_id").ObjectIDOK()
		partner := or(r, "partner", "")
		if s, _ := partner.(string); s == "" { // `perk.partner || PLATFORM_NAME`
			partner = platformName
		}
		title := ordered.Undefined
		if v := r.Lookup("title"); v.Type != 0 {
			title = ordered.FromBSON(v)
		}
		perks = append(perks, perk{Description: or(r, "description", ""), GiftValue: or(r, "giftValue", nil), ID: id.Hex(),
			ImageURL: or(r, "imageUrl", ""), Kind: or(r, "kind", nil), Partner: partner, PercentOff: or(r, "percentOff", nil), Title: title})
	}
	quarter, err := QuarterOf(time.Now())
	if err != nil {
		return nil, err
	}
	return ordered.Map{{Key: "perks", Value: perks}, {Key: "quarter", Value: QuarterLabel(quarter)}}, nil
}

func (h *Handler) perks(c *gin.Context) {
	out, err := publicPerks(c, h.db)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.PublicCache(c)
	httpx.OK(c, out, "Offer perks loaded")
}
