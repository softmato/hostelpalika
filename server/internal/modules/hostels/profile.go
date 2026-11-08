package hostels

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/images"
	"github.com/softmato/hostelpalika/server/internal/platform/maps"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

const (
	nameChangeLimit = 2
	geocodeBudget   = 20 * time.Second
	profileCap      = authz.Capability("editHostelProfile")
)

// photoLimits: ROOM is per room type, the others are per hostel.
var photoLimits = map[string]int{"EXTERIOR": 3, "INTERIOR": 20, "ROOM": 10}

var hostelNotFound = httpx.NewError(404, "HOSTEL_NOT_FOUND", "Hostel was not found.", nil)

// profileRow is the part of a hostel the update's decisions read.
type profileRow struct {
	Name     string `bson:"name"`
	Status   string `bson:"status"`
	PAN      string `bson:"panNumber"`
	Renames  int    `bson:"nameChangeCount"`
	Location struct {
		Address        string   `bson:"address"`
		Area           string   `bson:"area"`
		City           string   `bson:"city"`
		Province       string   `bson:"province"`
		Country        string   `bson:"country"`
		Lat            *float64 `bson:"lat"`
		Lng            *float64 `bson:"lng"`
		LocationSource string   `bson:"locationSource"`
	} `bson:"location"`
	Photos []struct {
		Kind     string `bson:"kind"`
		RoomType string `bson:"roomType"`
	} `bson:"photos"`
	Rooms []struct {
		RoomType    string   `bson:"roomType"`
		MonthlyRent *float64 `bson:"monthlyRent"`
	} `bson:"roomConfigurations"`
}

// scopedHostel is findScopedHostel, whole, as raw so SerializeHostel can read it.
func (a *Admin) scopedHostel(ctx context.Context, p *authz.Principal, requested string) (bson.ObjectID, bson.Raw, error) {
	id, err := AdminHostel(p, requested)
	if err != nil {
		return id, nil, err
	}
	raw, err := a.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}}).Raw()
	if errors.Is(err, mongo.ErrNoDocuments) {
		return id, nil, hostelNotFound
	}
	return id, raw, err
}

func (a *Admin) openSchedule(ctx context.Context, id bson.ObjectID) (bool, error) {
	return a.exists(ctx, "feeschedules", bson.D{{Key: "effectiveTo", Value: nil}, {Key: "hostelId", Value: id}})
}

type profileOut struct {
	Hostel           ordered.Map `json:"hostel"`
	PricedByRateCard bool        `json:"pricedByRateCard"`
}

type photoOut struct {
	Hostel ordered.Map `json:"hostel"`
}

func hostelScopeQuery(c *gin.Context) (string, error) {
	var is valid.Issues
	v, ok := c.GetQuery("hostelId")
	if ok {
		valid.ObjectID(v, "hostelId", "", &is, false)
	}
	return v, is.Err()
}

func bodyHostelID(f *valid.Form) string {
	v, ok := f.M["hostelId"]
	if !ok {
		return ""
	}
	id, _ := valid.ObjectID(v, "hostelId", "", &f.Is, false)
	return id
}

