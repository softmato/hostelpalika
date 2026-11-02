package safety

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

var (
	reasonCodes = []string{"HOME", "FRIENDS", "TRAVELLING", "WORKING_LATE", "HOSPITAL", "OTHER"}
)

// adminRoster bounds the night board's read, far above any real hostel.
const adminRoster = 20000

// RegisterAdmin is the staff side of safety.service.ts: the night board and the
// SOS queue. responses is the cache the board reads through.
func (s *Service) RegisterAdmin(v1 *gin.RouterGroup, responses *cache.Cache) {
	v1.GET("/hostel-admin/night-status", func(c *gin.Context) { s.adminNight(c, responses) })
	v1.PATCH("/hostel-admin/night-status/:residentId/override", s.adminOverride)
	v1.GET("/hostel-admin/sos-alerts", httpx.ETag(), s.adminSOS)
	v1.PATCH("/hostel-admin/sos-alerts/:id/status", s.adminSOSStatus)
}

type nightSummary struct {
	InsideHostel  int `json:"INSIDE_HOSTEL"`
	MarkedSafe    int `json:"MARKED_SAFE"`
	NotVerified   int `json:"NOT_VERIFIED"`
	OutsideHostel int `json:"OUTSIDE_HOSTEL"`
	SOSTriggered  int `json:"SOS_TRIGGERED"`
	Total         int `json:"total"`
}

type nightLine struct {
	Resident ordered.Map `json:"resident"`
	Status   ordered.Map `json:"status"`
}

type nightListOut struct {
	Pagination pagination.Meta `json:"pagination"`
	Statuses   []nightLine     `json:"statuses"`
	Summary    nightSummary    `json:"summary"`
}

