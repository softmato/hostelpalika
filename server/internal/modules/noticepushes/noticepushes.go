package noticepushes

import (
	"context"
	"log/slog"
	"net/http"
	"regexp"
	"slices"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notices"
	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

type Service struct {
	DB      *mongo.Database
	Guards  *authz.Guards
	Notices *notices.Admin
	Audit   *audit.Log
	RT      *realtime.Client
	Cache   realtime.Bumper
}

func (s *Service) Register(v1 *gin.RouterGroup) {
	v1.GET("/hostel-admin/notice-pushes", httpx.ETag(), s.list)
	v1.POST("/hostel-admin/notice-pushes", s.create)
	v1.PATCH("/hostel-admin/notice-pushes/:id", s.update)
	v1.DELETE("/hostel-admin/notice-pushes/:id", s.remove)
	v1.POST("/hostel-admin/notice-pushes/:id/send", s.sendNow)
}

// Row is a stored NoticePush.
type Row struct {
	ID           bson.ObjectID  `bson:"_id"`
	Body         string         `bson:"body"`
	CreatedAt    *time.Time     `bson:"createdAt"`
	CreatedBy    bson.ObjectID  `bson:"createdBy"`
	HostelID     bson.ObjectID  `bson:"hostelId"`
	IsUrgent     bool           `bson:"isUrgent"`
	LastNoticeID *bson.ObjectID `bson:"lastNoticeId"`
	LastRunAt    *time.Time     `bson:"lastRunAt"`
	NextRunAt    *time.Time     `bson:"nextRunAt"`
	Repeat       string         `bson:"repeat"`
	RunCount     int            `bson:"runCount"`
	SeedKey      string         `bson:"seedKey"`
	StartsOn     *string        `bson:"startsOn"`
	Status       string         `bson:"status"`
	Time         *string        `bson:"time"`
	Title        string         `bson:"title"`
	Weekdays     []int          `bson:"weekdays"`
}

func (r *Row) timing() Timing {
	t := Timing{Repeat: r.Repeat, Weekdays: r.Weekdays}
	if r.StartsOn != nil {
		t.StartsOn = *r.StartsOn
	}
	if r.Time != nil {
		t.Time = *r.Time
	}
	return t
}

func isoOrNull(t *time.Time) any {
	if t == nil {
		return nil
	}
	return httpx.ISO(*t)
}

func strOrNull(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

type pushOut struct {
	Body      string `json:"body"`
	CreatedAt any    `json:"createdAt"`
	HostelID  string `json:"hostelId"`
	ID        string `json:"id"`
	IsDefault bool   `json:"isDefault"`
	IsUrgent  bool   `json:"isUrgent"`
	LastRunAt any    `json:"lastRunAt"`
	NextRunAt any    `json:"nextRunAt"`
	Repeat    string `json:"repeat"`
	RunCount  int    `json:"runCount"`
	StartsOn  any    `json:"startsOn"`
	Status    string `json:"status"`
	Time      any    `json:"time"`
	Title     string `json:"title"`
	Weekdays  []int  `json:"weekdays"`
}

func serialize(r *Row) pushOut {
	days := r.Weekdays
	if days == nil {
		days = []int{}
	}
	return pushOut{r.Body, isoOrNull(r.CreatedAt), r.HostelID.Hex(), r.ID.Hex(), r.SeedKey != "", r.IsUrgent, isoOrNull(r.LastRunAt), isoOrNull(r.NextRunAt), r.Repeat,
		r.RunCount, strOrNull(r.StartsOn), r.Status, strOrNull(r.Time), r.Title, days}
}

func svcErr(status int, code, msg string) error { return httpx.NewError(status, code, msg, nil) }

var (
	dateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	timeRe = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
)

// input is noticePushCreateSchema; only what was sent is set when parsed as an update.
type input struct {
	Active       *bool
	Body         string
	Date         string
	DelayMinutes int
	HostelID     string
	IsUrgent     *bool
	Repeat       string
	Time         string
	Title        string
	Weekdays     []int
	has          map[string]bool
}

func parse(body any, update bool) (input, error) {
	f := valid.NewForm(body)
	in := input{has: map[string]bool{}}
	if v, ok := f.Str("body", valid.S{Opt: update, Trim: true, Min: 2, Max: 500}); ok {
		in.Body, in.has["body"] = v, true
	}
	if v, ok := f.Str("date", valid.S{Opt: true, Re: dateRe, ReMsg: "Pick a date."}); ok {
		in.Date, in.has["date"] = v, true
	}
	if v, ok := f.Num("delayMinutes", valid.N{Opt: true, Int: true, Min: valid.P(1), Max: valid.P(60 * 24 * 60)}); ok {
		in.DelayMinutes, in.has["delayMinutes"] = int(v), true
	}
	if raw, present := f.M["hostelId"]; present {
		in.HostelID, _ = valid.ObjectID(raw, "hostelId", "", &f.Is, false)
	}
	if v, ok := f.Bool("isUrgent", true, nil); ok {
		in.IsUrgent = &v
	}
	if v, ok := f.Enum("repeat", update, nil, "NOW", "LATER", "DAILY", "WEEKLY"); ok {
		in.Repeat, in.has["repeat"] = v, true
	}
	if v, ok := f.Str("time", valid.S{Opt: true, Re: timeRe, ReMsg: "Pick a time."}); ok {
		in.Time, in.has["time"] = v, true
	}
	if v, ok := f.Str("title", valid.S{Opt: update, Trim: true, Min: 2, Max: 120}); ok {
		in.Title, in.has["title"] = v, true
	}
	if list, ok := f.Array("weekdays", true, false); ok {
		days := []int{}
		for i, raw := range list {
			sub := &valid.Form{M: map[string]any{"v": raw}}
			if n, ok := sub.Num("v", valid.N{Int: true, Min: valid.P(0), Max: valid.P(6)}); ok {
				days = append(days, int(n))
			}
			f.JoinScalar("weekdays."+itoa(i), sub)
		}
		f.Size("weekdays", len(list), 0, 7, "", false)
		in.Weekdays, in.has["weekdays"] = days, true
	}
	if update {
		if v, ok := f.Bool("active", true, nil); ok {
			in.Active = &v
		}
	}
	return in, f.Err()
}

func itoa(i int) string {
	b := []byte{}
	if i == 0 {
		return "0"
	}
	for ; i > 0; i /= 10 {
		b = append([]byte{byte('0' + i%10)}, b...)
	}
	return string(b)
}

// resolved is resolveTiming's result.
type resolved struct {
	Repeat, StartsOn, Time string
	Null                   bool // startsOn and time are stored null (NOW)
	Weekdays               []int
}

func (r resolved) timing() Timing {
	return Timing{Repeat: r.Repeat, StartsOn: r.StartsOn, Time: r.Time, Weekdays: r.Weekdays}
}

// resolveTiming is the stored timing for an input, falling back to what the push already has.
func resolveTiming(in input, existing *Row, now time.Time) (resolved, error) {
	repeat := "NOW"
	if existing != nil {
		repeat = existing.Repeat
	}
	if in.has["repeat"] {
		repeat = in.Repeat
	}
	switch repeat {
	case "NOW":
		return resolved{Repeat: repeat, Null: true, Weekdays: []int{}}, nil
	case "LATER":
		if in.has["delayMinutes"] {
			startsOn, clock := laterFromDelay(now, in.DelayMinutes)
			return resolved{Repeat: repeat, StartsOn: startsOn, Time: clock, Weekdays: []int{}}, nil
		}
		startsOn, clock := pick(in.Date, in.has["date"], existing, func(r *Row) *string { return r.StartsOn }), pick(in.Time, in.has["time"], existing, func(r *Row) *string { return r.Time })
		if startsOn == "" || clock == "" {
			return resolved{}, svcErr(http.StatusUnprocessableEntity, "NOTICE_PUSH_TIME_REQUIRED", "Pick when it goes out.")
		}
		return resolved{Repeat: repeat, StartsOn: startsOn, Time: clock, Weekdays: []int{}}, nil
	}
	clock := pick(in.Time, in.has["time"], existing, func(r *Row) *string { return r.Time })
	if clock == "" {
		return resolved{}, svcErr(http.StatusUnprocessableEntity, "NOTICE_PUSH_TIME_REQUIRED", "Pick a time.")
	}
	days := []int{}
	if repeat == "WEEKLY" {
		src := in.Weekdays
		if !in.has["weekdays"] && existing != nil {
			src = existing.Weekdays
		}
		for _, d := range src {
			if !slices.Contains(days, d) {
				days = append(days, d)
			}
		}
		slices.Sort(days)
		if len(days) == 0 {
			return resolved{}, svcErr(http.StatusUnprocessableEntity, "NOTICE_PUSH_DAYS_REQUIRED", "Pick at least one day.")
		}
	}
	return resolved{Repeat: repeat, StartsOn: nepalDateOf(now), Time: clock, Weekdays: days}, nil
}

// pick is `input.x ?? existing?.x`: an empty string reads as unset, as the TS falsy checks do.
func pick(v string, given bool, existing *Row, get func(*Row) *string) string {
	if given && v != "" {
		return v
	}
	if existing != nil {
		if s := get(existing); s != nil {
			return *s
		}
	}
	return ""
}

// firstRun leaves a minute of slack, so "today at the current minute" is not refused.
func firstRun(t resolved, now time.Time) *time.Time {
	return NextRun(t.timing(), now.Add(-time.Minute))
}

// defaultPush is what every hostel starts with: Sunday and Wednesday evening,
// for a washing round on Monday and Thursday.
var defaultPush = struct {
	Body, Repeat, SeedKey, Time, Title string
	Weekdays                           []int
}{"Please put 2–3 of your clothes in the laundry basket. The laundry attendant will come tomorrow to wash them.", "WEEKLY", "CLOTHES_WASHING", "18:00", "Clothes Washing Notice", []int{0, 3}}

func (s *Service) seedDefaults(ctx context.Context, hostels []bson.ObjectID, actor bson.ObjectID) {
	now := time.Now().UTC().Truncate(time.Millisecond)
	d := defaultPush
	startsOn := nepalDateOf(now)
	next := NextRun(Timing{Repeat: d.Repeat, StartsOn: startsOn, Time: d.Time, Weekdays: d.Weekdays}, now.Add(-time.Minute))
	var nextV any
	if next != nil {
		nextV = *next
	}
	for _, h := range hostels {
		// Two first opens at once race on the unique index; the loser is fine.
		_, err := s.DB.Collection("noticepushes").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: h}, {Key: "seedKey", Value: d.SeedKey}}, bson.D{{Key: "$setOnInsert", Value: bson.D{
			{Key: "body", Value: d.Body}, {Key: "repeat", Value: d.Repeat}, {Key: "seedKey", Value: d.SeedKey}, {Key: "time", Value: d.Time}, {Key: "title", Value: d.Title}, {Key: "weekdays", Value: d.Weekdays},
			{Key: "createdBy", Value: actor}, {Key: "hostelId", Value: h}, {Key: "isUrgent", Value: false}, {Key: "nextRunAt", Value: nextV}, {Key: "startsOn", Value: startsOn}, {Key: "status", Value: "ACTIVE"},
			{Key: "runCount", Value: 0}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}}}, options.UpdateOne().SetUpsert(true))
		if err != nil && !mongo.IsDuplicateKeyError(err) {
			slog.WarnContext(ctx, "notice_push_seed_failed", "error", err)
		}
	}
}