func (a *Admin) profileGet(c *gin.Context) {
	p := authz.From(c)
	requested, err := hostelScopeQuery(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cache.Respond(c, a.Cache, p.HostelIDs, p.UserID, "profile?"+c.Request.URL.RawQuery, "Hostel profile loaded", func() (profileOut, error) {
		id, raw, err := a.scopedHostel(c, p, requested)
		if err != nil {
			return profileOut{}, err
		}
		priced, err := a.openSchedule(c, id)
		if err != nil {
			return profileOut{}, err
		}
		return profileOut{append(SerializeHostel(raw, time.Now()), ordered.Pair{Key: "hostelCode", Value: billing.HostelCode(id.Hex())}), priced}, nil
	})
}

// profileInput is hostelAdminProfileUpdateSchema; only what was sent is set.
type profileInput struct {
	requested string
	set       bson.D
	location  [][2]any
	name      *string
	pan       *string
	rooms     []RoomCfg
	roomsSet  bool
}

func parseProfile(body any) (*profileInput, error) {
	in := &profileInput{}
	f := valid.NewForm(body)
	add := func(key string, v any) { in.set = append(in.set, bson.E{Key: key, Value: v}) }
	in.requested = bodyHostelID(f)
	f.Nest("arrivalGuide", true, func(s *valid.Form) {
		d := bson.D{}
		if v := regStr(s, "note", valid.S{Max: 240}); v != nil {
			d = append(d, bson.E{Key: "note", Value: *v})
		}
		if v := regStr(s, "photoUrl", valid.S{Max: 500}); v != nil {
			if *v != "" && !strings.HasPrefix(*v, "https://") {
				s.Is.Add("photoUrl", "The photo must be an https link.")
			}
			d = append(d, bson.E{Key: "photoUrl", Value: *v})
		}
		add("arrivalGuide", d)
	})
	f.Nest("capacitySummary", true, func(s *valid.Form) {
		d := bson.D{}
		for _, k := range []string{"totalBeds", "totalRooms", "vacantBeds"} {
			if v := regNum(s, k, valid.N{Coerce: true, Int: true, Min: nonneg()}); v != nil {
				d = append(d, bson.E{Key: k, Value: *v})
			}
		}
		add("capacitySummary", d)
	})
	f.Nest("contact", true, func(s *valid.Form) {
		d := bson.D{}
		if v, ok := s.Str("email", valid.S{Opt: true, Trim: true}); ok {
			if !valid.IsEmail(v) {
				s.Is.Add("email", valid.Format("email"))
			}
			d = append(d, bson.E{Key: "email", Value: v})
		}
		if v := regStr(s, "phone", valid.S{Min: 7, Max: 24}); v != nil {
			d = append(d, bson.E{Key: "phone", Value: *v})
		}
		add("contact", d)
	})
	if v := regStr(f, "description", valid.S{Max: 2000}); v != nil {
		add("description", *v)
	}
	if f.Present("facilities") {
		add("facilities", textArray(f, "facilities"))
	}
	f.Nest("food", true, func(s *valid.Form) {
		d := bson.D{}
		for _, k := range []string{"hasNonVeg", "hasVeg"} {
			if v, ok := s.Bool(k, true, nil); ok {
				d = append(d, bson.E{Key: k, Value: v})
			}
		}
		if v := regNum(s, "mealsPerDay", valid.N{Coerce: true, Int: true, Min: nonneg(), Max: valid.P(6)}); v != nil {
			d = append(d, bson.E{Key: "mealsPerDay", Value: *v})
		}
		if v := regStr(s, "notes", valid.S{Max: 500}); v != nil {
			d = append(d, bson.E{Key: "notes", Value: *v})
		}
		add("food", d)
	})
	if v, ok := f.Enum("hostelType", true, nil, "BOYS", "GIRLS", "CO_LIVING"); ok {
		add("hostelType", v)
	}
	f.Nest("location", true, func(s *valid.Form) {
		put := func(k string, v any) { in.location = append(in.location, [2]any{k, v}) }
		if v := regStr(s, "address", valid.S{Max: 240}); v != nil {
			put("address", *v)
		}
		for _, k := range []string{"area", "city"} {
			if v := regStr(s, k, valid.S{Min: 2, Max: 120}); v != nil {
				put(k, *v)
			}
		}
		if v := regNum(s, "lat", valid.N{Coerce: true, Min: valid.P(-90), Max: valid.P(90)}); v != nil {
			put("lat", *v)
		}
		if v := regNum(s, "lng", valid.N{Coerce: true, Min: valid.P(-180), Max: valid.P(180)}); v != nil {
			put("lng", *v)
		}
		if v, ok := s.Enum("locationSource", true, nil, "MANUAL", "GEOCODED"); ok {
			put("locationSource", v)
		}
		if v := regStr(s, "province", valid.S{Max: 120}); v != nil {
			put("province", *v)
		}
	})
	if v := regStr(f, "name", valid.S{Min: 2, Max: 160}); v != nil {
		in.name = v
		add("name", *v)
	}
	if v, ok := f.Str("panNumber", valid.S{Opt: true, Trim: true, Re: panShape, ReMsg: "A PAN/VAT number is 9 digits."}); ok {
		in.pan = &v
	}
	f.Nest("pricing", true, func(s *valid.Form) {
		d := bson.D{}
		if v := regNum(s, "admissionFee", valid.N{Coerce: true, Min: nonneg()}); v != nil {
			d = append(d, bson.E{Key: "admissionFee", Value: *v})
		}
		if v := regNum(s, "formFee", valid.N{Coerce: true, Int: true, Min: nonneg()}); v != nil {
			d = append(d, bson.E{Key: "formFee", Value: *v})
		}
		if v := regStr(s, "currency", valid.S{Min: 2, Max: 8}); v != nil {
			d = append(d, bson.E{Key: "currency", Value: *v})
		}
		for _, k := range []string{"monthlyRentMax", "monthlyRentMin"} {
			if v := regNum(s, k, valid.N{Coerce: true, Min: nonneg()}); v != nil {
				d = append(d, bson.E{Key: k, Value: *v})
			}
		}
		add("pricing", d)
	})
	if items, ok := f.Array("roomConfigurations", true, false); ok {
		in.roomsSet = true
		each(f, "roomConfigurations", items, func(_ int, s *valid.Form) {
			var r RoomCfg
			r.Beds, _ = s.Num("bedsPerRoom", valid.N{Coerce: true, Int: true, Min: nonneg()})
			r.Meal, _ = s.Enum("mealInclusion", false, nil, "Included", "Not Included", "Optional")
			r.MonthlyRent = regNum(s, "monthlyRent", valid.N{Min: nonneg()})
			r.Deposit = regNum(s, "securityDeposit", valid.N{Int: true, Min: nonneg()})
			r.Rooms, _ = s.Num("rooms", valid.N{Coerce: true, Int: true, Min: nonneg()})
			r.RoomType, _ = s.Str("roomType", valid.S{Trim: true, Min: 1, Max: 80})
			zero := 0.0
			r.Vacant, _ = s.Num("vacantBeds", valid.N{Coerce: true, Int: true, Min: nonneg(), Default: &zero})
			in.rooms = append(in.rooms, r)
		})
		f.Size("roomConfigurations", len(items), 0, 30, "", false)
	}
	if f.Present("roomTypes") {
		add("roomTypes", textArray(f, "roomTypes"))
	}
	if f.Present("rules") {
		add("rules", textArray(f, "rules"))
	}
	if v := regNum(f, "totalFloors", valid.N{Coerce: true, Int: true, Min: valid.P(0), Max: valid.P(50)}); v != nil {
		add("totalFloors", *v)
	}
	return in, f.Err()
}

func addressQuery(l *profileRow) string {
	country := l.Location.Country
	if country == "" {
		country = "Nepal"
	}
	var parts []string
	for _, v := range []string{l.Location.Address, l.Location.Area, l.Location.City, l.Location.Province, country} {
		if v = strings.TrimSpace(v); v != "" {
			parts = append(parts, v)
		}
	}
	return strings.Join(parts, ", ")
}

func sameFloat(a, b *float64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// profileRooms applies a new room list to set and update and returns the types dropped.
func (a *Admin) profileRooms(ctx context.Context, id bson.ObjectID, in *profileInput, row *profileRow, priced bool, set *bson.D, update *bson.D) (bson.A, error) {
	rents := map[string]*float64{}
	for _, r := range row.Rooms {
		rents[r.RoomType] = r.MonthlyRent
	}
	docs, kept := bson.A{}, bson.A{}
	keptSet := map[string]bool{}
	var beds, rooms, vacant float64
	for _, r := range in.rooms {
		// A room type invented here has no rate yet: its figure stands until the next card.
		if rent, ok := rents[r.RoomType]; priced && ok && rent != nil {
			r.MonthlyRent = rent
		}
		docs = append(docs, append(bson.D{{Key: "_id", Value: bson.NewObjectID()}}, roomDoc(r, nil, false)...))
		beds += r.Beds * r.Rooms
		rooms += r.Rooms
		vacant += r.Vacant
		keptSet[r.RoomType] = true
		kept = append(kept, r.RoomType)
	}
	*set = append(*set, bson.E{Key: "roomConfigurations", Value: docs}, bson.E{Key: "capacitySummary", Value: bson.D{{Key: "totalBeds", Value: beds}, {Key: "totalRooms", Value: rooms}, {Key: "vacantBeds", Value: vacant}}})
	// Dropping a room type takes its photos with it. A $pull, not TS's rewrite of the
	// whole array from an earlier read, so a photo added meanwhile is never lost (PROF-1).
	*update = append(*update, bson.E{Key: "$pull", Value: bson.D{{Key: "photos", Value: bson.D{{Key: "kind", Value: "ROOM"}, {Key: "roomType", Value: bson.D{{Key: "$nin", Value: kept}}}}}}})
	var dropped bson.A
	for _, r := range row.Rooms {
		if !keptSet[r.RoomType] {
			dropped = append(dropped, r.RoomType)
		}
	}
	if len(dropped) == 0 {
		return nil, nil
	}
	// A room type somebody lives in cannot go: they would hold a bed in a type the hostel
	// no longer has. An empty one takes its numbered rooms with it.
	var occupied struct {
		RoomType string `bson:"roomType"`
	}
	err := a.DB.Collection("residents").FindOne(ctx, bson.D{{Key: "hostelId", Value: id}, {Key: "isDeleted", Value: false}, {Key: "roomType", Value: bson.D{{Key: "$in", Value: dropped}}},
		{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"PENDING", "ACTIVE", "SUSPENDED"}}}}}, options.FindOne().SetProjection(bson.D{{Key: "roomType", Value: 1}})).Decode(&occupied)
	if err == nil {
		return nil, httpx.NewError(409, "ROOM_TYPE_OCCUPIED", "Residents live in "+email.RoomTypeLabel(occupied.RoomType)+". Move them to another room type before removing it.", nil)
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	return dropped, nil
}

