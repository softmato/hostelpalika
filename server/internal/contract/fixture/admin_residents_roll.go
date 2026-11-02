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
		form := func(n int, h bson.ObjectID, first, status string, extra ...bson.E) bson.D {
			d := bson.D{{Key: "_id", Value: gid(1, n)}, {Key: "hostelId", Value: h}, {Key: "firstName", Value: first}, {Key: "lastName", Value: "Applicant"}, {Key: "phone", Value: "98500000" + string(rune('0'+n%10)) + "0"},
				{Key: "email", Value: first + "@contract.test"}, {Key: "residentType", Value: "STUDENT"}, {Key: "status", Value: status}, {Key: "submittedAt", Value: now.Add(-time.Duration(n) * time.Hour)}}
			d = withOverrides(d, extra)
			return append(d, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
		}
		if err := insertAll(ctx, db, map[string][]any{"admissionforms": {
			form(100, HostelKyc, "form1", "PENDING", bson.E{Key: "photoAssetId", Value: gid(1, 91)}, bson.E{Key: "documents", Value: bson.A{bson.D{{Key: "fileAssetId", Value: gid(1, 92)}, {Key: "kind", Value: "APPLICANT_ID"}}}}),
			form(101, HostelKyc, "form2", "PENDING"), form(102, HostelKyc, "form3", "DECLINED"), form(103, gid(1, 1), "form4", "PENDING"),
		}}); err != nil {
			return err
		}
		_, err := db.Collection("residents").UpdateOne(ctx, bson.D{{Key: "_id", Value: oid("c2")}}, bson.D{{Key: "$set", Value: bson.D{{Key: "isDeleted", Value: true}}}})
		return err
	}
}