func (s *Service) adminNight(c *gin.Context, responses *cache.Cache) {
	p, err := s.Guards.RequireHostelCapability(c, "viewNightStatus")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	page := opsscope.ReadPage(q, &is)
	hostel := opsscope.Hostel(q, &is)
	status := valid.QueryEnum(q, "status", &is, nightStatuses...)
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	scope, err := opsscope.Filter(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	key := "night-status"
	if raw := c.Request.URL.RawQuery; raw != "" {
		key += "?" + raw
	}
	cache.Respond(c, responses, p.HostelIDs, p.UserID, key, "Night status loaded", func() (nightListOut, error) {
		cur, err := s.DB.Collection("residents").Find(c, append(bson.D{{Key: "isDeleted", Value: false}}, scope...),
			options.Find().SetSort(bson.D{{Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}}).SetLimit(adminRoster))
		if err != nil {
			return nightListOut{}, err
		}
		var roster []residents.Record
		if err := cur.All(c, &roster); err != nil {
			return nightListOut{}, err
		}
		ids := make(bson.A, len(roster))
		for i := range roster {
			ids[i] = roster[i].ID
		}
		sc, err := s.DB.Collection("nightstatuses").Find(c, bson.D{{Key: "residentId", Value: bson.D{{Key: "$in", Value: ids}}}})
		if err != nil {
			return nightListOut{}, err
		}
		var rows []nightRow
		if err := sc.All(c, &rows); err != nil {
			return nightListOut{}, err
		}
		byResident := make(map[bson.ObjectID]*nightRow, len(rows))
		for i := range rows {
			byResident[rows[i].ResidentID] = &rows[i]
		}
		avatars, err := residents.Avatars(c, s.DB, roster)
		if err != nil {
			return nightListOut{}, err
		}
		out := nightListOut{Statuses: []nightLine{}}
		lines := make([]nightLine, 0, len(roster))
		for i := range roster {
			st := SerializeNight(byResident[roster[i].ID])
			v, _ := st.Get("status")
			val, _ := v.(string)
			if status != nil && val != *status {
				continue
			}
			lines = append(lines, nightLine{residents.SummaryWith(&roster[i], avatars), st})
			out.Summary.Total++
			switch val {
			case "INSIDE_HOSTEL":
				out.Summary.InsideHostel++
			case "MARKED_SAFE":
				out.Summary.MarkedSafe++
			case "NOT_VERIFIED":
				out.Summary.NotVerified++
			case "OUTSIDE_HOSTEL":
				out.Summary.OutsideHostel++
			case "SOS_TRIGGERED":
				out.Summary.SOSTriggered++
			}
		}
		r := pagination.RangeOf(page)
		out.Pagination = pagination.MetaOf(page, len(lines))
		for i := r.Skip; i < len(lines) && i < r.Skip+r.Limit; i++ {
			out.Statuses = append(out.Statuses, lines[i])
		}
		return out, nil
	})
}

func (s *Service) adminOverride(c *gin.Context) {
	p, err := s.Guards.RequireHostelCapability(c, "updateNightStatus")
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
	reason, _ := f.Str("reason", valid.S{Trim: true, Min: 3, Max: 1000})
	code, hasCode := f.Enum("reasonCode", true, nil, reasonCodes...)
	status, _ := f.Enum("status", false, nil, nightStatuses...)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := httpx.OID(c.Param("residentId"), "resident id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	scope, err := opsscope.Filter(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var r residents.Record
	err = s.DB.Collection("residents").FindOne(c, append(bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}}, scope...)).Decode(&r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, httpx.NewError(http.StatusNotFound, "RESIDENT_NOT_FOUND", "Resident was not found.", nil))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	previous, err := s.readNight(c, r.ID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in := nightWrite{Note: &reason, Source: "WARDEN_OVERRIDE", Status: status, UserID: p.UserID}
	if hasCode {
		in.ReasonCode = &code
	}
	row, err := s.writeNight(c, &r, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	doc := bson.D{{Key: "hostelId", Value: r.HostelID}, {Key: "nextStatus", Value: status}, {Key: "overriddenBy", Value: uid}}
	if previous != nil {
		doc = append(doc, bson.E{Key: "previousStatus", Value: previous.Status})
	}
	doc = append(doc, bson.E{Key: "reason", Value: reason}, bson.E{Key: "residentId", Value: r.ID}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := s.DB.Collection("manualstatusoverrides").InsertOne(c, doc); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := s.Audit.Write(c, audit.Entry{Action: "NIGHT_STATUS_OVERRIDDEN", ActorID: uid, EntityID: r.ID.Hex(), EntityType: "NightStatus", HostelID: r.HostelID,
		Metadata: bson.D{{Key: "reason", Value: reason}, {Key: "status", Value: status}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, 200, nightLine{residents.Summary(&r), SerializeNight(row)}, "Night status overridden")
}

type adminSOSOut struct {
	Alerts     []ordered.Map   `json:"alerts"`
	Pagination pagination.Meta `json:"pagination"`
}

func (s *Service) adminSOS(c *gin.Context) {
	p, err := s.Guards.RequireHostelStaff(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	page := opsscope.ReadPage(q, &is)
	hostel := opsscope.Hostel(q, &is)
	status := valid.QueryEnum(q, "status", &is, "ACTIVE", "ACKNOWLEDGED", "RESOLVED", "FALSE_ALARM")
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	filter, err := opsscope.Filter(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if status != nil {
		filter = append(filter, bson.E{Key: "status", Value: *status})
	}
	r := pagination.RangeOf(page)
	cur, err := s.DB.Collection("sosalerts").Find(c, filter, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetSkip(int64(r.Skip)).SetLimit(int64(r.Limit)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []sosRow
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	total, err := s.DB.Collection("sosalerts").CountDocuments(c, filter)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := adminSOSOut{Alerts: make([]ordered.Map, len(rows)), Pagination: pagination.MetaOf(page, int(total))}
	for i := range rows {
		out.Alerts[i] = serializeSOS(&rows[i])
	}
	httpx.Write(c, 200, out, "SOS alerts loaded")
}

func (s *Service) adminSOSStatus(c *gin.Context) {
	p, err := s.Guards.RequireHostelStaff(c)
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
	status, _ := f.Enum("status", false, nil, "ACKNOWLEDGED", "RESOLVED", "FALSE_ALARM")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := httpx.OID(c.Param("id"), "sos alert id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	scope, err := opsscope.Filter(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	set := bson.D{{Key: "status", Value: status}, {Key: "updatedAt", Value: now}}
	if status == "ACKNOWLEDGED" {
		set = append(set, bson.E{Key: "acknowledgedAt", Value: now}, bson.E{Key: "acknowledgedBy", Value: uid})
	} else {
		set = append(set, bson.E{Key: "resolvedAt", Value: now}, bson.E{Key: "resolvedBy", Value: uid})
	}
	var row sosRow
	err = s.DB.Collection("sosalerts").FindOneAndUpdate(c, append(bson.D{{Key: "_id", Value: id}}, scope...), bson.D{{Key: "$set", Value: set}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, httpx.NewError(http.StatusNotFound, "SOS_NOT_FOUND", "SOS alert was not found.", nil))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	log := bson.D{{Key: "action", Value: "SOS_" + status}, {Key: "actorId", Value: uid}, {Key: "hostelId", Value: row.HostelID}}
	if hasNote {
		log = append(log, bson.E{Key: "note", Value: note})
	}
	log = append(log, bson.E{Key: "residentId", Value: row.ResidentID}, bson.E{Key: "sosAlertId", Value: row.ID}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := s.DB.Collection("incidentlogs").InsertOne(c, log); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := s.Audit.Write(c, audit.Entry{Action: "SOS_STATUS_UPDATED", ActorID: uid, EntityID: row.ID.Hex(), EntityType: "SOSAlert", HostelID: row.HostelID, Metadata: bson.D{{Key: "status", Value: status}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	realtime.PublishResourceChange(c, s.RT, s.Cache, realtime.Change{HostelIDs: []string{row.HostelID.Hex()}, Topics: []realtime.Topic{realtime.Safety}})
	httpx.Write(c, 200, ordered.Map{{Key: "alert", Value: serializeSOS(&row)}}, "SOS alert updated")
}
