package fixture

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// Group 1 (testdata/contract/admin-residents): rooms, residents, resident lookup
// and scan, move events, inquiries, bookings.
//
//	hostel   1 an outsider's hostel (the admin has no access)
//	users   10 warden: registerResidents + manageRooms · 11 warden: viewPayments only
//	member  20 · 21 their grants in HostelKyc
//	room    30 "101" floor 1 Single x1 · 31 "102" floor 1 Double x2 · 32 "201" floor 2 Double x2 · 33 "G1" floor 0 Single x1 · 34 the outsider's room
//	resident 40 Asha in 102 · 41 Bimal in 101 · 42 Chandra, no room · 43 the outsider's · 44 Dev and 45 Esha fill 201
//	request  50 Asha asks for 201 (full) · 51 Bimal asks for G1
//	invoice  60 Asha owes 5000
//	resident 46 moved out with a checklist · 47 moved out without one
//	inquiry  70 new · 71 contacted · 72 the outsider's · 73 deleted
//	checklist 80 Fiona's move-out
func init() {
	groupSeeds["admin-residents"] = func(ctx context.Context, db *mongo.Database, now time.Time) error {
		start := time.Date(2026, 10, 20, 6, 0, 0, 0, time.UTC)
		ago := func(h int) time.Time { return start.Add(-time.Duration(h) * time.Hour) }
		warden := func(n int, email string, perms ...string) []bson.D {
			p := bson.A{}
			for _, x := range perms {
				p = append(p, x)
			}
			return []bson.D{
				{{Key: "_id", Value: gid(1, n)}, {Key: "name", Value: "Warden " + email}, {Key: "email", Value: email + "@contract.test"}, {Key: "emailVerified", Value: true}, {Key: "role", Value: "WARDEN"},
					{Key: "status", Value: "ACTIVE"}, {Key: "hostelIds", Value: bson.A{HostelKyc}}, {Key: "authProvider", Value: "LOCAL"}, {Key: "tokenVersion", Value: 0}, {Key: "isDeleted", Value: false}, {Key: "isDemoData", Value: false},
					{Key: "mustChangePassword", Value: false}, {Key: "createdAt", Value: ago(48)}, {Key: "updatedAt", Value: ago(48)}, {Key: "__v", Value: 0}},
				{{Key: "_id", Value: gid(1, n+10)}, {Key: "hostelId", Value: HostelKyc}, {Key: "userId", Value: gid(1, n)}, {Key: "role", Value: "WARDEN"}, {Key: "status", Value: "ACTIVE"}, {Key: "permissions", Value: p},
					{Key: "isDeleted", Value: false}, {Key: "createdAt", Value: ago(48)}, {Key: "updatedAt", Value: ago(48)}, {Key: "__v", Value: 0}},
			}
		}
		w10, w11 := warden(10, "rw10", "registerResidents", "manageRooms"), warden(11, "rw11", "viewPayments")
		outsider := gid(1, 1)
		room := func(n int, h bson.ObjectID, floor int, number, roomType string, beds int) bson.D {
			return bson.D{{Key: "_id", Value: gid(1, n)}, {Key: "hostelId", Value: h}, {Key: "floor", Value: floor}, {Key: "number", Value: number}, {Key: "roomType", Value: roomType}, {Key: "beds", Value: beds},
				{Key: "isDeleted", Value: false}, {Key: "createdBy", Value: UserAdmin}, {Key: "createdAt", Value: ago(72)}, {Key: "updatedAt", Value: ago(72)}, {Key: "__v", Value: 0}}
		}
		resident := func(n int, h bson.ObjectID, first, last, roomType string, roomN int, floor int, number string, extra ...bson.E) bson.D {
			d := bson.D{{Key: "_id", Value: gid(1, n)}, {Key: "hostelId", Value: h}, {Key: "firstName", Value: first}, {Key: "lastName", Value: last}, {Key: "phone", Value: "98000000" + string(rune('0'+n%10)) + "0"},
				{Key: "roomType", Value: roomType}, {Key: "moveInDate", Value: ago(24 * 20)}, {Key: "status", Value: "ACTIVE"}, {Key: "isDeleted", Value: false}, {Key: "depositAmount", Value: 0}}
			if roomN > 0 {
				d = append(d, bson.E{Key: "roomId", Value: gid(1, roomN)}, bson.E{Key: "floor", Value: floor}, bson.E{Key: "roomNumber", Value: number})
			}
			d = withOverrides(d, extra)
			return append(d, bson.E{Key: "createdAt", Value: ago(24 * 20)}, bson.E{Key: "updatedAt", Value: ago(24 * 20)}, bson.E{Key: "__v", Value: 0})
		}
		inquiry := func(n int, h bson.ObjectID, name, status string, hoursAgo int, extra ...bson.E) bson.D {
			d := bson.D{{Key: "_id", Value: gid(1, n)}, {Key: "hostelId", Value: h}, {Key: "name", Value: name}, {Key: "phone", Value: "98100000" + string(rune('0'+n%10)) + "0"}, {Key: "email", Value: "lead" + string(rune('0'+n%10)) + "@contract.test"},
				{Key: "message", Value: "Is a bed free?"}, {Key: "preferredRoomType", Value: "Single"}, {Key: "source", Value: "PUBLIC_WEBSITE"}, {Key: "status", Value: status}, {Key: "isDeleted", Value: false}}
			d = withOverrides(d, extra)
			return append(d, bson.E{Key: "createdAt", Value: ago(hoursAgo)}, bson.E{Key: "updatedAt", Value: ago(hoursAgo)}, bson.E{Key: "__v", Value: 0})
		}
		if _, err := db.Collection("hostels").UpdateOne(ctx, bson.D{{Key: "_id", Value: HostelKyc}}, bson.D{{Key: "$set", Value: bson.D{{Key: "roomConfigurations", Value: bson.A{
			bson.D{{Key: "roomType", Value: "Single"}, {Key: "monthlyRent", Value: 7000}, {Key: "bedsPerRoom", Value: 1}, {Key: "rooms", Value: 2}, {Key: "vacantBeds", Value: 1}, {Key: "mealInclusion", Value: "Included"}},
			bson.D{{Key: "roomType", Value: "Double Sharing"}, {Key: "monthlyRent", Value: 5000}, {Key: "bedsPerRoom", Value: 2}, {Key: "rooms", Value: 2}, {Key: "vacantBeds", Value: 2}, {Key: "mealInclusion", Value: "Included"}},
		}}, {Key: "capacitySummary", Value: bson.D{{Key: "totalRooms", Value: 4}, {Key: "totalBeds", Value: 6}, {Key: "vacantBeds", Value: 3}}}}}}); err != nil {
			return err
		}
		return insertAll(ctx, db, map[string][]any{
			"hostels": {bson.D{{Key: "_id", Value: outsider}, {Key: "name", Value: "Outsider Hostel"}, {Key: "slug", Value: "outsider-hostel"}, {Key: "parentHostelId", Value: nil}, {Key: "isDeleted", Value: false},
				{Key: "roomConfigurations", Value: bson.A{bson.D{{Key: "roomType", Value: "Single"}, {Key: "bedsPerRoom", Value: 1}, {Key: "rooms", Value: 1}, {Key: "vacantBeds", Value: 0}}}}, {Key: "createdAt", Value: ago(72)}}},
			"users":         {w10[0], w11[0]},
			"hostelmembers": {w10[1], w11[1]},
			"hostelrooms": {
				room(30, HostelKyc, 1, "101", "Single", 1), room(31, HostelKyc, 1, "102", "Double Sharing", 2), room(32, HostelKyc, 2, "201", "Double Sharing", 2),
				room(33, HostelKyc, 0, "G1", "Single", 1), room(34, outsider, 1, "101", "Single", 1),
			},
			"residents": {
				resident(40, HostelKyc, "Asha", "Rai", "Double Sharing", 31, 1, "102"),
				resident(41, HostelKyc, "Bimal", "Thapa", "Single", 30, 1, "101", bson.E{Key: "photoAssetId", Value: gid(1, 90)}),
				resident(42, HostelKyc, "Chandra", "Gurung", "Double Sharing", 0, 0, ""),
				resident(43, outsider, "Out", "Sider", "Single", 34, 1, "101"),
				resident(44, HostelKyc, "Dev", "Karki", "Double Sharing", 32, 2, "201"),
				resident(45, HostelKyc, "Esha", "Lama", "Double Sharing", 32, 2, "201"),
				resident(46, HostelKyc, "Fiona", "Moved", "Single", 0, 0, "", bson.E{Key: "status", Value: "MOVED_OUT"}),
				resident(47, HostelKyc, "Gita", "Gone", "Single", 0, 0, "", bson.E{Key: "status", Value: "MOVED_OUT"}),
			},
			"roomchangerequests": {bson.D{{Key: "_id", Value: gid(1, 51)}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: gid(1, 41)}, {Key: "fromRoomId", Value: gid(1, 30)}, {Key: "toRoomId", Value: gid(1, 33)},
				{Key: "status", Value: "PENDING"}, {Key: "requestedBy", Value: UserAdmin}, {Key: "createdAt", Value: ago(4)}, {Key: "updatedAt", Value: ago(4)}, {Key: "__v", Value: 0}}, bson.D{{Key: "_id", Value: gid(1, 50)}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: gid(1, 40)}, {Key: "fromRoomId", Value: gid(1, 31)}, {Key: "toRoomId", Value: gid(1, 32)},
				{Key: "note", Value: "closer to the stairs"}, {Key: "status", Value: "PENDING"}, {Key: "requestedBy", Value: UserAdmin}, {Key: "createdAt", Value: ago(5)}, {Key: "updatedAt", Value: ago(5)}, {Key: "__v", Value: 0}}},
			"moveoutchecklists": {bson.D{{Key: "_id", Value: gid(1, 80)}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: gid(1, 46)}, {Key: "completedAt", Value: ago(24 * 3)}, {Key: "createdAt", Value: ago(24 * 3)}, {Key: "updatedAt", Value: ago(24 * 3)}, {Key: "__v", Value: 0}}},
			"inquiries": {
				inquiry(70, HostelKyc, "Hari Sharma", "NEW", 6),
				inquiry(71, HostelKyc, "Indu Bhatta", "CONTACTED", 5),
				inquiry(72, outsider, "Jay Outside", "NEW", 4),
				inquiry(73, HostelKyc, "Kiran Deleted", "NEW", 3, bson.E{Key: "isDeleted", Value: true}),
			},
			"invoices": {bson.D{{Key: "_id", Value: gid(1, 60)}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: gid(1, 40)}, {Key: "period", Value: "2083-07"}, {Key: "status", Value: "OPEN"},
				{Key: "totalAmount", Value: 500000}, {Key: "dueDate", Value: ago(24)}, {Key: "lines", Value: bson.A{}}, {Key: "createdAt", Value: ago(48)}, {Key: "updatedAt", Value: ago(48)}, {Key: "__v", Value: 0}}},
		})
	}
}

// withOverrides replaces a key's value, or appends the key when the row has none.
func withOverrides(d bson.D, extra []bson.E) bson.D {
	for _, e := range extra {
		replaced := false
		for i := range d {
			if d[i].Key == e.Key {
				d[i].Value, replaced = e.Value, true
			}
		}
		if !replaced {
			d = append(d, e)
		}
	}
	return d
}
