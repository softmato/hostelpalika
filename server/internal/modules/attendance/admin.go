package attendance

import (
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Admin is the staff side of attendance.service.ts.
type Admin struct {
	*Handler
	Config *platformconfig.Service
	RT     *realtime.Client
	Bump   realtime.Bumper
}

func (a *Admin) Register(v1 *gin.RouterGroup) {
	g := v1.Group("/hostel-admin/attendance")
	g.GET("", httpx.ETag(), a.list)
	g.PATCH("/:residentId/override", a.override)
	g.GET("/alerts", httpx.ETag(), a.alerts)
	g.PATCH("/alerts/:id/resolve", a.resolve)
	g.GET("/settings", httpx.ETag(), a.getSettings)
	g.PATCH("/settings", a.setSettings)
}

const rosterLimit = 20000 // one hostel's residents, far above any real roster

var (
	zones  = []string{"INSIDE", "NEARBY", "OUTSIDE", "UNKNOWN"}
	hhmm   = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
	noDocs = mongo.ErrNoDocuments
)

type logRow struct {
	ID             bson.ObjectID `bson:"_id"`
	Day            time.Time     `bson:"day"`
	DistanceMeters *float64      `bson:"distanceMeters"`
	OverrideReason *string       `bson:"overrideReason"`
	ResidentID     bson.ObjectID `bson:"residentId"`
	Source         string        `bson:"source"`
	Zone           string        `bson:"zone"`
}

func serializeLog(l *logRow) ordered.Map {
	distance, reason := any(ordered.Undefined), any(ordered.Undefined)
	if l.DistanceMeters != nil {
		distance = *l.DistanceMeters
	}
	if l.OverrideReason != nil {
		reason = *l.OverrideReason
	}
	return ordered.Map{{Key: "day", Value: l.Day.Format("2006-01-02")}, {Key: "distanceMeters", Value: distance}, {Key: "id", Value: l.ID.Hex()}, {Key: "overrideReason", Value: reason},
		{Key: "residentId", Value: l.ResidentID.Hex()}, {Key: "source", Value: l.Source}, {Key: "zone", Value: l.Zone}}
}

type zoneSummary struct {
	Inside  int `json:"INSIDE"`
	Nearby  int `json:"NEARBY"`
	Outside int `json:"OUTSIDE"`
	Unknown int `json:"UNKNOWN"`
	Total   int `json:"total"`
}

type todayRow struct {
	Resident ordered.Map `json:"resident"`
	Zone     string      `json:"zone"`
}

type listOut struct {
	History []ordered.Map `json:"history"`
	Summary zoneSummary   `json:"summary"`
	Today   []todayRow    `json:"today"`
}

func queryDate(q map[string]string, key string, is *valid.Issues) *time.Time {
	raw, ok := q[key]
	if !ok {
		return nil
	}
	t, good := valid.CoerceDate(raw)
	if !good {
		is.Add(key, valid.Type("date", "Date"))
		return nil
	}
	return &t
}

func (a *Admin) list(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "viewNightStatus")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	from := queryDate(q, "from", &is)
	hostel := opsscope.Hostel(q, &is)
	var residentRaw string
	if raw, ok := q["residentId"]; ok {
		residentRaw, _ = valid.ObjectID(raw, "residentId", "", &is, false)
	}
	to := queryDate(q, "to", &is)
	zone := valid.QueryEnum(q, "zone", &is, zones...)
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelID, err := opsscope.HostelID(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err := a.DB.Collection("residents").Find(c, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}},
		options.Find().SetSort(bson.D{{Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}}).SetLimit(rosterLimit))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var roster []residents.Record
	if err := cur.All(c, &roster); err != nil {
		httpx.Fail(c, err)
		return
	}
	filter := bson.D{{Key: "hostelId", Value: hostelID}}
	if residentRaw != "" {
		id, err := httpx.OID(residentRaw, "resident id")
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		filter = append(filter, bson.E{Key: "residentId", Value: id})
	}
	if zone != nil {
		filter = append(filter, bson.E{Key: "zone", Value: *zone})
	}
	if from != nil || to != nil {
		days := bson.D{}
		if from != nil {
			days = append(days, bson.E{Key: "$gte", Value: bs.CalendarDay(*from)})
		}
		if to != nil {
			days = append(days, bson.E{Key: "$lte", Value: bs.CalendarDay(*to)})
		}
		filter = append(filter, bson.E{Key: "day", Value: days})
	}
	tc, err := a.DB.Collection("attendancelogs").Find(c, bson.D{{Key: "day", Value: bs.CalendarDay(time.Now())}, {Key: "hostelId", Value: hostelID}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var todayLogs []logRow
	if err := tc.All(c, &todayLogs); err != nil {
		httpx.Fail(c, err)
		return
	}
	hc, err := a.DB.Collection("attendancelogs").Find(c, filter, options.Find().SetSort(bson.D{{Key: "day", Value: -1}}).SetLimit(500))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var history []logRow
	if err := hc.All(c, &history); err != nil {
		httpx.Fail(c, err)
		return
	}
	byResident := make(map[bson.ObjectID]string, len(todayLogs))
	for i := range todayLogs {
		byResident[todayLogs[i].ResidentID] = todayLogs[i].Zone
	}
	avatars, err := residents.Avatars(c, a.DB, roster)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := listOut{History: make([]ordered.Map, len(history)), Today: make([]todayRow, len(roster))}
	for i := range history {
		out.History[i] = serializeLog(&history[i])
	}
	for i := range roster {
		z, ok := byResident[roster[i].ID]
		if !ok {
			z = "UNKNOWN"
		}
		out.Today[i] = todayRow{residents.SummaryWith(&roster[i], avatars), z}
		out.Summary.Total++
		switch z {
		case "INSIDE":
			out.Summary.Inside++
		case "NEARBY":
			out.Summary.Nearby++
		case "OUTSIDE":
			out.Summary.Outside++
		default:
			out.Summary.Unknown++
		}
	}
	httpx.Write(c, 200, out, "Attendance loaded")
}

func (a *Admin) override(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "updateNightStatus")
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
	var day time.Time
	if t, ok := valid.CoerceDate(f.M["day"]); ok {
		day = t
	} else {
		f.Is.Add("day", valid.Type("date", "Date"))
	}
	hostel := opsscope.BodyHostel(f)
	reason, _ := f.Str("reason", valid.S{Trim: true, Min: 3, Max: 500})
	zone, _ := f.Enum("zone", false, nil, zones...)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelID, err := opsscope.HostelID(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := httpx.OID(c.Param("residentId"), "resident id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var r residents.Record
	err = a.DB.Collection("residents").FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: hostelID}, {Key: "isDeleted", Value: false}}).Decode(&r)
	if errors.Is(err, noDocs) {
		httpx.Fail(c, httpx.NewError(http.StatusNotFound, "RESIDENT_NOT_FOUND", "Resident was not found.", nil))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	at := time.Now().UTC().Truncate(time.Millisecond)
	set := bson.D{{Key: "hostelId", Value: hostelID}, {Key: "overriddenBy", Value: uid}, {Key: "overrideReason", Value: reason}, {Key: "recordedAt", Value: at}, {Key: "source", Value: "MANUAL_OVERRIDE"}}
	if r.UserID != nil {
		set = append(set, bson.E{Key: "userId", Value: *r.UserID})
	}
	set = append(set, bson.E{Key: "zone", Value: zone}, bson.E{Key: "updatedAt", Value: at})
	var row logRow
	err = a.DB.Collection("attendancelogs").FindOneAndUpdate(c, bson.D{{Key: "day", Value: bs.CalendarDay(day)}, {Key: "residentId", Value: r.ID}},
		bson.D{{Key: "$set", Value: set}, {Key: "$unset", Value: bson.D{{Key: "distanceMeters", Value: ""}}}, {Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: at}, {Key: "__v", Value: 0}}}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&row)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "ATTENDANCE_OVERRIDDEN", ActorID: uid, EntityID: row.ID.Hex(), EntityType: "AttendanceLog", HostelID: hostelID,
		Metadata: bson.D{{Key: "day", Value: day.UTC().Format("2006-01-02")}, {Key: "reason", Value: reason}, {Key: "residentId", Value: r.ID.Hex()}, {Key: "zone", Value: zone}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	realtime.PublishResourceChange(c, a.RT, a.Bump, realtime.Change{HostelIDs: []string{hostelID.Hex()}, Topics: []realtime.Topic{realtime.Attendance}})
	httpx.Write(c, 200, ordered.Map{{Key: "attendance", Value: serializeLog(&row)}}, "Attendance overridden")
}

