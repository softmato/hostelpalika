// Package safety is modules/safety's resident side: tonight's status, the
// shade's one-tap answer, the history and SOS. The staff side lands with Phase 6.
package safety

import (
	"context"
	"net/http"
	"regexp"
	"slices"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/background"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Service reads and writes the safety rows; Mail and Notify carry an SOS out.
type Service struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Tokens *auth.Tokens
	Notify *notifications.Service
	Mail   *email.Sender
	Audit  *audit.Log
	RT     *realtime.Client
	Cache  realtime.Bumper
	AppURL func(path string) string
}

func (s *Service) Register(v1 *gin.RouterGroup) {
	r := v1.Group("/resident")
	r.GET("/emergency-contacts", httpx.ETag(), s.emergencyContacts)
	r.GET("/night-status", httpx.ETag(), s.nightGet)
	r.POST("/night-status", s.nightPost)
	r.POST("/night-status/answer", s.nightAnswer)
	r.GET("/night-status/history", httpx.ETag(), s.nightHistory)
	r.GET("/sos", httpx.ETag(), s.sosList)
	r.POST("/sos", s.sosCreate)
}

var nightStatuses = []string{"INSIDE_HOSTEL", "OUTSIDE_HOSTEL", "NOT_VERIFIED", "MARKED_SAFE", "SOS_TRIGGERED"}

type nightRow struct {
	ID         bson.ObjectID `bson:"_id"`
	CheckedAt  time.Time     `bson:"checkedAt"`
	HostelID   bson.ObjectID `bson:"hostelId"`
	Night      *string       `bson:"night"`
	Note       *string       `bson:"note"`
	ReasonCode *string       `bson:"reasonCode"`
	ResidentID bson.ObjectID `bson:"residentId"`
	Source     string        `bson:"source"`
	Status     string        `bson:"status"`
	UpdatedAt  *time.Time    `bson:"updatedAt"`
}

// SerializeNight is serializeNightStatus: last night's answer reads NOT_VERIFIED
// tonight, unless it was an SOS, which does not expire with the sun.
func SerializeNight(st *nightRow) ordered.Map {
	if st == nil {
		return ordered.Map{{Key: "checkedAt", Value: nil}, {Key: "isCurrentNight", Value: false}, {Key: "night", Value: nil}, {Key: "note", Value: ""},
			{Key: "reasonCode", Value: nil}, {Key: "source", Value: "RESIDENT"}, {Key: "status", Value: "NOT_VERIFIED"}}
	}
	current := st.Night != nil && *st.Night == bs.NightKey(time.Now())
	stale := !current && st.Status != "SOS_TRIGGERED"
	var night, reason any
	if st.Night != nil {
		night = *st.Night
	}
	note, status := "", "NOT_VERIFIED"
	if !stale {
		status = st.Status
		if st.Note != nil {
			note = *st.Note
		}
		if st.ReasonCode != nil {
			reason = *st.ReasonCode
		}
	}
	updated := any(ordered.Undefined)
	if st.UpdatedAt != nil {
		updated = httpx.ISO(*st.UpdatedAt)
	}
	return ordered.Map{{Key: "checkedAt", Value: httpx.ISO(st.CheckedAt)}, {Key: "hostelId", Value: st.HostelID.Hex()}, {Key: "id", Value: st.ID.Hex()},
		{Key: "isCurrentNight", Value: current}, {Key: "night", Value: night}, {Key: "note", Value: note}, {Key: "reasonCode", Value: reason},
		{Key: "residentId", Value: st.ResidentID.Hex()}, {Key: "source", Value: st.Source}, {Key: "status", Value: status}, {Key: "updatedAt", Value: updated}}
}

