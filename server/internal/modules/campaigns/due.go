package campaigns

import (
	"context"
	"log/slog"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// DispatchDue is dispatchDueCampaigns (the notification-dispatch job): each due
// campaign is claimed out of SCHEDULED first, so two runs never send one twice.
func (s *Service) DispatchDue(ctx context.Context, now time.Time) (ordered.Map, error) {
	now = now.UTC().Truncate(time.Millisecond)
	coll := s.DB.Collection("notificationcampaigns")
	cur, err := coll.Find(ctx, bson.D{{Key: "scheduledFor", Value: bson.D{{Key: "$lte", Value: now}}}, {Key: "status", Value: "SCHEDULED"}},
		options.Find().SetSort(bson.D{{Key: "scheduledFor", Value: 1}}).SetLimit(50))
	if err != nil {
		return nil, err
	}
	var due []record
	if err := cur.All(ctx, &due); err != nil {
		return nil, err
	}
	dispatched, failed, recipients := 0, 0, 0
	for i := range due {
		r := &due[i]
		res, err := coll.UpdateOne(ctx, bson.D{{Key: "_id", Value: r.ID}, {Key: "status", Value: "SCHEDULED"}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "SENT"}, {Key: "sentAt", Value: now}, {Key: "updatedAt", Value: now}}}})
		if err != nil {
			return nil, err
		}
		if res.ModifiedCount == 0 {
			continue
		}
		n, err := s.dispatch(ctx, r)
		if err != nil {
			failed++
			slog.ErrorContext(ctx, "Scheduled campaign failed", "campaignId", r.ID.Hex(), "error", err)
			if _, uerr := coll.UpdateByID(ctx, r.ID, bson.D{{Key: "$set", Value: bson.D{{Key: "failureReason", Value: err.Error()}, {Key: "status", Value: "FAILED"}, {Key: "updatedAt", Value: time.Now().UTC().Truncate(time.Millisecond)}}}}); uerr != nil {
				return nil, uerr
			}
			continue
		}
		dispatched++
		recipients += n
	}
	return ordered.Map{{Key: "dispatched", Value: dispatched}, {Key: "failed", Value: failed}, {Key: "recipients", Value: recipients}, {Key: "scanned", Value: len(due)}}, nil
}