type nightPrompt struct {
	PromptEnabled      bool   `json:"promptEnabled" bson:"promptEnabled"`
	PromptTime         string `json:"promptTime" bson:"promptTime"`
	RepeatEveryMinutes int    `json:"repeatEveryMinutes" bson:"repeatEveryMinutes"`
}

// settingsDoc is AttendanceConfig; a key missing in storage keeps its default.
type settingsDoc struct {
	AbsenceAlertDays       int         `json:"absenceAlertDays" bson:"absenceAlertDays"`
	Enabled                bool        `json:"enabled" bson:"enabled"`
	InsideZoneRadiusMeters int         `json:"insideZoneRadiusMeters" bson:"insideZoneRadiusMeters"`
	NearbyZoneRadiusMeters int         `json:"nearbyZoneRadiusMeters" bson:"nearbyZoneRadiusMeters"`
	NightStatus            nightPrompt `json:"nightStatus" bson:"nightStatus"`
	PingTimes              []string    `json:"pingTimes" bson:"pingTimes"`
	RetentionDays          int         `json:"retentionDays" bson:"retentionDays"`
	EnabledAt              *time.Time  `json:"enabledAt,omitempty" bson:"enabledAt,omitempty"`
}

func defaults() settingsDoc {
	return settingsDoc{14, false, 50, 200, nightPrompt{true, "20:00", 30}, []string{"06:00", "08:00", "22:00"}, 600, nil}
}

