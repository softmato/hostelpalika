package fixture

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Public-side fixture (Phase 3): hostels a visitor can see, one they cannot,
// reviews, a weekly routine, a badged plan and stored site-config rows.
var (
	HostelPublished = oid("a3") // published + verified, has a branch, a routine and reviews
	HostelBranch    = oid("a4") // branch of HostelPublished, same owner
	HostelCheap     = oid("a5") // published + verified, another owner, on the Gold plan
	HostelHidden    = oid("a6") // published but unverified: never public
	OwnerPublished  = oid("10")
	OwnerCheap      = oid("11")
)

// fixedAt is for timestamps an answer prints; relative ones would differ per run.
var fixedAt = time.Date(2026, 10, 1, 4, 15, 0, 0, time.UTC)

type (
	d = bson.D
	e = bson.E
)

func hostelRow(id, owner bson.ObjectID, name, slug, area string, rentMin, rentMax int, now time.Time, extra ...e) d {
	day := 24 * time.Hour
	row := d{{Key: "_id", Value: id}, {Key: "name", Value: name}, {Key: "slug", Value: slug}, {Key: "ownerId", Value: owner},
		{Key: "status", Value: "PUBLISHED"}, {Key: "verificationStatus", Value: "VERIFIED"}, {Key: "isDeleted", Value: false},
		{Key: "hostelType", Value: "BOYS"},
		{Key: "location", Value: d{{Key: "address", Value: "Ring Road"}, {Key: "area", Value: area}, {Key: "city", Value: "Kathmandu"},
			{Key: "province", Value: "Bagmati"}, {Key: "lat", Value: 27.7}, {Key: "lng", Value: 85.31}, {Key: "locationSource", Value: "MANUAL"}}},
		{Key: "pricing", Value: d{{Key: "currency", Value: "NPR"}, {Key: "monthlyRentMin", Value: rentMin}, {Key: "monthlyRentMax", Value: rentMax}, {Key: "admissionFee", Value: 2000}}},
		{Key: "facilities", Value: bson.A{"Wi-Fi", "Hot Water", "Meals"}},
		{Key: "food", Value: d{{Key: "hasVeg", Value: true}, {Key: "hasNonVeg", Value: false}, {Key: "mealsPerDay", Value: 3}}},
		{Key: "roomTypes", Value: bson.A{"Single", "Double"}},
		{Key: "rules", Value: bson.A{"Gate closes at 9 pm"}},
		{Key: "createdAt", Value: now.Add(-10 * day)}, {Key: "updatedAt", Value: now.Add(-day)}, {Key: "__v", Value: 0}}
	for _, x := range extra { // overrides keep their place, new keys append
		replaced := false
		for i := range row {
			if row[i].Key == x.Key {
				row[i].Value, replaced = x.Value, true
			}
		}
		if !replaced {
			row = append(row, x)
		}
	}
	return row
}

