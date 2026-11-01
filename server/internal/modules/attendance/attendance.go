// Package attendance: the resident's side of modules/attendance. A ping's
// coordinates are used for the distance and dropped; nothing here may persist
// them (RULES.md §4, location_test.go enforces it).
package attendance

import (
	"context"
	"math"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

type Handler struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Audit  *audit.Log
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.GET("/resident/attendance", httpx.ETag(), h.history)
	v1.DELETE("/resident/attendance", h.erase)
	v1.POST("/resident/consent", h.consent)
	v1.POST("/resident/location/ping", h.ping)
}

// DistanceMeters is distanceMeters (haversine, rounded).
func DistanceMeters(lat1, lng1, lat2, lng2 float64) float64 {
	const earth = 6_371_000
	rad := func(d float64) float64 { return d * math.Pi / 180 }
	dLat, dLng := rad(lat2-lat1), rad(lng2-lng1)
	a := math.Pow(math.Sin(dLat/2), 2) + math.Cos(rad(lat1))*math.Cos(rad(lat2))*math.Pow(math.Sin(dLng/2), 2)
	return math.Round(earth * 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a)))
}

// Config is the attendance section of HostelSettings, over ATTENDANCE_DEFAULTS.
type Config struct {
	Enabled                bool    `bson:"enabled"`
	InsideZoneRadiusMeters float64 `bson:"insideZoneRadiusMeters"`
	NearbyZoneRadiusMeters float64 `bson:"nearbyZoneRadiusMeters"`
}

func zoneFor(meters float64, c Config) string {
	switch {
	case meters <= c.InsideZoneRadiusMeters:
		return "INSIDE"
	case meters <= c.NearbyZoneRadiusMeters:
		return "NEARBY"
	}
	return "OUTSIDE"
}

func (h *Handler) config(ctx context.Context, hostelID bson.ObjectID) (Config, error) {
	out := struct {
		Attendance Config `bson:"attendance"`
	}{Config{false, 50, 200}}
	err := h.DB.Collection("hostelsettings").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostelID}}).Decode(&out)
	if err != nil && err != mongo.ErrNoDocuments {
		return Config{}, err
	}
	return out.Attendance, nil
}

// HasLocationConsent is the latest LOCATION_TRACKING answer on record.
func (h *Handler) hasConsent(ctx context.Context, uid bson.ObjectID) (bool, error) {
	var row struct {
		Granted bool `bson:"granted"`
	}
	err := h.DB.Collection("consentlogs").FindOne(ctx, bson.D{{Key: "consentType", Value: "LOCATION_TRACKING"}, {Key: "userId", Value: uid}},
		options.FindOne().SetSort(bson.D{{Key: "recordedAt", Value: -1}})).Decode(&row)
	if err == mongo.ErrNoDocuments {
		return false, nil
	}
	return row.Granted, err
}

type consented struct {
	ConsentType string `json:"consentType"`
	Granted     bool   `json:"granted"`
}

