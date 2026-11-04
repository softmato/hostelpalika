package users

import (
	"context"
	"log/slog"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

const (
	purgeBatch          = 100
	abandonedUploadAge  = 24 * time.Hour
	uploadVerifiedSince = "2026-08-06T00:00:00.000Z" // assets before this have no uploadCompletedAt by design
)

// purgeAccount is account-purge.service.ts purgeAccount: data about the person
// is erased, records of transactions they were party to stay with the person
// detached (ARCHITECTURE.md §13.2). Payments keep their dangling residentId.
func (d *Deletion) purgeAccount(ctx context.Context, userID bson.ObjectID, now time.Time) error {
	cur, err := d.DB.Collection("residents").Find(ctx, bson.D{{Key: "userId", Value: userID}}, options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		return err
	}
	var residents []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := cur.All(ctx, &residents); err != nil {
		return err
	}
	byUser := bson.D{{Key: "userId", Value: userID}}
	for _, coll := range []string{"attendancelogs", "consentlogs", "devicetokens", "notifications", "questioncallclicks", "sessions"} {
		if _, err := d.DB.Collection(coll).DeleteMany(ctx, byUser); err != nil {
			return err
		}
	}
	if len(residents) > 0 {
		ids := make(bson.A, len(residents))
		for i, r := range residents {
			ids[i] = r.ID
		}
		if _, err := d.DB.Collection("attendancelogs").DeleteMany(ctx, bson.D{{Key: "residentId", Value: bson.D{{Key: "$in", Value: ids}}}}); err != nil {
			return err
		}
	}
	byAuthor := bson.D{{Key: "authorId", Value: userID}}
	if _, err := d.DB.Collection("communityposts").UpdateMany(ctx, byAuthor,
		bson.D{{Key: "$set", Value: bson.D{{Key: "authorId", Value: nil}, {Key: "isAnonymous", Value: true}, {Key: "updatedAt", Value: now}}}}); err != nil {
		return err
	}
	// CommunityComment has no isAnonymous path: mongoose's strict update drops it.
	if _, err := d.DB.Collection("communitycomments").UpdateMany(ctx, byAuthor,
		bson.D{{Key: "$set", Value: bson.D{{Key: "authorId", Value: nil}, {Key: "updatedAt", Value: now}}}}); err != nil {
		return err
	}
	if _, err := d.DB.Collection("residents").DeleteMany(ctx, byUser); err != nil {
		return err
	}
	if _, err := d.DB.Collection("users").DeleteOne(ctx, bson.D{{Key: "_id", Value: userID}}); err != nil {
		return err
	}
	// Kept on purpose: the trail must record the erasure itself.
	if err := d.Audit.Write(ctx, audit.Entry{Action: "ACCOUNT_PURGED", ActorType: "SYSTEM", EntityType: "User", EntityID: userID.Hex()}); err != nil {
		slog.WarnContext(ctx, "Account purge audit not written", "userId", userID.Hex(), "error", err)
	}
	return nil
}

// RunPurge is runAccountDeletionPurge (the account-purge job): requests past
// their grace, then the abandoned-upload sweep.
func (d *Deletion) RunPurge(ctx context.Context) (ordered.Map, error) {
	now := d.Now().UTC().Truncate(time.Millisecond)
	cur, err := d.DB.Collection("accountdeletionrequests").Find(ctx, bson.D{
		{Key: "cancelled", Value: false}, {Key: "executed", Value: false},
		{Key: "scheduledDeletionAt", Value: bson.D{{Key: "$lte", Value: now}, {Key: "$ne", Value: nil}}},
	}, options.Find().SetLimit(purgeBatch))
	if err != nil {
		return nil, err
	}
	var due []struct {
		ID     bson.ObjectID `bson:"_id"`
		UserID bson.ObjectID `bson:"userId"`
	}
	if err := cur.All(ctx, &due); err != nil {
		return nil, err
	}
	purged, failed := 0, 0
	for _, r := range due {
		// Marked executed only after the purge, so a crash leaves it due.
		if err := d.purgeAccount(ctx, r.UserID, now); err != nil {
			slog.ErrorContext(ctx, "Account purge failed", "requestId", r.ID.Hex(), "error", err)
			failed++
			continue
		}
		at := time.Now().UTC().Truncate(time.Millisecond)
		if _, err := d.DB.Collection("accountdeletionrequests").UpdateByID(ctx, r.ID,
			bson.D{{Key: "$set", Value: bson.D{{Key: "executed", Value: true}, {Key: "executedAt", Value: at}, {Key: "updatedAt", Value: at}}}}); err != nil {
			slog.ErrorContext(ctx, "Account purge not marked executed", "requestId", r.ID.Hex(), "error", err)
			failed++
			continue
		}
		purged++
	}
	abandoned, err := d.sweepAbandonedUploads(ctx, now)
	if err != nil {
		return nil, err
	}
	return ordered.Map{{Key: "abandonedUploads", Value: abandoned}, {Key: "due", Value: len(due)}, {Key: "failed", Value: failed}, {Key: "purged", Value: purged}}, nil
}

// sweepAbandonedUploads marks presigns never followed by a PUT as DELETED; the
// row stays as the record that the upload was tried.
func (d *Deletion) sweepAbandonedUploads(ctx context.Context, now time.Time) (int64, error) {
	since, _ := time.Parse(time.RFC3339, uploadVerifiedSince)
	res, err := d.DB.Collection("fileassets").UpdateMany(ctx, bson.D{
		{Key: "createdAt", Value: bson.D{{Key: "$gt", Value: since}, {Key: "$lt", Value: now.Add(-abandonedUploadAge)}}},
		{Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"},
		{Key: "uploadCompletedAt", Value: bson.D{{Key: "$exists", Value: false}}},
	}, bson.D{{Key: "$set", Value: bson.D{{Key: "deletedAt", Value: now}, {Key: "isDeleted", Value: true}, {Key: "status", Value: "DELETED"}, {Key: "updatedAt", Value: now}}}})
	if err != nil {
		return 0, err
	}
	return res.ModifiedCount, nil
}
