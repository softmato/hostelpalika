package main

import (
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// The demo seed writes to production: its plan and its hostel guard are checked here.
func TestDemoSeedPlan(t *testing.T) {
	demoID, _ := bson.ObjectIDFromHex("6affaa5751a57b56ba1f794d")
	if err := checkDemoHostel(demoID, demoSlug); err != nil {
		t.Fatalf("demo hostel refused: %v", err)
	}
	other, _ := bson.ObjectIDFromHex("6affaa5751a57b56ba1f7900")
	for _, c := range []struct {
		id   bson.ObjectID
		slug string
	}{{other, demoSlug}, {demoID, "education-light-hostel"}} {
		if checkDemoHostel(c.id, c.slug) == nil {
			t.Fatalf("hostel %s (%s) was not refused", c.id.Hex(), c.slug)
		}
	}

	used, phones := map[string]int{}, map[string]bool{}
	for i, r := range seedResidents {
		used[r.Room]++
		if r.Room == "101" || r.Room == "102" {
			t.Fatalf("%s is put in %s, which the live story keeps", r.First, r.Room)
		}
		if p := seedPhone(i); phones[p] || len(p) != 10 {
			t.Fatalf("phone %q repeated or malformed", p)
		} else {
			phones[p] = true
		}
	}
	for room, n := range used {
		if n > seedBeds[room] {
			t.Fatalf("room %s gets %d residents, has %d free beds", room, n, seedBeds[room])
		}
	}

	ahead := 0
	for i := range seedResidents {
		for m := 0; m < 4; m++ {
			for _, p := range rentPays(i, m, 4) {
				if p.share > 1 {
					ahead++
				}
				if m == 3 && p.day > 4 {
					t.Fatalf("resident %d pays on day %d of a month that is on day 4", i, p.day)
				}
			}
		}
	}
	if ahead != 1 {
		t.Fatalf("want exactly one advance payment, got %d", ahead)
	}
	if late := len(rentPays(3, 2, 4)) + len(rentPays(7, 2, 4)); late != 0 {
		t.Fatalf("the two late payers paid last month")
	}
}
