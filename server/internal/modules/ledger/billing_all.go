package ledger

import (
	"context"
	"errors"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// RunBillingCycleForAll is runBillingCycleForAllHostels (the billing-cycle job):
// each live hostel billed for the period with no actor, residents told, and a
// hostel's failure reported in its row rather than stopping the rest.
func (e *Engine) RunBillingCycleForAll(ctx context.Context, period string) ([]ordered.Map, error) {
	cur, err := e.DB.Collection("hostels").Find(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var hostels []struct {
		ID   bson.ObjectID `bson:"_id"`
		Name *string       `bson:"name"`
	}
	if err := cur.All(ctx, &hostels); err != nil {
		return nil, err
	}
	out := make([]ordered.Map, 0, len(hostels))
	for _, h := range hostels {
		if ctx.Err() != nil {
			return out, ctx.Err()
		}
		var name any = ordered.Undefined
		if h.Name != nil {
			name = *h.Name
		}
		res, err := e.RunBillingCycle(ctx, BillingInput{HostelID: h.ID, Period: period}, nil)
		if err != nil {
			code := "BILLING_RUN_FAILED"
			var he *httpx.Error
			if errors.As(err, &he) {
				code = he.ErrorCode
			}
			out = append(out, ordered.Map{{Key: "billedCount", Value: 0}, {Key: "errorCode", Value: code}, {Key: "errorMessage", Value: err.Error()}, {Key: "failureCount", Value: 0},
				{Key: "hostelId", Value: h.ID.Hex()}, {Key: "hostelName", Value: name}, {Key: "skippedCount", Value: 0}, {Key: "totalBilled", Value: 0}})
			continue
		}
		e.NotifyInvoicesRaised(ctx, h.ID, period, res.Billed)
		out = append(out, ordered.Map{{Key: "billedCount", Value: len(res.Billed)}, {Key: "failureCount", Value: len(res.Failures)}, {Key: "hostelId", Value: h.ID.Hex()},
			{Key: "hostelName", Value: name}, {Key: "skippedCount", Value: len(res.Skipped)}, {Key: "totalBilled", Value: res.TotalBilled}})
	}
	return out, nil
}
