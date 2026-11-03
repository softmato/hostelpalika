package noticepushes

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/push"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Platform is /platform/push (platform-push.service.ts): a superadmin push straight
// to devices, now or on a schedule the cron sends. Superadmin only: a moderator
// does not address every device on the platform.
type Platform struct {
	DB    *mongo.Database
	Guard *authz.Guards
	Audit *audit.Log
	Push  *push.Sender

	seedMu sync.Mutex
	seeded bool
}

func (p *Platform) Register(v1 *gin.RouterGroup) {
	g := v1.Group("/platform/push", authz.Use(p.Guard.RequireSuperadmin))
	g.GET("", httpx.ETag(), p.list)
	g.POST("", p.send)
	g.PATCH("/schedules/:id", p.updateSchedule)
}

// pushCategory is not ANNOUNCEMENT: that deep-links into the resident notices tab,
// which an admin or guardian cannot open.
const pushCategory = "PLATFORM"

// audienceRoles is AUDIENCE_ROLES; nil is every active account, staff included.
var audienceRoles = map[string][]string{"EVERYONE": nil, "GUARDIANS": {"GUARDIAN"}, "HOSTEL_STAFF": {"HOSTEL_ADMIN", "WARDEN", "COOK"}, "RESIDENTS": {"RESIDENT"}}

// automaticPushes is AUTOMATIC_PUSHES' rows as the list shows them, in order.
// Delivering them is the cron's (Phase 9).
var automaticPushes = []struct{ key, audience, body, time, title string }{
	{"PLAN_DUE_MORNING", "HOSTEL_STAFF", "Hostel admins whose plan payment is due or late, and an email to the owner with the website link to pay. 7 and 5 days before the due day, then every day from 3 days before until paid.", "08:00", "Plan payment reminder · morning"},
	{"PLAN_DUE_EVENING", "HOSTEL_STAFF", "Hostel admins whose plan payment is due or late. Every day from 3 days before the due day until paid.", "21:00", "Plan payment reminder · evening"},
	{"FEE_DUE_MORNING", "RESIDENTS", "Residents with an unpaid hostel fee: \"Please pay your hostel fee for <month>.\" 7 and 5 days before the due day, then every day from 3 days before until paid.", "08:00", "Hostel fee reminder · morning"},
	{"FEE_DUE_EVENING", "RESIDENTS", "Residents with an unpaid hostel fee. Every day from 3 days before the due day until paid.", "21:00", "Hostel fee reminder · evening"},
	{"FREE_MONTH_MORNING", "HOSTEL_STAFF", "Hostel admins on their plan's free months, once in each free month: \"Welcome — enjoy the free <plan> plan this month\", with how many free months are left.", "08:00", "Free month welcome"},
}

func (p *Platform) schedules() *mongo.Collection { return p.DB.Collection("platformpushschedules") }

