package fixture

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Profile cases: 50 a published hostel on a rate card with its renames used up (owner 51,
// 52-58 its rows), 60 an unpriced draft (owner 61). Both carry a MANUAL pin, so a save that
// leaves the address alone never reaches a map provider.
func init() {
	extendGroup("admin-setup", func(now time.Time) map[string][]any {
		fixed := time.Date(2026, 9, 1, 6, 0, 0, 0, time.UTC)
		pub, pubOwner, plain, plainOwner := gid(4, 50), gid(4, 51), gid(4, 60), gid(4, 61)
		pin := bson.D{{Key: "address", Value: "Ward 4"}, {Key: "area", Value: "Baneshwor"}, {Key: "city", Value: "Kathmandu"}, {Key: "province", Value: "Bagmati"}, {Key: "landmark", Value: "Near the temple"}, {Key: "lat", Value: 27.7}, {Key: "lng", Value: 85.3}, {Key: "locationSource", Value: "MANUAL"}}
		room := func(kind string, rent int) bson.D {
			return bson.D{{Key: "roomType", Value: kind}, {Key: "bedsPerRoom", Value: 2}, {Key: "rooms", Value: 3}, {Key: "vacantBeds", Value: 1}, {Key: "monthlyRent", Value: rent}, {Key: "mealInclusion", Value: "Included"}}
		}
		photo := func(n int, kind, roomType string) bson.D {
			d := bson.D{{Key: "_id", Value: gid(4, n)}, {Key: "kind", Value: kind}, {Key: "url", Value: "https://img.contract.test/p.jpg"}}
			if roomType != "" {
				d = append(d, bson.E{Key: "roomType", Value: roomType})
			}
			return d
		}
		base := func(id, owner bson.ObjectID, name, slug, status string, extra ...bson.E) bson.D {
			d := bson.D{{Key: "_id", Value: id}, {Key: "name", Value: name}, {Key: "slug", Value: slug}, {Key: "ownerId", Value: owner}, {Key: "parentHostelId", Value: nil}, {Key: "isDeleted", Value: false},
				{Key: "status", Value: status}, {Key: "verificationStatus", Value: "VERIFIED"}, {Key: "location", Value: pin}, {Key: "createdAt", Value: fixed}, {Key: "updatedAt", Value: fixed}, {Key: "__v", Value: 0}}
			return append(d, extra...)
		}
		member := func(n int, hostel, user bson.ObjectID) bson.D {
			return bson.D{{Key: "_id", Value: gid(4, n)}, {Key: "hostelId", Value: hostel}, {Key: "userId", Value: user}, {Key: "role", Value: "HOSTEL_ADMIN"}, {Key: "status", Value: "ACTIVE"}, {Key: "createdAt", Value: fixed}}
		}
		return map[string][]any{
			"hostels": {
				base(pub, pubOwner, "Published Hostel", "published-hostel", "PUBLISHED", bson.E{Key: "nameChangeCount", Value: 2}, bson.E{Key: "panNumber", Value: "123456789"},
					bson.E{Key: "pricing", Value: bson.D{{Key: "monthlyRentMin", Value: 9000}}}, bson.E{Key: "roomConfigurations", Value: bson.A{room("Double", 9000), room("Triple", 7000), room("Single", 12000)}},
					bson.E{Key: "photos", Value: bson.A{photo(52, "ROOM", "Triple"), photo(53, "ROOM", "Double"), photo(54, "EXTERIOR", ""), photo(55, "EXTERIOR", ""), photo(56, "EXTERIOR", "")}}),
				base(plain, plainOwner, "Plain Hostel", "plain-hostel", "ACTIVE", bson.E{Key: "roomConfigurations", Value: bson.A{room("Double", 9000)}}),
			},
			"users": {
				setupUser(pubOwner, "pub.owner@contract.test", "HOSTEL_ADMIN", bson.A{pub}, now),
				setupUser(plainOwner, "plain.owner@contract.test", "HOSTEL_ADMIN", bson.A{plain}, now),
			},
			"hostelmembers": {member(57, pub, pubOwner), member(62, plain, plainOwner)},
			"feeschedules": {
				bson.D{{Key: "_id", Value: gid(4, 58)}, {Key: "hostelId", Value: pub}, {Key: "effectiveTo", Value: nil}, {Key: "rates", Value: bson.A{bson.D{{Key: "roomType", Value: "Double"}, {Key: "amount", Value: 9000}}}}, {Key: "createdAt", Value: fixed}},
			},
			"residents": {
				bson.D{{Key: "_id", Value: gid(4, 59)}, {Key: "hostelId", Value: pub}, {Key: "isDeleted", Value: false}, {Key: "roomType", Value: "Single"}, {Key: "status", Value: "ACTIVE"}, {Key: "createdAt", Value: fixed}},
			},
			"hostelrooms": {
				bson.D{{Key: "_id", Value: gid(4, 63)}, {Key: "hostelId", Value: pub}, {Key: "isDeleted", Value: false}, {Key: "roomType", Value: "Triple"}, {Key: "roomNumber", Value: "101"}, {Key: "createdAt", Value: fixed}},
			},
		}
	})
}
