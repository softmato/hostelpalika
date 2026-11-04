package fixture

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// The admin-branches group: the owner's main hostel, one branch and a plan that
// allows three (Max). Ids from group 17.
//
//	hostel 2 main (owner UserAdmin, Max plan ACTIVE) · 3 branch · 4 another owner's
//	resident 10 in main · 11 in branch · complaint 20 in branch · document 30 on branch
func init() {
	extendGroup("admin-branches", func(now time.Time) map[string][]any {
		at := time.Date(2026, 9, 1, 6, 0, 0, 0, time.UTC)
		main, branch := gid(17, 2), gid(17, 3)
		hostel := func(id bson.ObjectID, name, slug, area string, parent any, owner bson.ObjectID) bson.D {
			return bson.D{{Key: "_id", Value: id}, {Key: "name", Value: name}, {Key: "slug", Value: slug}, {Key: "status", Value: "ACTIVE"}, {Key: "verificationStatus", Value: "VERIFIED"},
				{Key: "parentHostelId", Value: parent}, {Key: "isDeleted", Value: false}, {Key: "ownerId", Value: owner}, {Key: "panNumber", Value: "600111222"},
				{Key: "contact", Value: bson.D{{Key: "phone", Value: "9800000170"}}}, {Key: "location", Value: bson.D{{Key: "area", Value: area}, {Key: "city", Value: "Kathmandu"}}},
				{Key: "photos", Value: bson.A{bson.D{{Key: "kind", Value: "EXTERIOR"}, {Key: "url", Value: "https://cdn.contract.test/" + slug + ".jpg"}}}},
				{Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}
		}
		resident := func(n int, h bson.ObjectID, name string) bson.D {
			return bson.D{{Key: "_id", Value: gid(17, n)}, {Key: "hostelId", Value: h}, {Key: "firstName", Value: name}, {Key: "lastName", Value: "Branch"}, {Key: "phone", Value: "98000001" + string(rune('0'+n%10)) + "0"},
				{Key: "status", Value: "ACTIVE"}, {Key: "isDeleted", Value: false}, {Key: "moveInDate", Value: at}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}
		}
		return map[string][]any{
			"hostels": {hostel(main, "Main Hostel", "main-hostel", "Thamel", nil, UserAdmin), hostel(branch, "Main Hostel Baneshwor", "main-hostel-baneshwor", "Baneshwor", main, UserAdmin),
				hostel(gid(17, 4), "Other Hostel", "other-hostel", "Lalitpur", nil, UserPublic)},
			"hostelsubscriptions": {bson.D{{Key: "_id", Value: gid(17, 5)}, {Key: "hostelId", Value: main}, {Key: "status", Value: "ACTIVE"}, {Key: "planId", Value: "max"}, {Key: "planName", Value: "Max"},
				{Key: "cycle", Value: "monthly"}, {Key: "cycleMonths", Value: 1}, {Key: "source", Value: "PUBLIC"}, {Key: "currentPeriodEnd", Value: now.Add(60 * 24 * time.Hour)}, {Key: "dueBy", Value: nil},
				{Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}},
			"residents": {resident(10, main, "Mina"), resident(11, branch, "Bina")},
			"complaints": {bson.D{{Key: "_id", Value: gid(17, 20)}, {Key: "hostelId", Value: branch}, {Key: "residentId", Value: gid(17, 11)}, {Key: "title", Value: "Tap leaks"}, {Key: "category", Value: "MAINTENANCE"},
				{Key: "status", Value: "OPEN"}, {Key: "priority", Value: "MEDIUM"}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}},
		}
	})
}