func (s *Service) readNight(ctx context.Context, residentID bson.ObjectID) (*nightRow, error) {
	var row nightRow
	err := s.DB.Collection("nightstatuses").FindOne(ctx, bson.D{{Key: "residentId", Value: residentID}}).Decode(&row)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// NightFor is readNightStatusFor.
func (s *Service) NightFor(ctx context.Context, residentID bson.ObjectID) (ordered.Map, error) {
	row, err := s.readNight(ctx, residentID)
	if err != nil {
		return nil, err
	}
	return SerializeNight(row), nil
}

type sosRow struct {
	ID                   bson.ObjectID  `bson:"_id"`
	AcknowledgedAt       *time.Time     `bson:"acknowledgedAt"`
	AcknowledgedBy       *bson.ObjectID `bson:"acknowledgedBy"`
	CreatedAt            *time.Time     `bson:"createdAt"`
	GuardianAlertEnabled bool           `bson:"guardianAlertEnabled"`
	HostelID             bson.ObjectID  `bson:"hostelId"`
	Message              string         `bson:"message"`
	ResidentID           bson.ObjectID  `bson:"residentId"`
	ResolvedAt           *time.Time     `bson:"resolvedAt"`
	ResolvedBy           *bson.ObjectID `bson:"resolvedBy"`
	Status               string         `bson:"status"`
	TriggeredBy          bson.ObjectID  `bson:"triggeredBy"`
	UpdatedAt            *time.Time     `bson:"updatedAt"`
}

func serializeSOS(a *sosRow) ordered.Map {
	date := func(t *time.Time) any {
		if t == nil {
			return ordered.Undefined
		}
		return httpx.ISO(*t)
	}
	oid := func(id *bson.ObjectID) any {
		if id == nil {
			return ordered.Undefined
		}
		return id.Hex()
	}
	return ordered.Map{{Key: "acknowledgedAt", Value: date(a.AcknowledgedAt)}, {Key: "acknowledgedBy", Value: oid(a.AcknowledgedBy)}, {Key: "createdAt", Value: date(a.CreatedAt)},
		{Key: "guardianAlertEnabled", Value: a.GuardianAlertEnabled}, {Key: "hostelId", Value: a.HostelID.Hex()}, {Key: "id", Value: a.ID.Hex()}, {Key: "message", Value: a.Message},
		{Key: "residentId", Value: a.ResidentID.Hex()}, {Key: "resolvedAt", Value: date(a.ResolvedAt)}, {Key: "resolvedBy", Value: oid(a.ResolvedBy)}, {Key: "status", Value: a.Status},
		{Key: "triggeredBy", Value: a.TriggeredBy.Hex()}, {Key: "updatedAt", Value: date(a.UpdatedAt)}}
}

// LatestSOS is readLatestSOSFor; nil when there has never been one.
func (s *Service) LatestSOS(ctx context.Context, residentID bson.ObjectID) (any, error) {
	var row sosRow
	err := s.DB.Collection("sosalerts").FindOne(ctx, bson.D{{Key: "residentId", Value: residentID}}, options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}})).Decode(&row)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return serializeSOS(&row), nil
}

var selfAnswers = []string{"INSIDE_HOSTEL", "MARKED_SAFE", "OUTSIDE_HOSTEL"}

type nightWrite struct {
	Note, ReasonCode       *string
	Source, Status, UserID string
}

