package fixture

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// Group admin-residents-roll (testdata/contract/admin-residents-roll): the
// admin-residents seed with the admin's hostel KYC-approved, so the
// registerResidents writes open (HostelKyc is locked by default), and the base
// seed's desk-intake row (no moveInDate: the TS serializer throws on it)
// soft-deleted, because these cases read whole rolls.
func init() {
	groupSeeds["admin-residents-roll"] = func(ctx context.Context, db *mongo.Database, now time.Time) error {
		if err := groupSeeds["admin-residents"](ctx, db, now); err != nil {
			return err
		}
		if _, err := db.Collection("hostels").UpdateOne(ctx, bson.D{{Key: "_id", Value: HostelKyc}}, bson.D{{Key: "$set", Value: bson.D{{Key: "kyc.status", Value: "APPROVED"}}}}); err != nil {
			return err
		}
		_, err := db.Collection("residents").UpdateOne(ctx, bson.D{{Key: "_id", Value: oid("c2")}}, bson.D{{Key: "$set", Value: bson.D{{Key: "isDeleted", Value: true}}}})
		return err
	}
}