// profilePatch is updateHostelAdminProfile.
func (a *Admin) profilePatch(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, profileCap)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, err := parseProfile(body)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, raw, err := a.scopedHostel(c, p, in.requested)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var row profileRow
	if err := bson.Unmarshal(raw, &row); err != nil {
		httpx.Fail(c, err)
		return
	}
	// The PAN/VAT number is written once: it is what a branch has to match, so an owner
	// who could change it could re-point their business at anybody's branch.
	set := bson.D{}
	priced, err := a.openSchedule(c, id)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	// Prices are not editable here once a rate card exists: the rate card writes the
	// listing, so a rent typed here would last only until the next rate change.
	for _, e := range in.set {
		if !priced || e.Key != "pricing" {
			set = append(set, e)
		}
	}
	if in.pan != nil && (*in.pan == "" || row.PAN == "") {
		set = append(set, bson.E{Key: "panNumber", Value: *in.pan})
	}
	update := bson.D{}
	var dropped bson.A
	if in.roomsSet {
		if dropped, err = a.profileRooms(c, id, in, &row, priced, &set, &update); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	// After approval a hostel may rename itself only nameChangeLimit times.
	isRename := in.name != nil && *in.name != row.Name
	locked := row.Status == "APPROVED" || row.Status == "PUBLISHED"
	if isRename && locked && row.Renames >= nameChangeLimit {
		httpx.Fail(c, httpx.NewError(403, "NAME_CHANGE_LIMIT_REACHED", "Hostel name change limit reached. Send a change request to the platform team instead.", nil))
		return
	}
	// location merges field by field: a field left out keeps its value, "" clears it.
	unset := bson.D{}
	for _, kv := range in.location {
		key := "location." + kv[0].(string)
		if kv[1] == "" {
			unset = append(unset, bson.E{Key: key, Value: ""})
		} else {
			set = append(set, bson.E{Key: key, Value: kv[1]})
		}
	}
	actor, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	update = append(update, bson.E{Key: "$set", Value: append(set, bson.E{Key: "updatedBy", Value: actor}, bson.E{Key: "updatedAt", Value: now})})
	if len(unset) > 0 {
		update = append(update, bson.E{Key: "$unset", Value: unset})
	}
	if isRename && locked {
		update = append(update, bson.E{Key: "$inc", Value: bson.D{{Key: "nameChangeCount", Value: 1}}})
	}
	updated, err := a.DB.Collection("hostels").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}}, update, options.FindOneAndUpdate().SetReturnDocument(options.After)).Raw()
	if errors.Is(err, mongo.ErrNoDocuments) {
		err = hostelNotFound
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "HOSTEL_PROFILE_UPDATED", ActorID: actor, EntityID: id.Hex(), EntityType: "Hostel", HostelID: id}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if len(dropped) > 0 {
		if _, err := a.DB.Collection("hostelrooms").UpdateMany(c, bson.D{{Key: "hostelId", Value: id}, {Key: "isDeleted", Value: false}, {Key: "roomType", Value: bson.D{{Key: "$in", Value: dropped}}}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "isDeleted", Value: true}, {Key: "updatedBy", Value: actor}, {Key: "updatedAt", Value: now}}}}); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	var after profileRow
	if err := bson.Unmarshal(updated, &after); err != nil {
		httpx.Fail(c, err)
		return
	}
	// Refresh coordinates and nearby places when the address changed, the pin moved or
	// coordinates are missing. Best-effort and bounded: never fail the save on a map hiccup.
	moved := !sameFloat(row.Location.Lat, after.Location.Lat) || !sameFloat(row.Location.Lng, after.Location.Lng)
	if q := addressQuery(&after); q != "" && (after.Location.Lat == nil || after.Location.Lng == nil || moved || addressQuery(&row) != q) {
		if fresh := a.refreshGeo(c, id, &after); fresh != nil {
			updated = fresh
		}
	}
	a.Cache.PublicChanged(c)
	httpx.OK(c, profileOut{SerializeHostel(updated, time.Now()), priced}, "Hostel profile updated")
}

