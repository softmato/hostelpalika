package fixture

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// The superadmin's hostel queue (group 13): a hostel waiting for approval with its
// owner and application, a branch waiting (superadmin only), an archived hostel in
// its grace period and one whose grace ran out.
var (
	PlatHostelPending  = gid(13, 1)
	PlatOwnerPending   = gid(13, 2)
	PlatHostelArchived = gid(13, 3)
	PlatOwnerArchived  = gid(13, 4)
	PlatBranchPending  = gid(13, 5)
	PlatHostelOverdue  = gid(13, 6)
)

// ownBaseHostels fills the required and defaulted fields some base rows were
// written without (Hostel.ownerId, RatingReview.userId, …): the platform lists
// serialise every row, where a real row always has them.
func ownBaseHostels(ctx context.Context, db *mongo.Database) error {
	for hostel, owner := range map[bson.ObjectID]bson.ObjectID{HostelKyc: UserAdmin, HostelSuspended: UserWarden} {
		if _, err := db.Collection("hostels").UpdateOne(ctx, d{{Key: "_id", Value: hostel}}, d{{Key: "$set", Value: d{{Key: "ownerId", Value: owner}}}}); err != nil {
			return err
		}
	}
	// Schema defaults the base rows skipped, field by field where it is missing.
	for _, f := range []struct {
		coll, field string
		value       any
	}{
		{"hostels", "ownerId", UserAdmin}, {"hostels", "status", "DRAFT"}, {"hostels", "verificationStatus", "UNVERIFIED"},
		{"hostels", "createdAt", fixedAt}, {"hostels", "updatedAt", fixedAt},
		{"ratingreviews", "userId", UserResident}, {"sponsors", "kind", "COLLEGE"},
		{"hostelreferralcodes", "commissionType", "AMOUNT"}, {"hostelreferralcodes", "commissionValue", 0},
	} {
		if _, err := db.Collection(f.coll).UpdateMany(ctx, d{{Key: f.field, Value: d{{Key: "$exists", Value: false}}}}, d{{Key: "$set", Value: d{{Key: f.field, Value: f.value}}}}); err != nil {
			return err
		}
	}
	return nil
}

func init() {
	groupSeeds["platform-hostels"] = func(ctx context.Context, db *mongo.Database, now time.Time) error {
		if err := ownBaseHostels(ctx, db); err != nil {
			return err
		}
		day := 24 * time.Hour
		pending := hostelRow(PlatHostelPending, PlatOwnerPending, "Queue Hostel", "queue-hostel-kalanki", "Kalanki", 7000, 9000, fixedAt,
			e{Key: "status", Value: "PENDING_APPROVAL"}, e{Key: "verificationStatus", Value: "PENDING"}, e{Key: "parentHostelId", Value: nil},
			e{Key: "contact", Value: d{{Key: "email", Value: "queue-owner@contract.test"}, {Key: "phone", Value: "9800000131"}}})
		branch := hostelRow(PlatBranchPending, OwnerPublished, "Fixture Lakeside Third", "fixture-lakeside-third-balkhu", "Balkhu", 7000, 9000, fixedAt,
			e{Key: "status", Value: "PENDING_APPROVAL"}, e{Key: "verificationStatus", Value: "PENDING"}, e{Key: "parentHostelId", Value: HostelPublished})
		archived := hostelRow(PlatHostelArchived, PlatOwnerArchived, "Gone Hostel", "gone-hostel-chabahil", "Chabahil", 6000, 8000, fixedAt,
			e{Key: "isDeleted", Value: true}, e{Key: "deletedAt", Value: fixedAt}, e{Key: "archiveReason", Value: "Owner closed"},
			e{Key: "purgeScheduledAt", Value: now.Add(20 * day)})
		overdue := hostelRow(PlatHostelOverdue, PlatOwnerArchived, "Overdue Hostel", "overdue-hostel-chabahil", "Chabahil", 6000, 8000, fixedAt,
			e{Key: "isDeleted", Value: true}, e{Key: "deletedAt", Value: fixedAt}, e{Key: "archiveReason", Value: "Owner closed"},
			e{Key: "purgeScheduledAt", Value: now.Add(-day)})
		owner := ownerUser(PlatOwnerPending, "queue-owner@contract.test", "Queue Owner", PlatHostelPending, fixedAt)
		gone := ownerUser(PlatOwnerArchived, "gone-owner@contract.test", "Gone Owner", PlatHostelArchived, fixedAt)
		for i := range gone {
			if gone[i].Key == "hostelIds" {
				gone[i].Value = bson.A{}
			}
		}
		return insertAll(ctx, db, map[string][]any{
			"users":   append(platformStaff(fixedAt), owner, gone),
			"hostels": {pending, branch, archived, overdue},
			"hostelapplications": {d{{Key: "_id", Value: gid(13, 7)}, {Key: "hostelId", Value: PlatHostelPending}, {Key: "applicantId", Value: PlatOwnerPending}, {Key: "submittedBy", Value: PlatOwnerPending},
				{Key: "source", Value: "PUBLIC"}, {Key: "requestedDocuments", Value: bson.A{}}, {Key: "snapshot", Value: d{}}, {Key: "isDeleted", Value: false},
				{Key: "status", Value: "PENDING"}, {Key: "submittedAt", Value: fixedAt}, {Key: "createdAt", Value: fixedAt}, {Key: "updatedAt", Value: fixedAt}, {Key: "__v", Value: 0}}},
		})
	}
}