// writeNight is writeNightStatus: one row per resident, one log line per change,
// and any self-answer settles the bell rows.
func (s *Service) writeNight(ctx context.Context, r *residents.Record, in nightWrite) (*nightRow, error) {
	now := time.Now().UTC().Truncate(time.Millisecond)
	night := bs.NightKey(now)
	uid, err := httpx.OID(in.UserID, "user id")
	if err != nil {
		return nil, err
	}
	existing, err := s.readNight(ctx, r.ID)
	if err != nil {
		return nil, err
	}
	set := bson.D{{Key: "checkedAt", Value: now}, {Key: "hostelId", Value: r.HostelID}, {Key: "night", Value: night}}
	unset := bson.D{}
	if in.Note != nil {
		set = append(set, bson.E{Key: "note", Value: *in.Note})
	} else {
		unset = append(unset, bson.E{Key: "note", Value: 1})
	}
	if in.ReasonCode != nil {
		set = append(set, bson.E{Key: "reasonCode", Value: *in.ReasonCode})
	} else {
		unset = append(unset, bson.E{Key: "reasonCode", Value: 1})
	}
	set = append(set, bson.E{Key: "residentId", Value: r.ID}, bson.E{Key: "source", Value: in.Source}, bson.E{Key: "status", Value: in.Status},
		bson.E{Key: "updatedBy", Value: uid}, bson.E{Key: "updatedAt", Value: now})
	update := bson.D{{Key: "$set", Value: set}, {Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}}
	if len(unset) > 0 {
		update = append(update, bson.E{Key: "$unset", Value: unset})
	}
	var row nightRow
	err = s.DB.Collection("nightstatuses").FindOneAndUpdate(ctx, bson.D{{Key: "residentId", Value: r.ID}}, update,
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&row)
	if err != nil {
		return nil, err
	}
	log := bson.D{{Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}}
	if existing != nil {
		log = append(log, bson.E{Key: "previousStatus", Value: existing.Status})
	}
	log = append(log, bson.E{Key: "nextStatus", Value: in.Status})
	if in.Note != nil {
		log = append(log, bson.E{Key: "note", Value: *in.Note})
	}
	if in.ReasonCode != nil {
		log = append(log, bson.E{Key: "reasonCode", Value: *in.ReasonCode})
	}
	log = append(log, bson.E{Key: "night", Value: night}, bson.E{Key: "source", Value: in.Source}, bson.E{Key: "changedBy", Value: uid},
		bson.E{Key: "createdAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := s.DB.Collection("nightstatuslogs").InsertOne(ctx, log); err != nil {
		return nil, err
	}
	if r.UserID != nil && slices.Contains(selfAnswers, in.Status) {
		_ = s.Notify.SettleNight(ctx, r.UserID.Hex(), night, in.Note, in.ReasonCode, in.Status)
	}
	return &row, nil
}

var isoDatetime = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?Z$`)

type nightInput struct {
	AnsweredAt *time.Time
	Note       *string
	ReasonCode *string
	Status     string
}

func parseNight(body any, statuses []string) (nightInput, error) {
	f := valid.NewForm(body)
	var in nightInput
	if s, ok := f.Str("answeredAt", valid.S{Opt: true}); ok {
		t, err := time.Parse(time.RFC3339Nano, s)
		if !isoDatetime.MatchString(s) || err != nil {
			if t2, err2 := time.Parse("2006-01-02T15:04Z", s); err2 == nil && isoDatetime.MatchString(s) {
				in.AnsweredAt = &t2
			} else {
				f.Is.Add("answeredAt", "Invalid ISO datetime")
			}
		} else {
			in.AnsweredAt = &t
		}
	}
	if s, ok := f.Str("note", valid.S{Opt: true, Trim: true, Max: 1000}); ok {
		in.Note = &s
	}
	if s, ok := f.Enum("reasonCode", true, nil, "HOME", "FRIENDS", "TRAVELLING", "WORKING_LATE", "HOSPITAL", "OTHER"); ok {
		in.ReasonCode = &s
	}
	f.Enum("source", true, nil, "APP", "PUSH_ACTION", "WEB")
	in.Status, _ = f.Enum("status", false, nil, statuses...)
	return in, f.Err()
}

type updateOut struct {
	Resident   ordered.Map `json:"resident"`
	Status     ordered.Map `json:"status"`
	Superseded bool        `json:"superseded,omitempty"`
}

func (s *Service) update(c *gin.Context, p *authz.Principal, in nightInput) {
	r, err := residents.Current(c, s.DB, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if in.AnsweredAt != nil {
		cur, err := s.readNight(c, r.ID)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		tonight := bs.NightKey(time.Now())
		if bs.NightKey(*in.AnsweredAt) != tonight || cur != nil && cur.Night != nil && *cur.Night == tonight && cur.CheckedAt.After(*in.AnsweredAt) {
			httpx.OK(c, updateOut{residents.Summary(r), SerializeNight(cur), true}, "Night status updated")
			return
		}
	}
	row, err := s.writeNight(c, r, nightWrite{in.Note, in.ReasonCode, "RESIDENT", in.Status, p.UserID})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, updateOut{Resident: residents.Summary(r), Status: SerializeNight(row)}, "Night status updated")
}

func (s *Service) nightPost(c *gin.Context) {
	p, err := s.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, err := parseNight(body, nightStatuses)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	s.update(c, p, in)
}

// nightAnswer is the phone shade's button: no session, a signed token naming
// the resident, the hostel and the night it was asked about.
func (s *Service) nightAnswer(c *gin.Context) {
	token := auth.BearerToken(c.GetHeader("Authorization"))
	var claims map[string]any
	if token != "" {
		if m, err := s.Tokens.VerifyPurpose(token, auth.NightStatusAnswer); err == nil {
			claims = m
		}
	}
	sub, _ := claims["sub"].(string)
	hostelID, hasHostel := claims["hostelId"].(string)
	night, hasNight := claims["night"].(string)
	if sub == "" || !hasHostel || !hasNight {
		httpx.Fail(c, httpx.NewError(http.StatusUnauthorized, "UNAUTHENTICATED", "This answer link is not valid.", nil))
		return
	}
	if night != bs.NightKey(time.Now()) {
		httpx.Fail(c, httpx.NewError(http.StatusGone, "NIGHT_STATUS_ANSWER_STALE", "That question was for an earlier night.", nil))
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, err := parseNight(body, []string{"INSIDE_HOSTEL", "OUTSIDE_HOSTEL"})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	s.update(c, &authz.Principal{UserID: sub, Role: authz.Resident, HostelIDs: []string{hostelID}}, in)
}

type nightGetOut struct {
	Resident ordered.Map `json:"resident"`
	SOS      any         `json:"sos"`
	Status   ordered.Map `json:"status"`
}

func (s *Service) nightGet(c *gin.Context) {
	p, err := s.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, s.DB, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	sos, err := s.LatestSOS(c, r.ID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	st, err := s.NightFor(c, r.ID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, nightGetOut{residents.Summary(r), sos, st}, "Night status loaded")
}

const nightHistoryLimit = 60

type historyLog struct {
	CreatedAt  time.Time `bson:"createdAt"`
	NextStatus string    `bson:"nextStatus"`
	Night      string    `bson:"night"`
	Note       string    `bson:"note"`
	ReasonCode string    `bson:"reasonCode"`
	Source     string    `bson:"source"`
}

type historyEntry struct {
	AnsweredAt *string `json:"answeredAt"`
	Changes    int     `json:"changes"`
	Night      string  `json:"night"`
	Note       *string `json:"note"`
	ReasonCode *string `json:"reasonCode"`
	Source     *string `json:"source"`
	Status     string  `json:"status"`
}

func orNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// nightHistoryOf is nightHistory: a night with no log line is a real gap, shown
// as NOT_VERIFIED, walking back to the earliest night there is a log for.
func nightHistoryOf(logs []historyLog, tonight string) []historyEntry {
	by := map[string][]historyLog{}
	earliest := ""
	for _, l := range logs {
		night := l.Night
		if night == "" {
			night = bs.NightKey(l.CreatedAt)
		}
		by[night] = append(by[night], l)
		if earliest == "" || night < earliest {
			earliest = night
		}
	}
	out := []historyEntry{}
	if len(by) == 0 {
		return out
	}
	for night := tonight; night >= earliest && len(out) < nightHistoryLimit; night = previousNight(night) {
		list := by[night]
		if list == nil {
			out = append(out, historyEntry{Night: night, Status: "NOT_VERIFIED"})
			continue
		}
		standing := list[0]
		for _, l := range list[1:] {
			if l.CreatedAt.After(standing.CreatedAt) {
				standing = l
			}
		}
		at := httpx.ISO(standing.CreatedAt)
		out = append(out, historyEntry{&at, len(list), night, orNil(standing.Note), orNil(standing.ReasonCode), orNil(standing.Source), standing.NextStatus})
	}
	return out
}

func previousNight(night string) string {
	t, _ := time.Parse("2006-01-02", night)
	return t.AddDate(0, 0, -1).Format("2006-01-02")
}

type historyOut struct {
	Nights []historyEntry `json:"nights"`
}

func (s *Service) nightHistory(c *gin.Context) {
	p, err := s.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, s.DB, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	since := time.Now().Add(-(nightHistoryLimit + 1) * 24 * time.Hour)
	cur, err := s.DB.Collection("nightstatuslogs").Find(c, bson.D{{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: since}}}, {Key: "residentId", Value: r.ID}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var logs []historyLog
	if err := cur.All(c, &logs); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, historyOut{nightHistoryOf(logs, bs.NightKey(time.Now()))}, "Night status history loaded")
}

type contactOut struct {
	ID        string `json:"id"`
	IsPrimary bool   `json:"isPrimary"`
	Name      string `json:"name"`
	Phone     string `json:"phone"`
	Relation  string `json:"relation"`
}

type contactsOut struct {
	Contacts []contactOut `json:"contacts"`
	Resident ordered.Map  `json:"resident"`
}

// EmergencyContacts is the resident's list, primary first.
func EmergencyContacts(ctx context.Context, db *mongo.Database, r *residents.Record) ([]contactOut, error) {
	cur, err := db.Collection("emergencycontacts").Find(ctx, bson.D{{Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}},
		options.Find().SetSort(bson.D{{Key: "isPrimary", Value: -1}, {Key: "createdAt", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID        bson.ObjectID `bson:"_id"`
		IsPrimary bool          `bson:"isPrimary"`
		Name      string        `bson:"name"`
		Phone     string        `bson:"phone"`
		Relation  string        `bson:"relation"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := []contactOut{}
	for _, x := range rows {
		out = append(out, contactOut{x.ID.Hex(), x.IsPrimary, x.Name, x.Phone, x.Relation})
	}
	return out, nil
}