func (h *Handler) consent(c *gin.Context) {
	p, err := h.Guards.RequireResident(c)
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
	defType, defSource := "LOCATION_TRACKING", "WEB"
	kind, _ := f.Enum("consentType", false, &defType, "LOCATION_TRACKING", "TERMS_OF_USE", "PRIVACY_POLICY")
	granted, _ := f.Bool("granted", false, nil)
	version, hasVersion := f.Str("policyVersion", valid.S{Opt: true, Trim: true, Max: 40})
	source, _ := f.Enum("source", false, &defSource, "WEB", "MOBILE")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var r struct {
		ID       bson.ObjectID `bson:"_id"`
		HostelID bson.ObjectID `bson:"hostelId"`
	}
	err = h.DB.Collection("residents").FindOne(c, bson.D{{Key: "isDeleted", Value: false}, {Key: "userId", Value: uid}}).Decode(&r)
	if err != nil && err != mongo.ErrNoDocuments {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	doc := bson.D{{Key: "userId", Value: uid}}
	if err == nil {
		doc = append(doc, bson.E{Key: "hostelId", Value: r.HostelID}, bson.E{Key: "residentId", Value: r.ID})
	}
	doc = append(doc, bson.E{Key: "consentType", Value: kind}, bson.E{Key: "granted", Value: granted})
	if hasVersion {
		doc = append(doc, bson.E{Key: "policyVersion", Value: version})
	}
	doc = append(doc, bson.E{Key: "recordedAt", Value: now}, bson.E{Key: "source", Value: source}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := h.DB.Collection("consentlogs").InsertOne(c, doc); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, consented{kind, granted}, "Consent recorded")
}

type pingOut struct {
	Attendance ordered.Map `json:"attendance"`
}

func (h *Handler) ping(c *gin.Context) {
	p, err := h.Guards.RequireResident(c)
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
	lat, _ := f.Num("lat", valid.N{Min: valid.P(-90), Max: valid.P(90)})
	lng, _ := f.Num("lng", valid.N{Min: valid.P(-180), Max: valid.P(180)})
	f.Num("accuracyMeters", valid.N{Opt: true, Min: valid.P(0), Max: valid.P(100_000)})
	recordedAt := time.Now().UTC().Truncate(time.Millisecond)
	if v, present := f.M["recordedAt"]; present {
		if t, ok := valid.CoerceDate(v); ok {
			recordedAt = t
		} else {
			f.Is.Add("recordedAt", valid.Type("date", "Date"))
		}
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, h.DB, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	consent, err := h.hasConsent(c, uid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if !consent {
		httpx.Fail(c, httpx.NewError(http.StatusForbidden, "LOCATION_CONSENT_REQUIRED", "Location tracking has not been consented to for this account.", nil))
		return
	}
	cfg, err := h.config(c, r.HostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if !cfg.Enabled {
		httpx.Fail(c, httpx.NewError(http.StatusConflict, "ATTENDANCE_DISABLED", "This hostel has attendance tracking switched off.", nil))
		return
	}
	var hostel struct {
		Location struct {
			Lat *float64 `bson:"lat"`
			Lng *float64 `bson:"lng"`
		} `bson:"location"`
	}
	err = h.DB.Collection("hostels").FindOne(c, bson.D{{Key: "_id", Value: r.HostelID}}, options.FindOne().SetProjection(bson.D{{Key: "location.lat", Value: 1}, {Key: "location.lng", Value: 1}})).Decode(&hostel)
	if err != nil && err != mongo.ErrNoDocuments {
		httpx.Fail(c, err)
		return
	}
	zone := "UNKNOWN"
	set := bson.D{}
	distance := any(ordered.Undefined)
	if hostel.Location.Lat != nil && hostel.Location.Lng != nil {
		meters := DistanceMeters(*hostel.Location.Lat, *hostel.Location.Lng, lat, lng)
		zone = zoneFor(meters, cfg)
		set = append(set, bson.E{Key: "distanceMeters", Value: meters})
		distance = meters
	}
	day := bs.CalendarDay(recordedAt)
	now := time.Now().UTC().Truncate(time.Millisecond)
	set = append(set, bson.E{Key: "hostelId", Value: r.HostelID}, bson.E{Key: "recordedAt", Value: recordedAt}, bson.E{Key: "source", Value: "MOBILE_PING"},
		bson.E{Key: "userId", Value: uid}, bson.E{Key: "zone", Value: zone}, bson.E{Key: "updatedAt", Value: now})
	var row struct {
		ID bson.ObjectID `bson:"_id"`
	}
	err = h.DB.Collection("attendancelogs").FindOneAndUpdate(c, bson.D{{Key: "day", Value: day}, {Key: "residentId", Value: r.ID}},
		bson.D{{Key: "$set", Value: set}, {Key: "$unset", Value: bson.D{{Key: "overriddenBy", Value: ""}, {Key: "overrideReason", Value: ""}}},
			{Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&row)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, pingOut{ordered.Map{{Key: "day", Value: day.Format("2006-01-02")}, {Key: "distanceMeters", Value: distance}, {Key: "id", Value: row.ID.Hex()},
		{Key: "overrideReason", Value: ordered.Undefined}, {Key: "residentId", Value: r.ID.Hex()}, {Key: "source", Value: "MOBILE_PING"}, {Key: "zone", Value: zone}}}, "Attendance recorded")
}

type dayOut struct {
	Day    string `json:"day"`
	Source string `json:"source"`
	Zone   string `json:"zone"`
}

type historyOut struct {
	Attendance     []dayOut    `json:"attendance"`
	ConsentGranted bool        `json:"consentGranted"`
	Resident       ordered.Map `json:"resident"`
}

// Avatar is findResidentAvatars for one resident: the picture on the account behind the row.
func avatar(ctx context.Context, db *mongo.Database, r *residents.Record) (map[string]*string, error) {
	if r.UserID == nil {
		return nil, nil
	}
	var u struct {
		Image *string `bson:"image"`
	}
	err := db.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: *r.UserID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}, options.FindOne().SetProjection(bson.D{{Key: "image", Value: 1}})).Decode(&u)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return map[string]*string{r.UserID.Hex(): u.Image}, nil
}

func (h *Handler) history(c *gin.Context) {
	p, err := h.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, h.DB, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	since := bs.CalendarDay(time.Now()).AddDate(0, 0, -60)
	cur, err := h.DB.Collection("attendancelogs").Find(c, bson.D{{Key: "day", Value: bson.D{{Key: "$gte", Value: since}}}, {Key: "residentId", Value: r.ID}}, options.Find().SetSort(bson.D{{Key: "day", Value: -1}}))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var logs []struct {
		Day    time.Time `bson:"day"`
		Source string    `bson:"source"`
		Zone   string    `bson:"zone"`
	}
	if err := cur.All(c, &logs); err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	consent, err := h.hasConsent(c, uid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	avatars, err := avatar(c, h.DB, r)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := historyOut{[]dayOut{}, consent, residents.SummaryWith(r, avatars)}
	for _, l := range logs {
		out.Attendance = append(out.Attendance, dayOut{l.Day.UTC().Format("2006-01-02"), l.Source, l.Zone})
	}
	httpx.OK(c, out, "Attendance loaded")
}

type erased struct {
	DeletedCount int64 `json:"deletedCount"`
}

func (h *Handler) erase(c *gin.Context) {
	p, err := h.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, h.DB, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	res, err := h.DB.Collection("attendancelogs").DeleteMany(c, bson.D{{Key: "residentId", Value: r.ID}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.Audit.Write(c, audit.Entry{Action: "ATTENDANCE_HISTORY_ERASED", ActorID: uid, EntityID: r.ID.Hex(), EntityType: "Resident", HostelID: r.HostelID, Metadata: bson.D{{Key: "deletedCount", Value: res.DeletedCount}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, erased{res.DeletedCount}, "Location history deleted")
}
