package hostels

import (
	_ "embed"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// demo-hostels.json is a byte copy of apps/web/src/modules/hostels/demo-hostels.json
// (TestDemoHostelsCopy fails when they drift): sample listings merged into the
// public listing, page and compare, never stored. Emptying it to [] removes them.
//
//go:embed demo-hostels.json
var demoJSON []byte

type demoHostel struct {
	raw    bson.Raw
	id     string
	slug   string
	rating ordered.Map
	// the fields demoHostelsMatching filters on
	name, area, city, hostelType string
	facilities, roomTypes        []string
	hasVeg, hasNonVeg, short     bool
	rentMin, rentMax             float64
}

var demoHostels = loadDemoHostels()

// loadDemoHostels shapes each row as a stored hostel (demo-hostels.ts): the
// row, then _id, isDemoData, ownerId (= _id), PUBLISHED, VERIFIED.
func loadDemoHostels() []demoHostel {
	v, err := ordered.FromJSON(demoJSON)
	if err != nil {
		panic("demo-hostels.json: " + err.Error())
	}
	var out []demoHostel
	for _, r := range v.([]any) {
		row := r.(ordered.Map)
		idHex, _ := row.Get("_id")
		id, err := bson.ObjectIDFromHex(idHex.(string))
		if err != nil {
			panic("demo-hostels.json: " + err.Error())
		}
		doc := ordered.ToBSON(row.Delete("_id")).(bson.D)
		doc = append(doc, bson.E{Key: "_id", Value: id}, bson.E{Key: "isDemoData", Value: true}, bson.E{Key: "ownerId", Value: id},
			bson.E{Key: "status", Value: "PUBLISHED"}, bson.E{Key: "verificationStatus", Value: "VERIFIED"})
		raw, err := bson.Marshal(doc)
		if err != nil {
			panic(err)
		}
		d := demoHostel{raw: raw, id: id.Hex()}
		h := hostelDoc{raw}
		d.slug, d.name = h.str("slug"), h.str("name")
		d.area, d.city, d.hostelType = h.str("location", "area"), h.str("location", "city"), h.str("hostelType")
		d.facilities, d.roomTypes = h.strs("facilities"), h.strs("roomTypes")
		d.hasVeg, d.hasNonVeg, d.short = h.boolean("food", "hasVeg"), h.boolean("food", "hasNonVeg"), h.boolean("shortStays", "enabled")
		d.rentMin, d.rentMax = h.num("pricing", "monthlyRentMin"), h.num("pricing", "monthlyRentMax")
		if rt, ok := row.Get("rating"); ok {
			d.rating, _ = rt.(ordered.Map)
		}
		out = append(out, d)
	}
	return out
}

// findDemoHostel is by slug or id — the two references the public routes accept.
func findDemoHostel(ref string) *demoHostel {
	for i := range demoHostels {
		if demoHostels[i].slug == ref || demoHostels[i].id == ref {
			return &demoHostels[i]
		}
	}
	return nil
}

// IsDemoRef is whether ref (slug or id) names a sample listing.
func IsDemoRef(ref string) bool { return findDemoHostel(ref) != nil }

func demoRating(id string) ordered.Map {
	for _, d := range demoHostels {
		if d.id == id {
			return d.rating
		}
	}
	return nil
}

func has(value, wanted string) bool {
	return strings.Contains(strings.ToLower(value), strings.ToLower(wanted))
}

// matches is demoHostelsMatching: the listing's Mongo filter, applied to a sample row.
func (d demoHostel) matches(q ListQuery) bool {
	for _, f := range q.facilities() {
		if !contains(d.facilities, f) {
			return false
		}
	}
	return (q.Q == nil || has(d.name, *q.Q) || has(d.area, *q.Q)) &&
		(q.Area == nil || has(d.area, *q.Area)) &&
		(q.City == nil || strings.EqualFold(d.city, *q.City)) &&
		(q.Type == nil || d.hostelType == *q.Type) &&
		(q.Food == nil || *q.Food != "veg" || d.hasVeg) &&
		(q.Food == nil || *q.Food != "non-veg" || d.hasNonVeg) &&
		(q.RoomType == nil || contains(d.roomTypes, *q.RoomType)) &&
		(q.MinPrice == nil || d.rentMax >= *q.MinPrice) &&
		(q.MaxPrice == nil || d.rentMin <= *q.MaxPrice) &&
		(q.Stay == nil || d.short)
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
