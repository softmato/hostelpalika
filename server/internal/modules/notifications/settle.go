package notifications

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// SettleNight is settleNightStatusNotifications: tonight's prompt rows show the
// current answer, on every answer; older nights' rows are dismissed.
func (s *Service) SettleNight(ctx context.Context, userID, night string, note, reasonCode *string, status string) error {
	uid, err := httpx.OID(userID, "user id")
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	coll := s.DB.Collection("notifications")
	mine := bson.D{{Key: "category", Value: "NIGHT_STATUS"}, {Key: "kind", Value: "ACTION"}, {Key: "userId", Value: uid}}
	// An undefined inside a Mixed value reaches Mongo as null (TS passes the object as is).
	answer := bson.D{{Key: "note", Value: note}, {Key: "reasonCode", Value: reasonCode}, {Key: "status", Value: status}}
	tonight, err := coll.UpdateMany(ctx, append(append(bson.D{}, mine...), bson.E{Key: "data.night", Value: night}),
		bson.D{{Key: "$set", Value: bson.D{{Key: "actionState", Value: "COMPLETED"}, {Key: "actionTakenAt", Value: now}, {Key: "actionTakenKey", Value: status},
			{Key: "data.answer", Value: answer}, {Key: "readAt", Value: now}, {Key: "updatedAt", Value: now}}}})
	if err != nil {
		return err
	}
	older, err := coll.UpdateMany(ctx, append(append(bson.D{}, mine...), bson.E{Key: "actionState", Value: "PENDING"}, bson.E{Key: "data.night", Value: bson.D{{Key: "$ne", Value: night}}}),
		bson.D{{Key: "$set", Value: bson.D{{Key: "actionState", Value: "DISMISSED"}, {Key: "actionTakenAt", Value: now}, {Key: "readAt", Value: now}, {Key: "updatedAt", Value: now}}}})
	if err != nil {
		return err
	}
	if tonight.ModifiedCount+older.ModifiedCount > 0 {
		s.RT.PublishNotificationUpdated(ctx, userID, "all")
	}
	return nil
}

// SettleAction is settleActionNotifications: the waiting rows about one thing leave
// every recipient's queue once it is dealt with. Best effort, as every caller treats it.
func (s *Service) SettleAction(ctx context.Context, category string, data bson.D, key string) {
	filter := bson.D{{Key: "actionState", Value: "PENDING"}, {Key: "category", Value: category}, {Key: "kind", Value: "ACTION"}}
	for _, e := range data {
		filter = append(filter, bson.E{Key: "data." + e.Key, Value: e.Value})
	}
	coll := s.DB.Collection("notifications")
	res := coll.Distinct(ctx, "userId", filter)
	var users []bson.ObjectID
	if res.Err() != nil || res.Decode(&users) != nil || len(users) == 0 {
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := coll.UpdateMany(ctx, filter, bson.D{{Key: "$set", Value: bson.D{{Key: "actionState", Value: "COMPLETED"}, {Key: "actionTakenAt", Value: now}, {Key: "actionTakenKey", Value: key}, {Key: "readAt", Value: now}, {Key: "updatedAt", Value: now}}}}); err != nil {
		return
	}
	for _, id := range users {
		s.RT.PublishNotificationUpdated(ctx, id.Hex(), "all")
	}
}
