package main

import (
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
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

// The statement-file output must read through the real eSewa parser, the way
// ch 50a imports it: every row, credits and debits on the right side.
func TestEsewaStatementFileParses(t *testing.T) {
	now := time.Date(2026, 11, 23, 10, 0, 0, 0, nepalZone)
	csv := esewaCSV([]stmtLine{
		{at: now.Add(-20 * time.Hour), desc: "Fund Transferred by Nischal Adhikari", cr: 11000, resident: "Nischal Adhikari"},
		{at: now.Add(-30 * time.Hour), desc: "Fund Transferred by Ramila Basnet", cr: 2500},
		{at: now.Add(-9 * time.Hour), desc: "Paid for NEA ELECTRICITY", dr: 3420},
	}, now)
	p, err := finance.ResolveStmtParser("ESEWA", []byte(csv))
	if err != nil {
		t.Fatal(err)
	}
	tb, err := finance.ReadStmtTable([]byte(csv), p.Anchors)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := p.Parse(tb)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 {
		t.Fatalf("parsed %d rows, want 3:\n%s", len(rows), csv)
	}
	credits := 0
	for _, r := range rows {
		if r.Direction == "CREDIT" {
			credits++
		}
	}
	if credits != 2 {
		t.Fatalf("credits = %d, want 2: %+v", credits, rows)
	}
}
