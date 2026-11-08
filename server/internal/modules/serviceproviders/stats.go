package serviceproviders

import (
	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"golang.org/x/sync/errgroup"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// stats is getPublicServiceProviderStats: the three numbers on the public
// Service providers page (PARITY §9). Areas are free text, so they are trimmed
// and lower-cased before counting; the approval time is a median, so one slow
// application does not speak for the rest.
func (h *Handler) stats(c *gin.Context) {
	col := h.DB.Collection("serviceproviders")
	scope := bson.D{{Key: "isDeleted", Value: false}, {Key: "status", Value: "APPROVED"}}
	var (
		total int64
		areas []struct {
			Count int64 `bson:"count"`
		}
		days []struct {
			Days []float64 `bson:"days"`
		}
	)
	g, ctx := errgroup.WithContext(c)
	g.Go(func() (err error) { total, err = col.CountDocuments(ctx, scope); return })
	g.Go(func() error {
		cur, err := col.Aggregate(ctx, bson.A{
			bson.D{{Key: "$match", Value: scope}},
			bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: bson.D{{Key: "$toLower", Value: bson.D{{Key: "$trim", Value: bson.D{{Key: "input", Value: "$area"}}}}}}}}}},
			bson.D{{Key: "$count", Value: "count"}},
		})
		if err != nil {
			return err
		}
		return cur.All(ctx, &areas)
	})
	g.Go(func() error {
		cur, err := col.Aggregate(ctx, bson.A{
			bson.D{{Key: "$match", Value: append(append(bson.D{}, scope...), bson.E{Key: "approvedAt", Value: bson.D{{Key: "$exists", Value: true}, {Key: "$ne", Value: nil}}})}},
			bson.D{{Key: "$project", Value: bson.D{{Key: "days", Value: bson.D{{Key: "$divide", Value: bson.A{
				bson.D{{Key: "$subtract", Value: bson.A{"$approvedAt", "$createdAt"}}}, 1000 * 60 * 60 * 24}}}}}}},
			bson.D{{Key: "$sort", Value: bson.D{{Key: "days", Value: 1}}}},
			bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: nil}, {Key: "days", Value: bson.D{{Key: "$push", Value: "$days"}}}}}},
		})
		if err != nil {
			return err
		}
		return cur.All(ctx, &days)
	})
	if err := g.Wait(); err != nil {
		httpx.Fail(c, err)
		return
	}
	var areaCount int64
	if len(areas) > 0 {
		areaCount = areas[0].Count
	}
	var median any
	if len(days) > 0 && len(days[0].Days) > 0 {
		d, mid := days[0].Days, len(days[0].Days)/2
		if len(d)%2 == 1 {
			median = d[mid]
		} else {
			median = (d[mid-1] + d[mid]) / 2
		}
	}
	httpx.PublicCache(c)
	httpx.OK(c, ordered.Map{{Key: "stats", Value: ordered.Map{
		{Key: "areaCount", Value: areaCount},
		{Key: "medianApprovalDays", Value: median},
		{Key: "totalProviders", Value: total},
	}}}, "Service provider stats loaded")
}
