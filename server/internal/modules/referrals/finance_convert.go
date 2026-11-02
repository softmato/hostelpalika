package referrals

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// MarkConverted is markReferralConverted: a referred resident counts once real money is
// verified. Idempotent, and a failure never reaches the payment that triggered it.
func MarkConverted(ctx context.Context, db *mongo.Database, hostel, resident, payment bson.ObjectID) {
	at := time.Now().UTC().Truncate(time.Millisecond)
	var row struct {
		Code bson.ObjectID `bson:"referralCodeId"`
	}
	err := db.Collection("referrals").FindOneAndUpdate(ctx, bson.D{{Key: "converted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: false}, {Key: "joinedResidentId", Value: resident}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "converted", Value: true}, {Key: "convertedAt", Value: at}, {Key: "convertedPaymentId", Value: payment}, {Key: "updatedAt", Value: at}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return
	}
	if err == nil {
		_, err = db.Collection("referralcodes").UpdateOne(ctx, bson.D{{Key: "_id", Value: row.Code}}, bson.D{{Key: "$inc", Value: bson.D{{Key: "convertedCount", Value: 1}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: at}}}})
	}
	if err != nil {
		slog.WarnContext(ctx, "referral conversion failed", "error", err)
	}
}