func (a *Admin) loadSettings(c *gin.Context, hostel bson.ObjectID) (settingsDoc, error) {
	out := struct {
		Attendance settingsDoc `bson:"attendance"`
	}{defaults()}
	err := a.DB.Collection("hostelsettings").FindOne(c, bson.D{{Key: "hostelId", Value: hostel}}).Decode(&out)
	if err != nil && !errors.Is(err, noDocs) {
		return settingsDoc{}, err
	}
	s := out.Attendance
	if s.NightStatus.PromptTime == "" {
		s.NightStatus.PromptTime = "20:00"
	}
	if r := s.NightStatus.RepeatEveryMinutes; r != 15 && r != 30 && r != 60 {
		s.NightStatus.RepeatEveryMinutes = 30
	}
	return s, nil
}

type settingsOut struct {
	HostelID string      `json:"hostelId"`
	Settings settingsDoc `json:"settings"`
}

func (a *Admin) getSettings(c *gin.Context) {
	p, err := a.Guards.RequireHostelAdmin(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	s, err := a.loadSettings(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, 200, settingsOut{hostel.Hex(), s}, "Attendance settings loaded")
}

func (a *Admin) setSettings(c *gin.Context) {
	p, err := a.Guards.RequireHostelAdmin(c)
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
	given := bson.D{}
	num := func(key string, min, max float64) (int, bool) {
		v, ok := f.Num(key, valid.N{Opt: true, Int: true, Min: valid.P(min), Max: valid.P(max)})
		if ok {
			given = append(given, bson.E{Key: key, Value: int32(v)})
		}
		return int(v), ok
	}
	absence, hasAbsence := num("absenceAlertDays", 1, 90)
	enabled, hasEnabled := f.Bool("enabled", true, nil)
	if hasEnabled {
		given = append(given, bson.E{Key: "enabled", Value: enabled})
	}
	hostel := opsscope.BodyHostel(f)
	inside, hasInside := num("insideZoneRadiusMeters", 10, 500)
	nearby, hasNearby := num("nearbyZoneRadiusMeters", 20, 2000)
	var pings []string
	list, hasPings := f.Array("pingTimes", true, false)
	if hasPings {
		f.Size("pingTimes", len(list), 0, 6, "", false)
		pings = make([]string, 0, len(list))
		for i, v := range list {
			s, ok := v.(string)
			if !ok {
				f.Is.Add("pingTimes."+strconv.Itoa(i), valid.Type("string", valid.Received(v, false)))
				continue
			}
			if !hhmm.MatchString(s) {
				f.Is.Add("pingTimes."+strconv.Itoa(i), "Use HH:mm.")
				continue
			}
			pings = append(pings, s)
		}
		given = append(given, bson.E{Key: "pingTimes", Value: pings})
	}
	retention, hasRetention := num("retentionDays", 30, 1095)
	var promptOn, hasOn, hasTime, hasRepeat bool
	var promptTime string
	var repeat int
	night := bson.D{}
	f.Nest("nightStatus", true, func(sub *valid.Form) {
		promptOn, hasOn = sub.Bool("promptEnabled", true, nil)
		if hasOn {
			night = append(night, bson.E{Key: "promptEnabled", Value: promptOn})
		}
		if v, present := sub.M["promptTime"]; present {
			s, ok := v.(string)
			switch {
			case !ok:
				sub.Is.Add("promptTime", valid.Type("string", valid.Received(v, false)))
			case !hhmm.MatchString(s):
				sub.Is.Add("promptTime", "Use HH:mm.")
			default:
				h, _ := strconv.Atoi(s[:2])
				m, _ := strconv.Atoi(s[3:])
				if minute := h*60 + m; minute < 17*60 || minute > 23*60+45 {
					sub.Is.Add("promptTime", "The check-in time must be between 17:00 and 23:45.")
				} else {
					promptTime, hasTime = s, true
					night = append(night, bson.E{Key: "promptTime", Value: s})
				}
			}
		}
		if v, present := sub.M["repeatEveryMinutes"]; present {
			if n, ok := v.(float64); ok && (n == 15 || n == 30 || n == 60) {
				repeat, hasRepeat = int(n), true
				night = append(night, bson.E{Key: "repeatEveryMinutes", Value: int32(n)})
			} else {
				sub.Is.Add("repeatEveryMinutes", "Invalid input")
			}
		}
	})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	if f.Present("nightStatus") {
		given = append(given, bson.E{Key: "nightStatus", Value: night})
	}
	hostelID, err := opsscope.HostelID(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	current, err := a.loadSettings(c, hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	next := current
	if hasAbsence {
		next.AbsenceAlertDays = absence
	}
	if hasEnabled {
		next.Enabled = enabled
	}
	if hasInside {
		next.InsideZoneRadiusMeters = inside
	}
	if hasNearby {
		next.NearbyZoneRadiusMeters = nearby
	}
	if hasPings {
		next.PingTimes = pings
	}
	if hasRetention {
		next.RetentionDays = retention
	}
	if hasOn {
		next.NightStatus.PromptEnabled = promptOn
	}
	if hasTime {
		next.NightStatus.PromptTime = promptTime
	}
	if hasRepeat {
		next.NightStatus.RepeatEveryMinutes = repeat
	}
	at := time.Now().UTC().Truncate(time.Millisecond)
	if next.Enabled && !current.Enabled {
		next.EnabledAt = &at
	}
	bad := func(code, msg string) {
		httpx.Fail(c, httpx.NewError(http.StatusUnprocessableEntity, code, msg, nil))
	}
	limits := a.Config.OperationsTyped(c)
	switch {
	case next.NearbyZoneRadiusMeters <= next.InsideZoneRadiusMeters:
		bad("INVALID_GEOFENCE", "The nearby radius must be larger than the inside radius.")
		return
	case next.InsideZoneRadiusMeters > limits.MaxInsideZoneRadiusMeters:
		bad("GEOFENCE_ABOVE_PLATFORM_LIMIT", "The inside radius cannot exceed "+strconv.Itoa(limits.MaxInsideZoneRadiusMeters)+" m.")
		return
	case next.NearbyZoneRadiusMeters > limits.MaxNearbyZoneRadiusMeters:
		bad("GEOFENCE_ABOVE_PLATFORM_LIMIT", "The nearby radius cannot exceed "+strconv.Itoa(limits.MaxNearbyZoneRadiusMeters)+" m.")
		return
	case next.RetentionDays > limits.MaxAttendanceRetentionDays:
		bad("RETENTION_ABOVE_PLATFORM_LIMIT", "Attendance logs cannot be kept longer than "+strconv.Itoa(limits.MaxAttendanceRetentionDays)+" days.")
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if _, err := a.DB.Collection("hostelsettings").UpdateOne(c, bson.D{{Key: "hostelId", Value: hostelID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "attendance", Value: next}, {Key: "updatedBy", Value: uid}, {Key: "updatedAt", Value: at}}}, {Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: at}, {Key: "__v", Value: 0}}}},
		options.UpdateOne().SetUpsert(true)); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "ATTENDANCE_SETTINGS_UPDATED", ActorID: uid, EntityID: hostelID.Hex(), EntityType: "HostelSettings", HostelID: hostelID, Metadata: bson.D{{Key: "settings", Value: given}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, 200, ordered.Map{{Key: "settings", Value: next}}, "Attendance settings updated")
}

