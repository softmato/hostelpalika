package hostels

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// spec is one Hostel schema path: its default (when it has one) and, for a
// nested object, the paths inside it. Order is the schema's.
type spec struct {
	key    string
	def    any
	hasDef bool
	nested []spec
}

func dflt(key string, v any) spec     { return spec{key: key, def: v, hasDef: true} }
func plain(key string) spec           { return spec{key: key} }
func obj(key string, in ...spec) spec { return spec{key: key, nested: in} }

var hostelSpec = []spec{
	plain("name"), plain("slug"), plain("referencePrefix"), plain("description"), plain("ownerId"),
	dflt("parentHostelId", nil),
	obj("location", dflt("area", ""), dflt("city", "Kathmandu"), plain("province"), plain("address"), plain("lat"), plain("lng"),
		dflt("locationSource", "GEOCODED"), plain("landmark"), plain("mapLink")),
	obj("contact", plain("phone"), plain("email"), plain("alternatePhone")),
	plain("panNumber"), dflt("hostelType", "CO_LIVING"),
	obj("pricing", dflt("currency", "NPR"), plain("monthlyRentMin"), plain("monthlyRentMax"), plain("admissionFee"), plain("formFee")),
	plain("securityDeposit"), dflt("facilities", bson.A{}), dflt("roomTypes", bson.A{}), dflt("roomConfigurations", bson.A{}),
	obj("food", plain("mealsPerDay"), dflt("hasVeg", true), dflt("hasNonVeg", true), plain("notes")),
	dflt("rules", bson.A{}), dflt("photos", bson.A{}), dflt("nameChangeCount", 0), dflt("publicViewCount", 0),
	plain("totalFloors"), plain("yearEstablished"),
	obj("arrivalGuide", plain("note"), plain("photoUrl")),
	obj("capacitySummary", plain("totalRooms"), plain("totalBeds"), plain("vacantBeds")),
	dflt("nearbyPlaces", bson.A{}), plain("nearbyPlacesLastUpdated"),
	dflt("status", "DRAFT"), dflt("verificationStatus", "UNVERIFIED"), plain("createdBy"), plain("updatedBy"),
	dflt("isDemoData", false), plain("demoDataLabel"), dflt("isDeleted", false), plain("deletedAt"), plain("deletedBy"), plain("purgeScheduledAt"), plain("archiveReason"),
	obj("suspension", dflt("graceEndsAt", nil), dflt("reason", nil), dflt("startedAt", nil), dflt("startedBy", nil)),
	obj("shortStays", dflt("enabled", false), dflt("minNights", 1), dflt("rates", bson.A{})),
	obj("kyc", dflt("required", false), dflt("status", nil), dflt("submittedAt", nil), dflt("trialEndsAt", nil), dflt("reviewedAt", nil), dflt("reviewedBy", nil), dflt("note", nil)),
	obj("bookingPause", dflt("pausedAt", nil), dflt("pausedBy", nil), dflt("reason", nil), dflt("resumedAt", nil)),
}

func lookup(d bson.D, key string) (any, bool) {
	for _, e := range d {
		if e.Key == key {
			return e.Value, true
		}
	}
	return nil, false
}

// build writes explicit over the schema's defaults, in schema order, as
// mongoose's `create` does; a nested object left empty is dropped (minimize).
func build(specs []spec, explicit bson.D) bson.D { return buildAt(specs, explicit, false) }

// buildAt: inside a nested object mongoose sets the given paths first and
// fills the defaults after them; at the top level defaults sit in place.
func buildAt(specs []spec, explicit bson.D, nested bool) bson.D {
	out := bson.D{}
	var late bson.D
	for _, s := range specs {
		v, given := lookup(explicit, s.key)
		switch {
		case s.nested != nil:
			var sub bson.D
			if given {
				sub, _ = v.(bson.D)
			}
			if inner := buildAt(s.nested, sub, true); len(inner) > 0 {
				out = append(out, bson.E{Key: s.key, Value: inner})
			}
		case given:
			out = append(out, bson.E{Key: s.key, Value: v})
		case s.hasDef && nested:
			late = append(late, bson.E{Key: s.key, Value: s.def})
		case s.hasDef:
			out = append(out, bson.E{Key: s.key, Value: s.def})
		}
	}
	return append(out, late...)
}

// NewHostelDoc is HostelModel.create's document: _id, the fields over the
// schema defaults in schema order, the timestamps and __v.
func NewHostelDoc(id bson.ObjectID, fields bson.D, now time.Time) bson.D {
	doc := append(bson.D{{Key: "_id", Value: id}}, build(hostelSpec, fields)...)
	return append(doc, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
}