// refreshGeo is geocodeAndCacheHostel: a MANUAL pin stays and only the nearby cache is
// rebuilt around it. Returns the hostel to answer with when it changed.
func (a *Admin) refreshGeo(ctx context.Context, id bson.ObjectID, h *profileRow) bson.Raw {
	if a.Maps == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, geocodeBudget)
	defer cancel()
	l := h.Location
	var at maps.Coordinates
	set := bson.D{}
	if l.LocationSource == "MANUAL" && l.Lat != nil && l.Lng != nil {
		at = maps.Coordinates{Lat: *l.Lat, Lng: *l.Lng}
	} else {
		g := a.Maps.Geocode(ctx, maps.AddressParts{Address: l.Address, Area: l.Area, City: l.City, Country: l.Country, Province: l.Province}, l.Country != "")
		if g == nil {
			return nil
		}
		at = g.Coordinates
		set = append(set, bson.E{Key: "location.lat", Value: at.Lat}, bson.E{Key: "location.lng", Value: at.Lng}, bson.E{Key: "location.locationSource", Value: "GEOCODED"})
	}
	if nearby := a.Maps.Nearby(ctx, at); nearby != nil {
		set = append(set, bson.E{Key: "nearbyPlaces", Value: nearby}, bson.E{Key: "nearbyPlacesLastUpdated", Value: time.Now().UTC().Truncate(time.Millisecond)})
	}
	if len(set) == 0 {
		return nil
	}
	raw, err := a.DB.Collection("hostels").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: set}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Raw()
	if err != nil {
		slog.WarnContext(ctx, "hostel_geo_refresh_failed", "hostelId", id.Hex(), "error", err.Error())
		return nil
	}
	return raw
}

