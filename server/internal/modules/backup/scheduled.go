package backup

import (
	"context"
	"log/slog"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// scheduledBudget leaves the job's 300 s deadline room to close the last run.
const scheduledBudget = 240 * time.Second

// RunScheduled is runScheduledBackups (the customer-backup job): one backup a
// day per connected hostel, oldest first, inside the run's time.
func (h *Handler) RunScheduled(ctx context.Context) (ordered.Map, error) {
	started := time.Now()
	now := h.now()
	cur, err := h.DB.Collection("hostelbackups").Find(ctx, bson.D{
		{Key: "$or", Value: bson.A{bson.D{{Key: "lastRunAt", Value: nil}}, bson.D{{Key: "lastRunAt", Value: bson.D{{Key: "$exists", Value: false}}}},
			bson.D{{Key: "lastRunAt", Value: bson.D{{Key: "$lt", Value: now.Add(-20 * time.Hour)}}}}}},
		{Key: "drive.status", Value: bson.D{{Key: "$in", Value: bson.A{"CONNECTED", "QUOTA_FULL", "ERROR"}}}},
		{Key: "publicKey", Value: bson.D{{Key: "$exists", Value: true}, {Key: "$ne", Value: nil}}},
	}, options.Find().SetSort(bson.D{{Key: "lastRunAt", Value: 1}}).SetLimit(100).SetProjection(bson.D{{Key: "hostelId", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var due []struct {
		HostelID bson.ObjectID `bson:"hostelId"`
	}
	if err := cur.All(ctx, &due); err != nil {
		return nil, err
	}
	ran, failed := 0, 0
	for _, d := range due {
		if time.Since(started) > scheduledBudget || ctx.Err() != nil {
			break
		}
		allowed, err := h.planAllows(ctx, d.HostelID)
		if err != nil {
			return nil, err
		}
		if !allowed {
			continue
		}
		res, err := h.Run(ctx, d.HostelID, "SCHEDULE", "")
		ran++
		// TS let one hostel's refusal end the whole run; here it costs that hostel only.
		if err != nil {
			slog.ErrorContext(ctx, "Scheduled backup refused", "hostelId", d.HostelID.Hex(), "error", err)
			failed++
			continue
		}
		if !res.OK {
			failed++
		}
	}
	return ordered.Map{{Key: "due", Value: len(due)}, {Key: "failed", Value: failed}, {Key: "ran", Value: ran}}, nil
}
