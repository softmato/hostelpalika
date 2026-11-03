package fixture

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// The platform staff (group 10), seeded by every platform-* group.
var (
	UserSuperadmin = gid(10, 1)
	UserModerator  = gid(10, 2)
)

func platformStaff(now time.Time) []any {
	staff := func(id bson.ObjectID, email, name, role string) d {
		row := ownerUser(id, email, name, HostelPublished, now)
		for i := range row {
			switch row[i].Key {
			case "role":
				row[i].Value = role
			case "hostelIds":
				row[i].Value = bson.A{}
			}
		}
		return row
	}
	return []any{staff(UserSuperadmin, "super@contract.test", "Contract Super", "SUPERADMIN"),
		staff(UserModerator, "moderator@contract.test", "Contract Moderator", "PLATFORM_MODERATOR")}
}

func init() {
	groupSeeds["platform"] = func(ctx context.Context, db *mongo.Database, now time.Time) error {
		// The ID card owners too: expert consultation needs a completed profile.
		if err := groupSeeds["account-identity"](ctx, db, now); err != nil {
			return err
		}
		return insertAll(ctx, db, map[string][]any{"users": platformStaff(fixedAt)})
	}

}