type alertOut struct {
	ConsecutiveDays int     `json:"consecutiveDays"`
	CreatedAt       *string `json:"createdAt,omitempty"`
	ID              string  `json:"id"`
	LastSeenAt      *string `json:"lastSeenAt,omitempty"`
	ResidentID      string  `json:"residentId"`
	ResidentName    string  `json:"residentName"`
	ResolutionNote  string  `json:"resolutionNote"`
	Status          string  `json:"status"`
}

type alertsOut struct {
	Alerts     []alertOut      `json:"alerts"`
	Pagination pagination.Meta `json:"pagination"`
}

func (a *Admin) alerts(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "viewNightStatus")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelID, err := opsscope.HostelID(p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	filter := bson.D{{Key: "hostelId", Value: hostelID}}
	total, err := a.DB.Collection("attendancealerts").CountDocuments(c, filter)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	page, size := 1, pagination.MaxPageSize
	query := pagination.Query{Page: &page, PageSize: &size}
	r := pagination.RangeOf(query)
	cur, err := a.DB.Collection("attendancealerts").Find(c, filter, options.Find().SetSort(bson.D{{Key: "status", Value: 1}, {Key: "createdAt", Value: -1}}).SetSkip(int64(r.Skip)).SetLimit(int64(r.Limit)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []struct {
		ID              bson.ObjectID `bson:"_id"`
		ConsecutiveDays int           `bson:"consecutiveDays"`
		CreatedAt       *time.Time    `bson:"createdAt"`
		LastSeenAt      *time.Time    `bson:"lastSeenAt"`
		ResidentID      bson.ObjectID `bson:"residentId"`
		ResolutionNote  string        `bson:"resolutionNote"`
		Status          string        `bson:"status"`
	}
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	ids := make(bson.A, len(rows))
	for i := range rows {
		ids[i] = rows[i].ResidentID
	}
	rc, err := a.DB.Collection("residents").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "hostelId", Value: hostelID}}, options.Find().SetProjection(bson.D{{Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}}))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var people []struct {
		ID        bson.ObjectID `bson:"_id"`
		FirstName string        `bson:"firstName"`
		LastName  string        `bson:"lastName"`
	}
	if err := rc.All(c, &people); err != nil {
		httpx.Fail(c, err)
		return
	}
	names := make(map[bson.ObjectID]string, len(people))
	for _, x := range people {
		names[x.ID] = strings.TrimSpace(x.FirstName + " " + x.LastName)
	}
	out := alertsOut{Alerts: make([]alertOut, len(rows)), Pagination: pagination.MetaOf(query, int(total))}
	for i, x := range rows {
		line := alertOut{ConsecutiveDays: x.ConsecutiveDays, ID: x.ID.Hex(), ResidentID: x.ResidentID.Hex(), ResidentName: "Resident", ResolutionNote: x.ResolutionNote, Status: x.Status}
		if n, ok := names[x.ResidentID]; ok {
			line.ResidentName = n
		}
		if x.CreatedAt != nil {
			s := httpx.ISO(*x.CreatedAt)
			line.CreatedAt = &s
		}
		if x.LastSeenAt != nil {
			s := x.LastSeenAt.UTC().Format("2006-01-02")
			line.LastSeenAt = &s
		}
		out.Alerts[i] = line
	}
	httpx.Write(c, 200, out, "Attendance alerts loaded")
}

