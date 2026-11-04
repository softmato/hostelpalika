package fixture

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// The admin-notice-pushes group: a hostel past KYC (the base KYC hostel refuses
// writes) with one resident to send to. Ids from group 18.
//
//	hostel 2 (owner UserAdmin) · resident 10 · other owner's hostel 3
func init() {
	extendGroup("admin-notice-pushes", func(now time.Time) map[string][]any {
		at := time.Date(2026, 9, 1, 6, 0, 0, 0, time.UTC)
		hostel := func(id bson.ObjectID, name, slug string, owner bson.ObjectID) bson.D {
			return bson.D{{Key: "_id", Value: id}, {Key: "name", Value: name}, {Key: "slug", Value: slug}, {Key: "status", Value: "ACTIVE"}, {Key: "parentHostelId", Value: nil},
				{Key: "isDeleted", Value: false}, {Key: "ownerId", Value: owner}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}
		}
		return map[string][]any{
			"hostels": {hostel(gid(18, 2), "Push Hostel", "push-hostel", UserAdmin), hostel(gid(18, 3), "Other Push Hostel", "other-push-hostel", UserPublic)},
			"residents": {bson.D{{Key: "_id", Value: gid(18, 10)}, {Key: "hostelId", Value: gid(18, 2)}, {Key: "firstName", Value: "Puja"}, {Key: "lastName", Value: "Push"}, {Key: "phone", Value: "9800000180"},
				{Key: "status", Value: "ACTIVE"}, {Key: "isDeleted", Value: false}, {Key: "moveInDate", Value: at}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}},
		}
	})
}
