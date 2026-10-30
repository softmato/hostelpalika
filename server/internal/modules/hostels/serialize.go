package hostels

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

func rawDate(v bson.RawValue) any {
	if t, ok := v.TimeOK(); ok {
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return nil
}

func rawStr(v bson.RawValue, def string) string {
	if s, ok := v.StringValueOK(); ok {
		return s
	}
	return def
}

func rawNum(v bson.RawValue, def float64) float64 {
	switch v.Type {
	case bson.TypeDouble:
		return v.Double()
	case bson.TypeInt32:
		return float64(v.Int32())
	case bson.TypeInt64:
		return float64(v.Int64())
	}
	return def
}

func rawID(v bson.RawValue) any {
	if id, ok := v.ObjectIDOK(); ok {
		return id.Hex()
	}
	return ordered.Undefined
}

// obj is `hostel.field ?? {}`, as lean + JSON.stringify writes the stored object.
func objOr(raw bson.Raw, key string) any {
	if v := raw.Lookup(key); v.Type == bson.TypeEmbeddedDocument {
		return ordered.FromBSON(v)
	}
	return ordered.Map{}
}

func strList(raw bson.Raw, key string) []any {
	out := []any{}
	if arr, ok := raw.Lookup(key).ArrayOK(); ok {
		vals, _ := arr.Values()
		for _, v := range vals {
			out = append(out, ordered.FromBSON(v))
		}
	}
	return out
}

// SerializeHostel is serializeHostel over a lean hostel document: the shape every
// admin portal reads.
func SerializeHostel(h bson.Raw, now time.Time) ordered.Map {
	note := valid.Trim(rawStr(h.Lookup("arrivalGuide", "note"), ""))
	photoURL := valid.Trim(rawStr(h.Lookup("arrivalGuide", "photoUrl"), ""))
	var guide any
	if note != "" || photoURL != "" {
		guide = ordered.Map{{Key: "note", Value: note}, {Key: "photoUrl", Value: photoURL}}
	}
	photos := []any{}
	if arr, ok := h.Lookup("photos").ArrayOK(); ok {
		vals, _ := arr.Values()
		for _, pv := range vals {
			p, ok := pv.DocumentOK()
			if !ok {
				continue
			}
			photos = append(photos, ordered.Map{
				{Key: "alt", Value: rawStr(p.Lookup("alt"), "")}, {Key: "fileAssetId", Value: rawID(p.Lookup("fileAssetId"))}, {Key: "id", Value: rawID(p.Lookup("_id"))},
				{Key: "kind", Value: rawStr(p.Lookup("kind"), "INTERIOR")}, {Key: "mediumUrl", Value: rawStr(p.Lookup("mediumUrl"), "")},
				{Key: "roomType", Value: rawStr(p.Lookup("roomType"), "")}, {Key: "url", Value: rawStr(p.Lookup("url"), "")},
			})
		}
	}
	rooms := []any{}
	if arr, ok := h.Lookup("roomConfigurations").ArrayOK(); ok {
		vals, _ := arr.Values()
		for _, rv := range vals {
			r, ok := rv.DocumentOK()
			if !ok {
				continue
			}
			rooms = append(rooms, ordered.Map{
				{Key: "bedsPerRoom", Value: rawNum(r.Lookup("bedsPerRoom"), 0)}, {Key: "id", Value: rawID(r.Lookup("_id"))},
				{Key: "mealInclusion", Value: rawStr(r.Lookup("mealInclusion"), "Included")}, {Key: "monthlyRent", Value: rawNum(r.Lookup("monthlyRent"), 0)},
				{Key: "rooms", Value: rawNum(r.Lookup("rooms"), 0)}, {Key: "roomType", Value: rawStr(r.Lookup("roomType"), "")}, {Key: "vacantBeds", Value: rawNum(r.Lookup("vacantBeds"), 0)},
			})
		}
	}
	var pan, parent any
	if s, ok := h.Lookup("panNumber").StringValueOK(); ok {
		pan = s
	}
	if id, ok := h.Lookup("parentHostelId").ObjectIDOK(); ok {
		parent = id.Hex()
	}
	var suspension any
	var sus authz.Suspension
	if t, ok := h.Lookup("suspension", "startedAt").TimeOK(); ok {
		sus.StartedAt = &t
	}
	if t, ok := h.Lookup("suspension", "graceEndsAt").TimeOK(); ok {
		sus.GraceEndsAt = &t
	}
	if stage := sus.Stage(now); stage != "" {
		reason := rawStr(h.Lookup("suspension", "reason"), "PLAN_PAYMENT")
		suspension = ordered.Map{{Key: "graceEndsAt", Value: rawDate(h.Lookup("suspension", "graceEndsAt"))}, {Key: "reason", Value: reason},
			{Key: "stage", Value: stage}, {Key: "startedAt", Value: rawDate(h.Lookup("suspension", "startedAt"))}}
	}
	var kyc any
	if req, ok := h.Lookup("kyc", "required").BooleanOK(); ok && req {
		var kynote any
		if s, ok := h.Lookup("kyc", "note").StringValueOK(); ok {
			kynote = s
		}
		kyc = ordered.Map{{Key: "note", Value: kynote}, {Key: "status", Value: rawStr(h.Lookup("kyc", "status"), "DRAFT")}, {Key: "submittedAt", Value: rawDate(h.Lookup("kyc", "submittedAt"))}}
	}
	loc := ordered.Undefined
	var location any = loc
	if v := h.Lookup("location"); v.Type == bson.TypeEmbeddedDocument {
		location = ordered.FromBSON(v)
	}
	deleted, _ := h.Lookup("isDeleted").BooleanOK()
	demo, _ := h.Lookup("isDemoData").BooleanOK()
	return ordered.Map{
		{Key: "arrivalGuide", Value: guide}, {Key: "archivedAt", Value: rawDate(h.Lookup("deletedAt"))}, {Key: "archiveReason", Value: rawStr(h.Lookup("archiveReason"), "")},
		{Key: "capacitySummary", Value: objOr(h, "capacitySummary")}, {Key: "contact", Value: objOr(h, "contact")}, {Key: "createdAt", Value: rawDate(h.Lookup("createdAt"))},
		{Key: "demoDataLabel", Value: rawStr(h.Lookup("demoDataLabel"), "")}, {Key: "description", Value: rawStr(h.Lookup("description"), "")},
		{Key: "facilities", Value: strList(h, "facilities")}, {Key: "food", Value: objOr(h, "food")}, {Key: "hostelType", Value: rawStr(h.Lookup("hostelType"), "CO_LIVING")},
		{Key: "id", Value: rawID(h.Lookup("_id"))}, {Key: "isArchived", Value: deleted}, {Key: "isDemoData", Value: demo}, {Key: "purgeScheduledAt", Value: rawDate(h.Lookup("purgeScheduledAt"))},
		{Key: "location", Value: location}, {Key: "name", Value: rawStr(h.Lookup("name"), "")}, {Key: "nameChangeCount", Value: rawNum(h.Lookup("nameChangeCount"), 0)},
		{Key: "ownerId", Value: rawID(h.Lookup("ownerId"))}, {Key: "panNumber", Value: pan}, {Key: "parentHostelId", Value: parent}, {Key: "photos", Value: photos},
		{Key: "pricing", Value: objOr(h, "pricing")}, {Key: "roomConfigurations", Value: rooms}, {Key: "roomTypes", Value: strList(h, "roomTypes")}, {Key: "rules", Value: strList(h, "rules")},
		{Key: "slug", Value: rawStr(h.Lookup("slug"), "")}, {Key: "status", Value: rawStr(h.Lookup("status"), "")}, {Key: "suspension", Value: suspension}, {Key: "kyc", Value: kyc},
		{Key: "totalFloors", Value: rawNum(h.Lookup("totalFloors"), 0)}, {Key: "updatedAt", Value: rawDate(h.Lookup("updatedAt"))}, {Key: "verificationStatus", Value: rawStr(h.Lookup("verificationStatus"), "")},
	}
}