func (a *Admin) resolve(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "updateNightStatus")
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
	hostel := opsscope.BodyHostel(f)
	note, hasNote := f.Str("note", valid.S{Opt: true, Trim: true, Max: 1000})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelID, err := opsscope.HostelID(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := httpx.OID(c.Param("id"), "alert id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	at := time.Now().UTC().Truncate(time.Millisecond)
	set := bson.D{}
	if hasNote {
		set = append(set, bson.E{Key: "resolutionNote", Value: note})
	}
	set = append(set, bson.E{Key: "resolvedAt", Value: at}, bson.E{Key: "resolvedBy", Value: uid}, bson.E{Key: "status", Value: "RESOLVED"}, bson.E{Key: "updatedAt", Value: at})
	res, err := a.DB.Collection("attendancealerts").UpdateOne(c, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: hostelID}, {Key: "status", Value: "OPEN"}}, bson.D{{Key: "$set", Value: set}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if res.MatchedCount == 0 {
		httpx.Fail(c, httpx.NewError(http.StatusNotFound, "ATTENDANCE_ALERT_NOT_FOUND", "Open attendance alert was not found.", nil))
		return
	}
	meta := bson.D{}
	if hasNote {
		meta = bson.D{{Key: "note", Value: note}}
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "ATTENDANCE_ALERT_RESOLVED", ActorID: uid, EntityID: id.Hex(), EntityType: "AttendanceAlert", HostelID: hostelID, Metadata: meta}); err != nil {
		httpx.Fail(c, err)
		return
	}
	realtime.PublishResourceChange(c, a.RT, a.Bump, realtime.Change{HostelIDs: []string{hostelID.Hex()}, Topics: []realtime.Topic{realtime.Attendance}})
	httpx.Write(c, 200, ordered.Map{{Key: "alertId", Value: id.Hex()}, {Key: "status", Value: "RESOLVED"}}, "Attendance alert resolved")
}