func publicDocs(now time.Time) map[string][]any {
	day := 24 * time.Hour
	return map[string][]any{
		"hostels": {
			hostelRow(HostelPublished, OwnerPublished, "Fixture Lakeside Hostel", "fixture-lakeside-hostel-baneshwor", "New Baneshwor", 9000, 15000, now,
				e{Key: "description", Value: "A test hostel near the lake."},
				e{Key: "contact", Value: d{{Key: "email", Value: "owner@contract.test"}, {Key: "phone", Value: "9800000001"}}},
				e{Key: "capacitySummary", Value: d{{Key: "totalBeds", Value: 30}, {Key: "totalRooms", Value: 12}, {Key: "vacantBeds", Value: 4}}},
				e{Key: "arrivalGuide", Value: d{{Key: "note", Value: "  Blue gate beside the pharmacy  "}, {Key: "photoUrl", Value: ""}}},
				e{Key: "photos", Value: bson.A{
					d{{Key: "_id", Value: oid("31")}, {Key: "kind", Value: "ROOM"}, {Key: "roomType", Value: "Single"}, {Key: "url", Value: "https://cdn.contract.test/room.webp"}, {Key: "alt", Value: "Room"}},
					d{{Key: "_id", Value: oid("32")}, {Key: "kind", Value: "INTERIOR"}, {Key: "url", Value: "https://cdn.contract.test/inside.webp"}},
					d{{Key: "_id", Value: oid("33")}, {Key: "kind", Value: "EXTERIOR"}, {Key: "url", Value: "https://cdn.contract.test/front.webp"}, {Key: "alt", Value: "Front"}},
				}},
				e{Key: "roomConfigurations", Value: bson.A{
					d{{Key: "_id", Value: oid("41")}, {Key: "roomType", Value: "Single"}, {Key: "bedsPerRoom", Value: 1}, {Key: "rooms", Value: 4}, {Key: "monthlyRent", Value: 15000}, {Key: "vacantBeds", Value: 1}, {Key: "mealInclusion", Value: "Optional"}},
					d{{Key: "_id", Value: oid("42")}, {Key: "roomType", Value: "Double"}, {Key: "bedsPerRoom", Value: 2}, {Key: "rooms", Value: 8}, {Key: "monthlyRent", Value: 9000}},
				}},
				e{Key: "nearbyPlaces", Value: bson.A{
					d{{Key: "name", Value: "Fixture Campus"}, {Key: "type", Value: "college"}, {Key: "distance", Value: 420.5}, {Key: "coordinates", Value: d{{Key: "lat", Value: 27.69}, {Key: "lng", Value: 85.33}}}},
					d{{Key: "name", Value: "No Coordinates Market"}, {Key: "type", Value: "market"}, {Key: "distance", Value: 800}},
				}}),
			hostelRow(HostelBranch, OwnerPublished, "Fixture Lakeside Branch", "fixture-lakeside-branch-koteshwor", "Koteshwor", 8000, 12000, now,
				e{Key: "parentHostelId", Value: HostelPublished},
				e{Key: "photos", Value: bson.A{d{{Key: "_id", Value: oid("34")}, {Key: "kind", Value: "INTERIOR"}, {Key: "url", Value: "https://cdn.contract.test/branch.webp"}}}}),
			hostelRow(HostelCheap, OwnerCheap, "Budget Fixture Hostel", "budget-fixture-hostel-kalanki", "Kalanki", 6000, 8000, now,
				e{Key: "hostelType", Value: "GIRLS"}, e{Key: "capacitySummary", Value: nil}, e{Key: "shortStays", Value: d{{Key: "enabled", Value: true}}}),
			hostelRow(HostelHidden, OwnerCheap, "Hidden Fixture Hostel", "hidden-fixture-hostel", "Kalanki", 5000, 7000, now,
				e{Key: "verificationStatus", Value: "PENDING"}),
		},
		"ratingreviews": {
			d{{Key: "_id", Value: oid("71")}, {Key: "hostelId", Value: HostelPublished}, {Key: "residentId", Value: oid("c1")}, {Key: "comment", Value: "Clean rooms."}, {Key: "overallRating", Value: 4}, {Key: "cleanlinessRating", Value: 5}, {Key: "foodRating", Value: 3}, {Key: "status", Value: "VISIBLE"}, {Key: "createdAt", Value: fixedAt.Add(-3 * day)}},
			d{{Key: "_id", Value: oid("72")}, {Key: "hostelId", Value: HostelPublished}, {Key: "residentId", Value: oid("c9")}, {Key: "overallRating", Value: 5}, {Key: "safetyRating", Value: 4}, {Key: "status", Value: "VISIBLE"}, {Key: "createdAt", Value: fixedAt.Add(-2 * day)}},
			d{{Key: "_id", Value: oid("73")}, {Key: "hostelId", Value: HostelPublished}, {Key: "residentId", Value: oid("c1")}, {Key: "overallRating", Value: 1}, {Key: "status", Value: "HIDDEN"}, {Key: "createdAt", Value: now.Add(-day)}},
		},
		"foodroutines": {
			d{{Key: "_id", Value: oid("81")}, {Key: "hostelId", Value: HostelPublished},
				{Key: "timings", Value: d{{Key: "BREAKFAST", Value: "7:00"}, {Key: "DINNER", Value: "19:30"}}},
				{Key: "meals", Value: bson.A{
					d{{Key: "dayOfWeek", Value: "SUNDAY"}, {Key: "mealType", Value: "BREAKFAST"}, {Key: "items", Value: bson.A{"Tea", "Bread"}}},
					d{{Key: "dayOfWeek", Value: "SUNDAY"}, {Key: "mealType", Value: "LUNCH"}, {Key: "items", Value: bson.A{}}},
					d{{Key: "dayOfWeek", Value: "MONDAY"}, {Key: "mealType", Value: "DINNER"}, {Key: "items", Value: bson.A{"Dal", "Bhat"}}, {Key: "note", Value: "Chicken on Fridays"}},
				}},
				{Key: "monthEndSpecial", Value: d{{Key: "items", Value: bson.A{"Sel roti"}}}},
				{Key: "createdAt", Value: fixedAt}, {Key: "updatedAt", Value: fixedAt}},
		},
		"platformsettings": {
			d{{Key: "_id", Value: oid("91")}, {Key: "key", Value: "hero"}, {Key: "value", Value: d{{Key: "headline", Value: "  Find a fixture hostel  "}, {Key: "zzStale", Value: true}, {Key: "subheadline", Value: "Stored by the contract fixture"}}}},
			d{{Key: "_id", Value: oid("92")}, {Key: "key", Value: "appNotice"}, {Key: "value", Value: d{{Key: "enabled", Value: true}, {Key: "title", Value: "Fixture notice"}, {Key: "link", Value: "http://not-https.test"}}}},
			// No dates, so the deal stays "open" whatever day the cases run.
			d{{Key: "_id", Value: oid("94")}, {Key: "key", Value: "lifetime"}, {Key: "value", Value: d{{Key: "enabled", Value: true},
				{Key: "offers", Value: bson.A{d{{Key: "planId", Value: "go"}, {Key: "price", Value: 9999}, {Key: "seats", Value: 2}},
					d{{Key: "planId", Value: "pro"}, {Key: "price", Value: 0}, {Key: "seats", Value: 5}},
					d{{Key: "planId", Value: "gone"}, {Key: "price", Value: 100}, {Key: "seats", Value: 5}}}}}}},
			d{{Key: "_id", Value: oid("93")}, {Key: "key", Value: "operations"}, {Key: "value", Value: d{{Key: "leaveHoldMinDays", Value: 5}, {Key: "trialDays", Value: 3}}}},
		},
		"offerperks": {
			d{{Key: "_id", Value: oid("61")}, {Key: "title", Value: "Rent off"}, {Key: "kind", Value: "FEE_OFF"}, {Key: "percentOff", Value: 10}, {Key: "isActive", Value: true}, {Key: "sortOrder", Value: 2}, {Key: "createdAt", Value: fixedAt}},
			d{{Key: "_id", Value: oid("62")}, {Key: "title", Value: "Gift card"}, {Key: "kind", Value: "GIFT"}, {Key: "giftValue", Value: 500}, {Key: "partner", Value: "Fixture Cafe"}, {Key: "description", Value: "A coffee"}, {Key: "imageUrl", Value: "https://cdn.contract.test/gift.webp"}, {Key: "isActive", Value: true}, {Key: "sortOrder", Value: 1}, {Key: "createdAt", Value: fixedAt}},
			d{{Key: "_id", Value: oid("63")}, {Key: "title", Value: "Retired"}, {Key: "kind", Value: "GIFT"}, {Key: "isActive", Value: false}, {Key: "sortOrder", Value: 0}, {Key: "createdAt", Value: fixedAt}},
		},
		"hostelsubscriptions": {
			d{{Key: "_id", Value: oid("b4")}, {Key: "hostelId", Value: HostelHidden}, {Key: "planId", Value: "go"},
				{Key: "status", Value: "ACTIVE"}, {Key: "lifetimeSince", Value: fixedAt}, {Key: "currentPeriodEnd", Value: time.Date(2099, 12, 31, 18, 14, 59, 999e6, time.UTC)}},
			d{{Key: "_id", Value: oid("b3")}, {Key: "hostelId", Value: HostelCheap}, {Key: "planId", Value: "max"},
				{Key: "status", Value: "ACTIVE"}, {Key: "currentPeriodEnd", Value: now.Add(20 * day)}},
		},
	}
}