func (s *Service) emergencyContacts(c *gin.Context) {
	p, err := s.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, s.DB, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	list, err := EmergencyContacts(c, s.DB, r)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, contactsOut{list, residents.Summary(r)}, "Emergency contacts loaded")
}

type sosListOut struct {
	Alerts []ordered.Map `json:"alerts"`
}

func (s *Service) sosList(c *gin.Context) {
	p, err := s.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, s.DB, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err := s.DB.Collection("sosalerts").Find(c, bson.D{{Key: "residentId", Value: r.ID}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(50))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []sosRow
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	out := sosListOut{[]ordered.Map{}}
	for i := range rows {
		out.Alerts = append(out.Alerts, serializeSOS(&rows[i]))
	}
	httpx.OK(c, out, "SOS alerts")
}

type notified struct {
	Guardians int `json:"guardians"`
	Staff     int `json:"staff"`
}

type sosOut struct {
	Alert    ordered.Map `json:"alert"`
	Notified notified    `json:"notified"`
	Resident ordered.Map `json:"resident"`
}

const sosNote = "SOS alert triggered."

func (s *Service) sosCreate(c *gin.Context) {
	p, err := s.Guards.RequireResident(c)
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
	no := false
	guardianAlert, _ := f.Bool("guardianAlertEnabled", false, &no)
	msg, hasMsg := f.Str("message", valid.S{Opt: true, Trim: true, Max: 1000})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, s.DB, p)
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
	alert := sosRow{ID: bson.NewObjectID(), CreatedAt: &now, GuardianAlertEnabled: guardianAlert, HostelID: r.HostelID, ResidentID: r.ID, Status: "ACTIVE", TriggeredBy: uid, UpdatedAt: &now}
	doc := bson.D{{Key: "_id", Value: alert.ID}, {Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}, {Key: "triggeredBy", Value: uid}}
	if hasMsg {
		alert.Message = msg
		doc = append(doc, bson.E{Key: "message", Value: msg})
	}
	doc = append(doc, bson.E{Key: "status", Value: "ACTIVE"}, bson.E{Key: "guardianAlertEnabled", Value: guardianAlert},
		bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := s.DB.Collection("sosalerts").InsertOne(c, doc); err != nil {
		httpx.Fail(c, err)
		return
	}
	note := sosNote
	if _, err := s.writeNight(c, r, nightWrite{Note: &note, Source: "SOS", Status: "SOS_TRIGGERED", UserID: p.UserID}); err != nil {
		httpx.Fail(c, err)
		return
	}
	incident := bson.D{{Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}, {Key: "sosAlertId", Value: alert.ID}, {Key: "action", Value: "SOS_TRIGGERED"}}
	if hasMsg {
		incident = append(incident, bson.E{Key: "note", Value: msg})
	}
	incident = append(incident, bson.E{Key: "actorId", Value: uid}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := s.DB.Collection("incidentlogs").InsertOne(c, incident); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := s.Audit.Write(c, audit.Entry{Action: "SOS_TRIGGERED", ActorID: uid, EntityID: alert.ID.Hex(), EntityType: "SOSAlert", HostelID: r.HostelID, Metadata: bson.D{}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	realtime.PublishResourceChange(c, s.RT, s.Cache, realtime.Change{HostelIDs: []string{r.HostelID.Hex()}, Topics: []realtime.Topic{realtime.Safety}})
	staff, guardians, err := s.fanOut(c.Request.Context(), &alert, r, msg)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusCreated, sosOut{serializeSOS(&alert), notified{guardians, staff}, residents.Summary(r)}, "SOS alert triggered")
}

// fanOut is fanOutSOSAlert. Each delivery stands alone (Promise.allSettled): a
// dead mail provider must not cost the warden their push.
func (s *Service) fanOut(ctx context.Context, a *sosRow, r *residents.Record, msg string) (staffN, guardianN int, err error) {
	hostelName, err := residents.HostelName(ctx, s.DB, r.HostelID)
	if err != nil {
		return 0, 0, err
	}
	admins, err := residents.HostelAdminContacts(ctx, s.DB, r.HostelID)
	if err != nil {
		return 0, 0, err
	}
	wardens, err := residents.WardenContacts(ctx, s.DB, r.HostelID)
	if err != nil {
		return 0, 0, err
	}
	guardians := []residents.Contact{}
	if a.GuardianAlertEnabled {
		if guardians, err = residents.GuardianContacts(ctx, s.DB, r.HostelID, r.ID); err != nil {
			return 0, 0, err
		}
	}
	seen, staff := map[string]bool{}, []residents.Contact{}
	for _, x := range append(admins, wardens...) {
		if !seen[x.Email] {
			seen[x.Email] = true
			staff = append(staff, x)
		}
	}
	data := ordered.Map{{Key: "alertId", Value: a.ID.Hex()}, {Key: "priority", Value: "URGENT"}}
	var sends []func()
	do := func(fn func()) { sends = append(sends, fn) }
	send := func(action, to string, content email.Content) {
		do(func() {
			s.Mail.Notify(ctx, email.Notification{Action: action, To: to, Subject: content.Subject, HTML: content.HTML, Category: content.Category})
		})
	}
	name, phone := r.FullName(), r.Phone
	for _, x := range staff {
		send("sos_alert_staff", x.Email, email.SOSAlert(s.AppURL("/hostel-admin/sos-alerts"), hostelName, msg, false, name, phone, *a.CreatedAt))
		if x.UserID != "" {
			userID := x.UserID
			do(func() {
				_, _ = s.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/hostel-admin/sos-alerts", Body: name + " raised an emergency SOS. Respond immediately.", Category: "SOS",
					Data: data, HostelID: r.HostelID.Hex(), Kind: "ACTION", Priority: "URGENT", Title: "🚨 Emergency SOS", UserID: userID})
			})
		}
	}
	for _, x := range guardians {
		send("sos_alert_guardian", x.Email, email.SOSAlert(s.AppURL("/guardian/safety"), hostelName, msg, true, name, phone, *a.CreatedAt))
		if x.UserID != "" {
			userID := x.UserID
			do(func() {
				_, _ = s.Notify.CreateInApp(ctx, notifications.Input{Body: name + " raised an emergency SOS at " + hostelName + ".", Category: "SOS",
					Data: data, HostelID: r.HostelID.Hex(), Priority: "URGENT", Title: "🚨 Emergency SOS", UserID: userID})
			})
		}
	}
	background.Parallel(ctx, sends...)
	realtime.PublishResourceChange(ctx, s.RT, s.Cache, realtime.Change{HostelIDs: []string{r.HostelID.Hex()}, Topics: []realtime.Topic{realtime.Safety}})
	return len(staff), len(guardians), nil
}