func (s *Service) announce(ctx context.Context, hostelID bson.ObjectID) {
	realtime.PublishResourceChange(ctx, s.RT, s.Cache, realtime.Change{HostelIDs: []string{hostelID.Hex()}, Topics: []realtime.Topic{realtime.Notices}})
}

func (s *Service) audit(ctx context.Context, actor bson.ObjectID, push *Row, action string) error {
	return s.Audit.Write(ctx, audit.Entry{Action: action, ActorID: actor, EntityID: push.ID.Hex(), EntityType: "NoticePush", HostelID: push.HostelID, Metadata: bson.D{}})
}

func (s *Service) findScoped(ctx context.Context, rawID string, p *authz.Principal, hostelID string) (*Row, error) {
	id, err := opsscope.Param(rawID, "push notice id")
	if err != nil {
		return nil, err
	}
	scope, err := opsscope.Filter(p, hostelID)
	if err != nil {
		return nil, err
	}
	var row Row
	err = s.DB.Collection("noticepushes").FindOne(ctx, append(append(bson.D{{Key: "_id", Value: id}}, scope...), bson.E{Key: "status", Value: bson.D{{Key: "$ne", Value: "DELETED"}}})).Decode(&row)
	if err == mongo.ErrNoDocuments {
		return nil, svcErr(http.StatusNotFound, "NOTICE_PUSH_NOT_FOUND", "Push notice was not found.")
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// emit is one send: a fresh residents' notice plus its push. The copy the last
// send put on the board is expired first, so a repeat never stacks old copies.
func (s *Service) emit(ctx context.Context, push *Row, actor bson.ObjectID, now time.Time) (notices.Delivery, *Row, error) {
	if push.LastNoticeID != nil {
		_, err := s.DB.Collection("notices").UpdateOne(ctx, bson.D{{Key: "_id", Value: *push.LastNoticeID}, {Key: "$or", Value: bson.A{
			bson.D{{Key: "expiresAt", Value: bson.D{{Key: "$exists", Value: false}}}}, bson.D{{Key: "expiresAt", Value: nil}}, bson.D{{Key: "expiresAt", Value: bson.D{{Key: "$gt", Value: now}}}}}}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "expiresAt", Value: now}, {Key: "updatedAt", Value: now}}}})
		if err != nil {
			return notices.Delivery{}, nil, err
		}
	}
	noticeID, delivery, err := s.Notices.Publish(ctx, actor, push.HostelID, push.Title, push.Body, push.IsUrgent, Expiry(push.timing(), now))
	if err != nil {
		return notices.Delivery{}, nil, err
	}
	var updated Row
	err = s.DB.Collection("noticepushes").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: push.ID}}, bson.D{{Key: "$inc", Value: bson.D{{Key: "runCount", Value: 1}}},
		{Key: "$set", Value: bson.D{{Key: "lastNoticeId", Value: noticeID}, {Key: "lastRunAt", Value: now}, {Key: "updatedAt", Value: now}}}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&updated)
	if err == mongo.ErrNoDocuments {
		return delivery, push, nil
	}
	if err != nil {
		return notices.Delivery{}, nil, err
	}
	return delivery, &updated, nil
}