func (a *Admin) profileGeocode(c *gin.Context) {
	if _, err := a.Guards.RequireHostelCapability(c, profileCap); err != nil {
		httpx.Fail(c, err)
		return
	}
	q, err := ParseGeocodeQuery(valid.Query(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	message := "Address lookup complete"
	if q.Q != "" {
		message = "Location search complete"
	}
	httpx.OK(c, (&Geocoder{Maps: a.Maps}).LookupLocation(c, q), message)
}

func (a *Admin) profileChangeRequest(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, profileCap)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	requested := bodyHostelID(f)
	kind, _ := f.Enum("changeType", false, nil, "HOSTEL_NAME", "OWNER_NAME", "OWNER_EMAIL")
	reason := regStr(f, "reason", valid.S{Max: 600})
	value, _ := f.Str("requestedValue", valid.S{Trim: true, Min: 2, Max: 240})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	id, raw, err := a.scopedHostel(c, p, requested)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err := a.DB.Collection("users").Find(c, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "role", Value: "SUPERADMIN"}, {Key: "status", Value: "ACTIVE"}}, options.Find().SetProjection(bson.D{{Key: "email", Value: 1}}).SetLimit(100))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var admins []struct {
		Email string `bson:"email"`
	}
	if err := cur.All(c, &admins); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	why := ""
	if reason != nil {
		why = *reason
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "HOSTEL_CHANGE_REQUESTED", ActorID: actor, EntityID: id.Hex(), EntityType: "Hostel", HostelID: id,
		Metadata: bson.D{{Key: "changeType", Value: kind}, {Key: "reason", Value: why}, {Key: "requestedValue", Value: value}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	label := map[string]string{"HOSTEL_NAME": "Hostel name", "OWNER_EMAIL": "Owner account email", "OWNER_NAME": "Owner name"}[kind]
	m := email.HostelChangeRequest(label, rawStr(raw.Lookup("name"), ""), rawStr(raw.Lookup("slug"), ""), value, why)
	for _, s := range admins {
		a.Mail.Notify(c, email.Notification{Action: "hostel_change_request", To: s.Email, Subject: m.Subject, HTML: m.HTML, Category: m.Category})
	}
	httpx.Write(c, 201, struct {
		ChangeType     string `json:"changeType"`
		NotifiedAdmins int    `json:"notifiedAdmins"`
		Status         string `json:"status"`
	}{kind, len(admins), "SUBMITTED"}, "Change request sent to the platform team")
}

func (a *Admin) profilePhotoAdd(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, profileCap)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	requested := bodyHostelID(f)
	photo := bson.D{{Key: "_id", Value: bson.NewObjectID()}}
	if v := regStr(f, "alt", valid.S{Max: 120}); v != nil {
		photo = append(photo, bson.E{Key: "alt", Value: *v})
	}
	var asset *bson.ObjectID
	if v, ok := f.M["fileAssetId"]; ok {
		if hex, ok := valid.ObjectID(v, "fileAssetId", "", &f.Is, false); ok {
			oid, _ := bson.ObjectIDFromHex(hex)
			asset = &oid
			photo = append(photo, bson.E{Key: "fileAssetId", Value: oid})
		}
	}
	interior := "INTERIOR"
	kind, _ := f.Enum("kind", true, &interior, "EXTERIOR", "INTERIOR", "ROOM")
	photo = append(photo, bson.E{Key: "kind", Value: kind})
	roomType := regStr(f, "roomType", valid.S{Min: 1, Max: 120})
	url, ok := f.Str("url", valid.S{Trim: true, Max: 500})
	if ok && !strings.HasPrefix(url, "/") && !photoHTTP.MatchString(url) {
		f.Is.Add("url", "Photo URL must start with / or http(s)://")
	}
	if len(f.Is) == 0 && kind == "ROOM" && (roomType == nil || *roomType == "") {
		f.Is.Add("roomType", "A room photo must name the room type it belongs to.")
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	id, raw, err := a.scopedHostel(c, p, requested)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var row profileRow
	if err := bson.Unmarshal(raw, &row); err != nil {
		httpx.Fail(c, err)
		return
	}
	room := ""
	if kind == "ROOM" {
		room = *roomType
		known := false
		for _, r := range row.Rooms {
			known = known || r.RoomType == room
		}
		if !known {
			httpx.Fail(c, httpx.NewError(404, "ROOM_TYPE_NOT_FOUND", `"`+room+`" is not one of your room types.`, nil))
			return
		}
		photo = append(photo, bson.E{Key: "roomType", Value: room})
	}
	photo = append(photo, bson.E{Key: "url", Value: url})
	count := 0
	for _, ph := range row.Photos {
		k := ph.Kind
		if k == "" {
			k = "INTERIOR"
		}
		if k == kind && (kind != "ROOM" || ph.RoomType == room) {
			count++
		}
	}
	if limit := photoLimits[kind]; count >= limit {
		scope := strings.ToLower(kind) + " photo(s)"
		if kind == "ROOM" {
			scope = `photo(s) for "` + room + `"`
		}
		httpx.Fail(c, httpx.NewError(422, "PHOTO_LIMIT_REACHED", "You can upload at most "+strconv.Itoa(limit)+" "+scope+". Remove one first.", nil))
		return
	}
	actor, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	updated, err := a.photoWrite(c, id, actor, bson.E{Key: "$push", Value: bson.D{{Key: "photos", Value: photo}}}, "HOSTEL_PROFILE_PHOTO_ADDED", nil)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if asset != nil && a.BG != nil {
		fileAsset := *asset
		a.BG.After(c, func(ctx context.Context) error { return a.attachPhotoVariant(ctx, id, fileAsset) })
	}
	httpx.Write(c, 201, photoOut{SerializeHostel(updated, time.Now())}, "Hostel photo added")
}

// photoWrite is the shared update and audit of adding and removing one photo.
func (a *Admin) photoWrite(ctx context.Context, id, actor bson.ObjectID, change bson.E, action string, meta bson.D) (bson.Raw, error) {
	now := time.Now().UTC().Truncate(time.Millisecond)
	updated, err := a.DB.Collection("hostels").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}},
		bson.D{change, {Key: "$set", Value: bson.D{{Key: "updatedBy", Value: actor}, {Key: "updatedAt", Value: now}}}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Raw()
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, hostelNotFound
	}
	if err != nil {
		return nil, err
	}
	return updated, a.Audit.Write(ctx, audit.Entry{Action: action, ActorID: actor, EntityID: id.Hex(), EntityType: "Hostel", HostelID: id, Metadata: meta})
}

