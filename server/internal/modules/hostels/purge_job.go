package hostels

import (
	"context"
	"log/slog"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

const archivePurgeBatch = 20

// RunArchivePurge is runHostelArchivePurge (the hostel-purge job): archived
// hostels past their grace are erased, then leave-request files past their keep.
func (p *Platform) RunArchivePurge(ctx context.Context, now time.Time) (ordered.Map, error) {
	now = now.UTC().Truncate(time.Millisecond)
	cur, err := p.DB.Collection("hostels").Find(ctx, bson.D{{Key: "isDeleted", Value: true}, {Key: "purgeScheduledAt", Value: bson.D{{Key: "$lte", Value: now}, {Key: "$ne", Value: nil}}}},
		options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}).SetLimit(archivePurgeBatch))
	if err != nil {
		return nil, err
	}
	var due []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := cur.All(ctx, &due); err != nil {
		return nil, err
	}
	purged, failed := 0, 0
	for _, h := range due {
		if _, err := p.PurgeHostel(ctx, h.ID, nil); err != nil {
			slog.ErrorContext(ctx, "Archived hostel not purged", "hostelId", h.ID.Hex(), "error", err)
			failed++
			continue
		}
		purged++
	}
	leave, err := p.sweepLeaveFiles(ctx, now)
	if err != nil {
		return nil, err
	}
	return ordered.Map{{Key: "due", Value: len(due)}, {Key: "failed", Value: failed}, {Key: "leaveFiles", Value: leave}, {Key: "purged", Value: purged}}, nil
}

// sweepLeaveFiles is runLeaveFilesSweep: a leaving hostel's kept files and
// export archives are erased once their keep runs out; a request is marked
// erased only when every object went.
func (p *Platform) sweepLeaveFiles(ctx context.Context, now time.Time) (ordered.Map, error) {
	cur, err := p.DB.Collection("hostelleaverequests").Find(ctx, bson.D{
		{Key: "$or", Value: bson.A{bson.D{{Key: "keptFiles.0", Value: bson.D{{Key: "$exists", Value: true}}}}, bson.D{{Key: "exportFiles.0", Value: bson.D{{Key: "$exists", Value: true}}}}}},
		{Key: "filesUntil", Value: bson.D{{Key: "$lte", Value: now}}},
	}, options.Find().SetProjection(bson.D{{Key: "keptFiles.bucket", Value: 1}, {Key: "keptFiles.key", Value: 1}, {Key: "exportFiles.bucket", Value: 1}, {Key: "exportFiles.key", Value: 1}}).SetLimit(archivePurgeBatch))
	if err != nil {
		return nil, err
	}
	type file struct {
		Bucket string `bson:"bucket"`
		Key    string `bson:"key"`
	}
	var due []struct {
		ID          bson.ObjectID `bson:"_id"`
		ExportFiles []file        `bson:"exportFiles"`
		KeptFiles   []file        `bson:"keptFiles"`
	}
	if err := cur.All(ctx, &due); err != nil {
		return nil, err
	}
	erased, failed := 0, 0
	for _, r := range due {
		missed := 0
		for _, f := range append(r.KeptFiles, r.ExportFiles...) {
			if p.R2 == nil {
				missed++
				continue
			}
			if err := p.R2.Delete(ctx, f.Bucket, f.Key); err != nil {
				slog.WarnContext(ctx, "Leave file not erased", "requestId", r.ID.Hex(), "error", err)
				missed++
			}
		}
		if missed > 0 {
			failed++
			continue
		}
		if _, err := p.DB.Collection("hostelleaverequests").UpdateByID(ctx, r.ID, bson.D{{Key: "$set", Value: bson.D{{Key: "exportFiles", Value: bson.A{}},
			{Key: "filesErasedAt", Value: now}, {Key: "keptFiles", Value: bson.A{}}, {Key: "updatedAt", Value: now}}}}); err != nil {
			return nil, err
		}
		erased++
	}
	return ordered.Map{{Key: "due", Value: len(due)}, {Key: "erased", Value: erased}, {Key: "failed", Value: failed}}, nil
}