func (s *Service) list(c *gin.Context) {
	p, err := s.Guards.RequireHostelCapability(c, "manageNotices")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var is valid.Issues
	requested := opsscope.Hostel(valid.Query(c), &is)
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostels := opsscope.IDs(p)
	if requested != "" {
		id, err := opsscope.HostelID(p, requested)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		hostels = []bson.ObjectID{id}
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	s.seedDefaults(c, hostels, uid)
	scope, err := opsscope.Filter(p, requested)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err := s.DB.Collection("noticepushes").Find(c, append(scope, bson.E{Key: "status", Value: bson.D{{Key: "$ne", Value: "DELETED"}}}), options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(100))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []Row
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	out := struct {
		Pushes []pushOut `json:"pushes"`
	}{make([]pushOut, len(rows))}
	for i := range rows {
		out.Pushes[i] = serialize(&rows[i])
	}
	httpx.OK(c, out, "Push notices loaded")
}

type pushResult struct {
	Push pushOut `json:"push"`
}

func (s *Service) create(c *gin.Context) {
	p, err := s.Guards.RequireHostelCapability(c, "manageNotices")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, err := parse(body, false)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelID, err := opsscope.HostelID(p, in.HostelID)
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
	timing, err := resolveTiming(in, nil, now)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	next := firstRun(timing, now)
	if timing.Repeat != "NOW" && next == nil {
		httpx.Fail(c, svcErr(http.StatusUnprocessableEntity, "NOTICE_PUSH_NEVER_RUNS", "Pick a time in the future."))
		return
	}
	status := "ACTIVE"
	if timing.Repeat == "NOW" {
		status = "DONE"
	}
	urgent := in.IsUrgent != nil && *in.IsUrgent
	row := Row{ID: bson.NewObjectID(), Body: in.Body, CreatedAt: &now, CreatedBy: uid, HostelID: hostelID, IsUrgent: urgent, NextRunAt: next, Repeat: timing.Repeat,
		Status: status, Title: in.Title, Weekdays: timing.Weekdays}
	var startsOn, clock any
	if !timing.Null {
		row.StartsOn, row.Time = &timing.StartsOn, &timing.Time
		startsOn, clock = timing.StartsOn, timing.Time
	}
	var nextV any
	if next != nil {
		nextV = *next
	}
	_, err = s.DB.Collection("noticepushes").InsertOne(c, bson.D{{Key: "_id", Value: row.ID}, {Key: "hostelId", Value: hostelID}, {Key: "title", Value: in.Title}, {Key: "body", Value: in.Body},
		{Key: "isUrgent", Value: urgent}, {Key: "repeat", Value: timing.Repeat}, {Key: "startsOn", Value: startsOn}, {Key: "time", Value: clock}, {Key: "weekdays", Value: timing.Weekdays},
		{Key: "nextRunAt", Value: nextV}, {Key: "status", Value: status}, {Key: "runCount", Value: 0}, {Key: "createdBy", Value: uid}, {Key: "updatedBy", Value: uid},
		{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := s.audit(c, uid, &row, "NOTICE_PUSH_CREATED"); err != nil {
		httpx.Fail(c, err)
		return
	}
	push := &row
	if timing.Repeat == "NOW" {
		_, push, err = s.emit(c, &row, uid, now)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
	} else {
		s.announce(c.Request.Context(), hostelID)
	}
	httpx.Write(c, http.StatusCreated, pushResult{serialize(push)}, "Push notice saved")
}

func (s *Service) update(c *gin.Context) {
	p, err := s.Guards.RequireHostelCapability(c, "manageNotices")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, err := parse(body, true)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	existing, err := s.findScoped(c, c.Param("id"), p, in.HostelID)
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
	timing, err := resolveTiming(in, existing, now)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	next := firstRun(timing, now)
	touched := in.has["repeat"] || in.has["delayMinutes"] || in.has["date"] || in.has["time"] || in.has["weekdays"]
	paused := existing.Status == "PAUSED"
	if in.Active != nil {
		paused = !*in.Active
	}
	var status string
	switch {
	case timing.Repeat == "NOW":
		status = "DONE"
	case paused:
		status = "PAUSED"
	case next != nil:
		status = "ACTIVE"
	case touched || (in.Active != nil && *in.Active && existing.Status == "PAUSED"):
		httpx.Fail(c, svcErr(http.StatusUnprocessableEntity, "NOTICE_PUSH_NEVER_RUNS", "Pick a time in the future."))
		return
	default:
		status = "DONE"
	}
	var startsOn, clock, nextV any
	if !timing.Null {
		startsOn, clock = timing.StartsOn, timing.Time
	}
	if status == "ACTIVE" && next != nil {
		nextV = *next
	}
	set := bson.D{{Key: "repeat", Value: timing.Repeat}, {Key: "startsOn", Value: startsOn}, {Key: "time", Value: clock}, {Key: "weekdays", Value: timing.Weekdays},
		{Key: "nextRunAt", Value: nextV}, {Key: "status", Value: status}, {Key: "updatedBy", Value: uid}}
	if in.has["title"] {
		set = append(set, bson.E{Key: "title", Value: in.Title})
	}
	if in.has["body"] {
		set = append(set, bson.E{Key: "body", Value: in.Body})
	}
	if in.IsUrgent != nil {
		set = append(set, bson.E{Key: "isUrgent", Value: *in.IsUrgent})
	}
	set = append(set, bson.E{Key: "updatedAt", Value: now})
	var row Row
	err = s.DB.Collection("noticepushes").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: existing.ID}}, bson.D{{Key: "$set", Value: set}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&row)
	if err != nil && err != mongo.ErrNoDocuments {
		httpx.Fail(c, err)
		return
	}
	out := &row
	if err == mongo.ErrNoDocuments {
		out = existing
	}
	if err := s.audit(c, uid, existing, "NOTICE_PUSH_UPDATED"); err != nil {
		httpx.Fail(c, err)
		return
	}
	s.announce(c.Request.Context(), existing.HostelID)
	httpx.OK(c, pushResult{serialize(out)}, "Push notice updated")
}

// scoped is the guard plus noticePushScopeSchema read from the query.
func (s *Service) scoped(c *gin.Context) (*authz.Principal, string, bool) {
	p, err := s.Guards.RequireHostelCapability(c, "manageNotices")
	if err != nil {
		httpx.Fail(c, err)
		return nil, "", false
	}
	var is valid.Issues
	hostelID := opsscope.Hostel(valid.Query(c), &is)
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return nil, "", false
	}
	return p, hostelID, true
}

func (s *Service) remove(c *gin.Context) {
	p, hostelID, ok := s.scoped(c)
	if !ok {
		return
	}
	existing, err := s.findScoped(c, c.Param("id"), p, hostelID)
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
	_, err = s.DB.Collection("noticepushes").UpdateOne(c, bson.D{{Key: "_id", Value: existing.ID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "nextRunAt", Value: nil}, {Key: "status", Value: "DELETED"}, {Key: "updatedBy", Value: uid}, {Key: "updatedAt", Value: now}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := s.audit(c, uid, existing, "NOTICE_PUSH_DELETED"); err != nil {
		httpx.Fail(c, err)
		return
	}
	s.announce(c.Request.Context(), existing.HostelID)
	httpx.OK(c, struct {
		ID string `json:"id"`
	}{existing.ID.Hex()}, "Push notice deleted")
}

// sendNow sends right now, whatever the schedule says; the schedule is untouched.
func (s *Service) sendNow(c *gin.Context) {
	p, hostelID, ok := s.scoped(c)
	if !ok {
		return
	}
	existing, err := s.findScoped(c, c.Param("id"), p, hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	delivery, push, err := s.emit(c, existing, uid, time.Now().UTC().Truncate(time.Millisecond))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := s.audit(c, uid, existing, "NOTICE_PUSH_SENT"); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, struct {
		Delivery notices.Delivery `json:"delivery"`
		Push     pushOut          `json:"push"`
	}{delivery, serialize(push)}, "Push notice sent")
}

// repeatGrace is how late a repeat's run may be before it is skipped, not sent late.
const repeatGrace = 30 * time.Minute

// DispatchResult is dispatchDueNoticePushes' tally.
type DispatchResult struct {
	Due, Failed, Sent, Skipped int
}

// Dispatch is the cron: it sends every push notice whose nextRunAt has passed.
// The claim is the advance: nextRunAt moves on with a filter on its old value,
// so the every-minute job and the fallback cannot both send one run.
func (s *Service) Dispatch(ctx context.Context, now time.Time) (DispatchResult, error) {
	cur, err := s.DB.Collection("noticepushes").Find(ctx, bson.D{{Key: "nextRunAt", Value: bson.D{{Key: "$lte", Value: now}}}, {Key: "status", Value: "ACTIVE"}},
		options.Find().SetSort(bson.D{{Key: "nextRunAt", Value: 1}}).SetLimit(50))
	if err != nil {
		return DispatchResult{}, err
	}
	var due []Row
	if err := cur.All(ctx, &due); err != nil {
		return DispatchResult{}, err
	}
	out := DispatchResult{Due: len(due)}
	for i := range due {
		push := &due[i]
		var following *time.Time
		if push.Repeat != "LATER" {
			following = NextRun(push.timing(), now)
		}
		stale := push.Repeat != "LATER" && push.NextRunAt != nil && now.Sub(*push.NextRunAt) > repeatGrace
		status := "DONE"
		var followingV any
		if following != nil {
			status, followingV = "ACTIVE", *following
		}
		var claimed Row
		err := s.DB.Collection("noticepushes").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: push.ID}, {Key: "nextRunAt", Value: push.NextRunAt}, {Key: "status", Value: "ACTIVE"}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "nextRunAt", Value: followingV}, {Key: "status", Value: status}, {Key: "updatedAt", Value: now}}}},
			options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&claimed)
		if err == mongo.ErrNoDocuments {
			continue
		}
		if err != nil {
			return out, err
		}
		if stale {
			out.Skipped++
			continue
		}
		if _, _, err := s.emit(ctx, &claimed, push.CreatedBy, now); err != nil {
			out.Failed++
			slog.ErrorContext(ctx, "notice_push_scheduled_send_failed", "pushId", push.ID.Hex(), "error", err)
			continue
		}
		out.Sent++
	}
	return out, nil
}

var _ ordered.Map