// ensureAutomatic is ensureAutomaticPushes: each automatic row filed the first time
// this instance needs it. An existing row is left as it is: paused stays paused.
func (p *Platform) ensureAutomatic(ctx context.Context) error {
	p.seedMu.Lock()
	defer p.seedMu.Unlock()
	if p.seeded {
		return nil
	}
	now := time.Now().UTC()
	for _, a := range automaticPushes {
		startsOn := nepalDateOf(now)
		insert := bson.D{{Key: "repeat", Value: "DAILY"}, {Key: "startsOn", Value: startsOn}, {Key: "time", Value: a.time}, {Key: "audience", Value: a.audience}, {Key: "body", Value: a.body}}
		if next, ok := nextOccurrence("DAILY", startsOn, "", a.time, nil, now); ok {
			insert = append(insert, bson.E{Key: "nextRunAt", Value: next})
		} else {
			insert = append(insert, bson.E{Key: "nextRunAt", Value: nil})
		}
		insert = append(insert, bson.E{Key: "status", Value: "ACTIVE"}, bson.E{Key: "title", Value: a.title}, bson.E{Key: "urgency", Value: "NORMAL"},
			bson.E{Key: "weekdays", Value: bson.A{}}, bson.E{Key: "runCount", Value: 0}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
		_, err := p.schedules().UpdateOne(ctx, bson.D{{Key: "automatic", Value: a.key}}, bson.D{{Key: "$setOnInsert", Value: insert}}, options.UpdateOne().SetUpsert(true))
		if err != nil && !mongo.IsDuplicateKeyError(err) { // two instances seeding meet at the unique index
			return err
		}
	}
	p.seeded = true
	return nil
}

type scheduleRow struct {
	ID             bson.ObjectID  `bson:"_id"`
	Audience       string         `bson:"audience"`
	Automatic      *string        `bson:"automatic"`
	Body           string         `bson:"body"`
	CreatedBy      *bson.ObjectID `bson:"createdBy"`
	EndsOn         *string        `bson:"endsOn"`
	LastDevices    int            `bson:"lastDevices"`
	LastRecipients int            `bson:"lastRecipients"`
	LastRunAt      *time.Time     `bson:"lastRunAt"`
	NextRunAt      *time.Time     `bson:"nextRunAt"`
	Repeat         string         `bson:"repeat"`
	RunCount       int            `bson:"runCount"`
	StartsOn       string         `bson:"startsOn"`
	Status         string         `bson:"status"`
	Time           string         `bson:"time"`
	Title          string         `bson:"title"`
	Urgency        string         `bson:"urgency"`
	Weekdays       []int          `bson:"weekdays"`
}

func (s *scheduleRow) out() ordered.Map {
	weekdays := s.Weekdays
	if weekdays == nil {
		weekdays = []int{}
	}
	var auto, ends any
	if s.Automatic != nil {
		auto = *s.Automatic
	}
	if s.EndsOn != nil {
		ends = *s.EndsOn
	}
	return ordered.Map{{Key: "audience", Value: s.Audience}, {Key: "automatic", Value: auto}, {Key: "lastDevices", Value: s.LastDevices}, {Key: "lastRecipients", Value: s.LastRecipients},
		{Key: "body", Value: s.Body}, {Key: "endsOn", Value: ends}, {Key: "id", Value: s.ID.Hex()}, {Key: "lastRunAt", Value: isoOrNull(s.LastRunAt)}, {Key: "nextRunAt", Value: isoOrNull(s.NextRunAt)},
		{Key: "repeat", Value: s.Repeat}, {Key: "runCount", Value: s.RunCount}, {Key: "startsOn", Value: s.StartsOn}, {Key: "status", Value: s.Status}, {Key: "time", Value: s.Time},
		{Key: "title", Value: s.Title}, {Key: "urgency", Value: s.Urgency}, {Key: "weekdays", Value: weekdays}}
}

type pushLog struct {
	ID        bson.ObjectID `bson:"_id"`
	CreatedAt time.Time     `bson:"createdAt"`
	Metadata  struct {
		Audience   *string `bson:"audience"`
		Body       *string `bson:"body"`
		Devices    int     `bson:"devices"`
		Recipients int     `bson:"recipients"`
		ScheduleID *string `bson:"scheduleId"`
		Title      *string `bson:"title"`
		Urgency    *string `bson:"urgency"`
	} `bson:"metadata"`
}

func orStr(s *string, def string) string {
	if s == nil {
		return def
	}
	return *s
}

func (l *pushLog) out() ordered.Map {
	m := &l.Metadata
	return ordered.Map{{Key: "audience", Value: orStr(m.Audience, "EVERYONE")}, {Key: "body", Value: orStr(m.Body, "")}, {Key: "devices", Value: m.Devices}, {Key: "id", Value: l.ID.Hex()},
		{Key: "recipients", Value: m.Recipients}, {Key: "scheduled", Value: m.ScheduleID != nil && *m.ScheduleID != ""}, {Key: "sentAt", Value: httpx.ISO(l.CreatedAt)},
		{Key: "title", Value: orStr(m.Title, "")}, {Key: "urgency", Value: orStr(m.Urgency, "NORMAL")}}
}

func (p *Platform) list(c *gin.Context) {
	if err := p.ensureAutomatic(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err := p.DB.Collection("auditlogs").Find(c, bson.D{{Key: "action", Value: "PLATFORM_PUSH_SENT"}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(20))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var logs []pushLog
	if err := cur.All(c, &logs); err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err = p.schedules().Find(c, bson.D{{Key: "automatic", Value: bson.D{{Key: "$exists", Value: false}}}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "PAUSED"}}}}},
		options.Find().SetSort(bson.D{{Key: "nextRunAt", Value: 1}}).SetLimit(50))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var own []scheduleRow
	if err := cur.All(c, &own); err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err = p.schedules().Find(c, bson.D{{Key: "automatic", Value: bson.D{{Key: "$exists", Value: true}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var auto []scheduleRow
	if err := cur.All(c, &auto); err != nil {
		httpx.Fail(c, err)
		return
	}
	rank := func(s *scheduleRow) int {
		for i, a := range automaticPushes {
			if s.Automatic != nil && *s.Automatic == a.key {
				return i
			}
		}
		return -1
	}
	slices.SortStableFunc(auto, func(a, b scheduleRow) int { return rank(&a) - rank(&b) })
	out := ordered.Map{{Key: "automatic", Value: mapRows(auto)}, {Key: "pushes", Value: mapLogs(logs)}, {Key: "schedules", Value: mapRows(own)}}
	httpx.OK(c, out, "Push notifications loaded")
}

func mapRows(rows []scheduleRow) []ordered.Map {
	out := make([]ordered.Map, len(rows))
	for i := range rows {
		out[i] = rows[i].out()
	}
	return out
}

func mapLogs(rows []pushLog) []ordered.Map {
	out := make([]ordered.Map, len(rows))
	for i := range rows {
		out[i] = rows[i].out()
	}
	return out
}

var (
	nepalDateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	clockRe     = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
)

// send is sendPlatformPush: now, or a schedule filed for the cron.
func (p *Platform) send(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	everyone, now, normal := "EVERYONE", "NOW", "NORMAL"
	audience, _ := f.Enum("audience", false, &everyone, "EVERYONE", "HOSTEL_STAFF", "RESIDENTS", "GUARDIANS")
	text, _ := f.Str("body", valid.S{Trim: true, Min: 2, Max: 500})
	date, hasDate := f.Str("date", valid.S{Opt: true, Re: nepalDateRe, ReMsg: "Pick a date."})
	endsOn, hasEnds := f.Str("endsOn", valid.S{Opt: true, Re: nepalDateRe, ReMsg: "Pick a date."})
	repeat, _ := f.Enum("repeat", false, &now, "NOW", "ONCE", "DAILY", "WEEKLY")
	clock, hasTime := f.Str("time", valid.S{Opt: true, Re: clockRe, ReMsg: "Pick a time."})
	title, _ := f.Str("title", valid.S{Trim: true, Min: 2, Max: 120})
	urgency, _ := f.Enum("urgency", false, &normal, "NORMAL", "URGENT")
	list, _ := f.Array("weekdays", false, true)
	weekdays := []int{}
	for i, v := range list {
		sub := valid.NewForm(map[string]any{"d": v})
		if n, ok := sub.Num("d", valid.N{Int: true, Min: valid.P(0), Max: valid.P(6)}); ok && n >= 0 && n <= 6 {
			weekdays = append(weekdays, int(n))
		}
		f.JoinScalar("weekdays."+strconv.Itoa(i), sub)
	}
	f.Size("weekdays", len(list), 0, 7, "", false)
	if !f.Hard && repeat != "NOW" {
		if !hasTime {
			f.Is.Add("time", "Pick a time.")
		}
		if repeat == "ONCE" && !hasDate {
			f.Is.Add("date", "Pick a date.")
		}
		if repeat == "WEEKLY" && len(list) == 0 {
			f.Is.Add("weekdays", "Pick at least one day.")
		}
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, _ := bson.ObjectIDFromHex(authz.From(c).UserID)
	msg := message{audience, text, title, urgency}
	if repeat == "NOW" {
		out, err := p.deliver(c, msg, actor, "")
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		httpx.Write(c, http.StatusCreated, ordered.Map{{Key: "push", Value: out}}, "Push notification sent")
		return
	}
	at := time.Now().UTC().Truncate(time.Millisecond)
	startsOn := nepalDateOf(at)
	if hasDate {
		startsOn = date
	}
	var ends any
	if repeat != "ONCE" && hasEnds {
		ends = endsOn
	}
	days := []int{}
	if repeat == "WEEKLY" {
		for _, d := range weekdays {
			if !slices.Contains(days, d) {
				days = append(days, d)
			}
		}
		slices.Sort(days)
	}
	endsText, _ := ends.(string)
	// A minute of slack, so "today at the current minute" is not refused.
	next, ok := nextOccurrence(repeat, startsOn, endsText, clock, days, at.Add(-time.Minute))
	if !ok {
		m := "That schedule never runs — check the end date and days."
		if repeat == "ONCE" {
			m = "Pick a time in the future."
		}
		httpx.Fail(c, httpx.NewError(http.StatusUnprocessableEntity, "PUSH_SCHEDULE_NEVER_RUNS", m, nil))
		return
	}
	id := bson.NewObjectID()
	doc := bson.D{{Key: "_id", Value: id}, {Key: "audience", Value: audience}, {Key: "body", Value: text}, {Key: "title", Value: title}, {Key: "urgency", Value: urgency},
		{Key: "endsOn", Value: ends}, {Key: "repeat", Value: repeat}, {Key: "startsOn", Value: startsOn}, {Key: "time", Value: clock}, {Key: "weekdays", Value: days},
		{Key: "createdBy", Value: actor}, {Key: "nextRunAt", Value: next}, {Key: "status", Value: "ACTIVE"}, {Key: "runCount", Value: 0},
		{Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}
	if _, err := p.schedules().InsertOne(c, doc); err != nil {
		httpx.Fail(c, err)
		return
	}
	var row scheduleRow
	if err := p.schedules().FindOne(c, bson.D{{Key: "_id", Value: id}}).Decode(&row); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusCreated, ordered.Map{{Key: "schedule", Value: row.out()}}, "Push notification sent")
}

type message struct{ audience, body, title, urgency string }

// deliver is deliverPush: a bell row per recipient first, so the tap has something
// to open, then one push fan-out. No socket: the banner is the interruption.
func (p *Platform) deliver(ctx context.Context, m message, actor bson.ObjectID, scheduleID string) (ordered.Map, error) {
	filter := bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "status", Value: "ACTIVE"}}
	if roles := audienceRoles[m.audience]; roles != nil {
		filter = append(filter, bson.E{Key: "role", Value: bson.D{{Key: "$in", Value: roles}}})
	}
	cur, err := p.DB.Collection("users").Find(ctx, filter, options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var users []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := cur.All(ctx, &users); err != nil {
		return nil, err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	ids := make([]string, len(users))
	docs := make([]any, len(users))
	for i, u := range users {
		ids[i] = u.ID.Hex()
		docs[i] = bson.D{{Key: "body", Value: m.body}, {Key: "category", Value: pushCategory}, {Key: "channel", Value: "IN_APP"}, {Key: "deliveredAt", Value: now}, {Key: "isRead", Value: false},
			{Key: "kind", Value: "NORMAL"}, {Key: "priority", Value: m.urgency}, {Key: "status", Value: "SENT"}, {Key: "title", Value: m.title}, {Key: "userId", Value: u.ID},
			{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}
	}
	devices := 0
	if len(docs) > 0 {
		if _, err := p.DB.Collection("notifications").InsertMany(ctx, docs, options.InsertMany().SetOrdered(false)); err != nil {
			return nil, err
		}
		if p.Push != nil {
			devices = p.Push.ToUsers(ctx, ids, push.Payload{Body: m.body, Category: pushCategory, Priority: m.urgency, Title: m.title}).Sent
		}
	}
	meta := bson.D{{Key: "audience", Value: m.audience}, {Key: "body", Value: m.body}, {Key: "title", Value: m.title}, {Key: "urgency", Value: m.urgency}, {Key: "devices", Value: devices}, {Key: "recipients", Value: len(ids)}}
	entity := scheduleID
	if scheduleID != "" {
		meta = append(meta, bson.E{Key: "scheduleId", Value: scheduleID})
	} else {
		entity = bson.NewObjectID().Hex()
	}
	logID := bson.NewObjectID()
	if err := p.Audit.Write(ctx, audit.Entry{ID: logID, Action: "PLATFORM_PUSH_SENT", ActorID: actor, EntityID: entity, EntityType: "PlatformPush", Metadata: meta, CreatedAt: now}); err != nil {
		return nil, err
	}
	sid := scheduleID
	l := pushLog{ID: logID, CreatedAt: now}
	l.Metadata.Audience, l.Metadata.Body, l.Metadata.Title, l.Metadata.Urgency = &m.audience, &m.body, &m.title, &m.urgency
	l.Metadata.Devices, l.Metadata.Recipients, l.Metadata.ScheduleID = devices, len(ids), &sid
	return l.out(), nil
}

func (p *Platform) updateSchedule(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	action, _ := f.Enum("action", false, nil, "PAUSE", "RESUME", "CANCEL")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	gone := httpx.NewError(http.StatusNotFound, "PUSH_SCHEDULE_NOT_FOUND", "Schedule not found.", nil)
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		httpx.Fail(c, gone)
		return
	}
	var s scheduleRow
	if err := p.schedules().FindOne(c, bson.D{{Key: "_id", Value: id}}).Decode(&s); errors.Is(err, mongo.ErrNoDocuments) || (err == nil && (s.Status == "CANCELLED" || s.Status == "COMPLETED")) {
		httpx.Fail(c, gone)
		return
	} else if err != nil {
		httpx.Fail(c, err)
		return
	}
	// Cancelled, it would never be seeded again: pausing is the off switch.
	if s.Automatic != nil && action == "CANCEL" {
		httpx.Fail(c, httpx.NewError(http.StatusUnprocessableEntity, "PUSH_SCHEDULE_AUTOMATIC", "An automatic reminder can be paused, not cancelled.", nil))
		return
	}
	var set bson.D
	switch action {
	case "CANCEL":
		set = bson.D{{Key: "nextRunAt", Value: nil}, {Key: "status", Value: "CANCELLED"}}
	case "PAUSE":
		set = bson.D{{Key: "status", Value: "PAUSED"}}
	default:
		// Resuming never replays what was missed while paused.
		ends := ""
		if s.EndsOn != nil {
			ends = *s.EndsOn
		}
		if next, ok := nextOccurrence(s.Repeat, s.StartsOn, ends, s.Time, s.Weekdays, time.Now()); ok {
			set = bson.D{{Key: "nextRunAt", Value: next}, {Key: "status", Value: "ACTIVE"}}
		} else {
			set = bson.D{{Key: "nextRunAt", Value: nil}, {Key: "status", Value: "COMPLETED"}}
		}
	}
	var row scheduleRow
	err = p.schedules().FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: append(set, bson.E{Key: "updatedAt", Value: time.Now().UTC()})}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&row)
	var out any
	if err == nil {
		out = row.out()
	} else if !errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "schedule", Value: out}}, "Schedule updated")
}