// attachPhotoVariant makes the photo's 640px WebP and records its URL on every hostel
// photo that points at the asset, so listing cards stop downloading camera originals.
func (a *Admin) attachPhotoVariant(ctx context.Context, hostelID, assetID bson.ObjectID) error {
	var asset struct {
		Bucket   string                 `bson:"bucket"`
		Key      string                 `bson:"key"`
		MimeType string                 `bson:"mimeType"`
		Variants []images.VariantRecord `bson:"variants"`
	}
	err := a.DB.Collection("fileassets").FindOne(ctx, bson.D{{Key: "_id", Value: assetID}, {Key: "isDeleted", Value: false}}).Decode(&asset)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil
	}
	if err != nil {
		return err
	}
	public, err := a.R2.PublicBucket()
	if err != nil || asset.Bucket != public || !strings.HasPrefix(asset.MimeType, "image/") {
		return nil
	}
	find := func(list []images.VariantRecord) *images.VariantRecord {
		for i := range list {
			if list[i].Variant == "MEDIUM" {
				return &list[i]
			}
		}
		return nil
	}
	medium := find(asset.Variants)
	if medium == nil {
		variants, err := images.OptimizeStored(ctx, a.R2, asset.Bucket, asset.Key, asset.MimeType)
		if err != nil {
			return err
		}
		if medium = find(variants); medium == nil {
			return nil
		}
		if _, err := a.DB.Collection("fileassets").UpdateOne(ctx, bson.D{{Key: "_id", Value: assetID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "variants", Value: variants}}}}); err != nil {
			return err
		}
	}
	url, err := a.R2.PublicURL(medium.Key)
	if err != nil {
		return err
	}
	_, err = a.DB.Collection("hostels").UpdateOne(ctx, bson.D{{Key: "_id", Value: hostelID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "photos.$[photo].mediumUrl", Value: url}}}},
		options.UpdateOne().SetArrayFilters([]any{bson.D{{Key: "photo.fileAssetId", Value: assetID}}}))
	return err
}

func (a *Admin) profilePhotoDelete(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, profileCap)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	requested, err := hostelScopeQuery(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, _, err := a.scopedHostel(c, p, requested)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	photoID, err := bson.ObjectIDFromHex(c.Param("photoId"))
	if err != nil {
		err = httpx.NewError(422, "INVALID_HOSTEL_ID", "Invalid hostel id.", nil)
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	updated, err := a.photoWrite(c, id, actor, bson.E{Key: "$pull", Value: bson.D{{Key: "photos", Value: bson.D{{Key: "_id", Value: photoID}}}}}, "HOSTEL_PROFILE_PHOTO_DELETED", bson.D{{Key: "photoId", Value: c.Param("photoId")}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, photoOut{SerializeHostel(updated, time.Now())}, "Hostel photo deleted")
}
