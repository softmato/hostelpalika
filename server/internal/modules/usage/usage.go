// Package usage is the usage watcher's inbox (modules/usage): batches of opens,
// screen times and feature uses from the app and the web portals.
package usage

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ratelimit"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

const (
	maxScreenMs = 6 * 60 * 60 * 1000
	maxAge      = 7 * 24 * time.Hour
	maxSkew     = 5 * time.Minute
)

type Handler struct {
	db      *mongo.Database
	guards  *authz.Guards
	limiter *ratelimit.Limiter
}

func NewHandler(db *mongo.Database, guards *authz.Guards, limiter *ratelimit.Limiter) *Handler {
	return &Handler{db, guards, limiter}
}

func (h *Handler) Register(v1 *gin.RouterGroup) { v1.POST("/usage/events", h.events) }

type event struct {
	At         time.Time
	DurationMs int64
	Feature    string
	Kind       string
	Screen     string
}

var (
	// An id-shaped path segment: object id, number, uuid or a long token.
	idSegment = regexp.MustCompile(`(?i)^(?:[a-f\d]{24}|\d+|[a-f\d]{8}-[a-f\d-]{27}|[\w-]{25,})$`)
	adminHost = regexp.MustCompile(`^/[^/]+/admin(/|$)`)
	apiPrefix = regexp.MustCompile(`^/api/v1(/)`)
	httpHost  = regexp.MustCompile(`(?i)^https?://[^/]+`)
	spaces    = regexp.MustCompile(`\s+`)
)

// path is usagePath: query and hash gone, the tenant slug in /{slug}/admin
// turned into :hostel and every id-shaped segment into :id.
func path(p string) string {
	if i := strings.IndexAny(p, "?#"); i >= 0 {
		p = p[:i]
	}
	p = adminHost.ReplaceAllString(p, "/:hostel/admin$1")
	segs := strings.Split(p, "/")
	for i, s := range segs {
		if i > 0 && idSegment.MatchString(s) {
			segs[i] = ":id"
		}
	}
	p = strings.TrimRight(strings.Join(segs, "/"), "/")
	p = utf16Prefix(p, 120)
	if p == "" {
		return "/"
	}
	return p
}

// utf16Prefix is String#slice(0, n).
func utf16Prefix(s string, n int) string {
	out, count := []rune{}, 0
	for _, r := range s {
		w := 1
		if r > 0xFFFF {
			w = 2
		}
		if count+w > n {
			break
		}
		out, count = append(out, r), count+w
	}
	return string(out)
}

// featurePath is usageFeature: `POST /api/v1/x/66ab…` → `POST /x/:id`.
func featurePath(feature string) string {
	f := spaces.Split(valid.Trim(feature), -1)
	method, rest := f[0], f[1:]
	p := strings.Join(rest, "")
	if p == "" {
		p = method
	}
	verb := ""
	if len(rest) > 0 {
		verb = strings.ToUpper(method) + " "
	}
	p = httpHost.ReplaceAllString(p, "")
	p = apiPrefix.ReplaceAllString(p, "$1")
	return verb + path(p)
}

// parse is usageBatchSchema.
func parse(body any) (string, []event, error) {
	f := valid.NewForm(body)
	client, _ := f.Enum("client", false, nil, "app", "web")
	var evs []event
	if items, ok := f.Array("events", false, false); ok {
		aborted := false
		for i, raw := range items {
			p := "events." + strconv.Itoa(i)
			m, isObj := raw.(map[string]any)
			if !isObj {
				aborted = true
				f.Is.Add(p, valid.Type("object", valid.Received(raw, false)))
				continue
			}
			sub := &valid.Form{M: m}
			var e event
			at, present := m["at"]
			if t, good := valid.CoerceDate(at); good && present {
				e.At = t
			} else {
				sub.Is.Add("at", valid.Type("date", "Date")) // an Invalid Date, whatever was sent
			}
			if n, ok := sub.Num("durationMs", valid.N{Opt: true, Int: true, Min: valid.P(0), Max: valid.P(maxScreenMs)}); ok {
				e.DurationMs = int64(n)
			}
			e.Feature, _ = sub.Str("feature", valid.S{Opt: true, Trim: true, Max: 200})
			e.Kind, _ = sub.Enum("kind", false, nil, "open", "screen", "feature")
			e.Screen, _ = sub.Str("screen", valid.S{Opt: true, Trim: true, Max: 200})
			for _, is := range sub.Is {
				f.Is.Add(p+"."+is.Path, is.Message)
			}
			evs = append(evs, e)
		}
		f.Size("events", len(items), 1, 200, "", aborted)
	}
	return client, evs, f.Err()
}

type dailyKey struct{ day, screen, feature string }

type dailyRow struct {
	key                            dailyKey
	durationMs, opens, uses, views int64
}

type kept struct {
	event
	durationMs int64
	feature    string
	screen     string
}

// rollUp is rollUpUsage: events outside the clock window are dropped, names
// normalised, one row per (day, screen, feature).
func rollUp(events []event, now time.Time) ([]kept, []*dailyRow) {
	var out []kept
	rows := map[dailyKey]*dailyRow{}
	var order []*dailyRow
	for _, e := range events {
		if e.At.Before(now.Add(-maxAge)) || e.At.After(now.Add(maxSkew)) {
			continue
		}
		screen, feature := "", ""
		if e.Kind == "screen" && e.Screen != "" {
			screen = path(e.Screen)
		}
		if e.Kind == "feature" && e.Feature != "" {
			feature = featurePath(e.Feature)
		}
		if (e.Kind == "screen" && screen == "") || (e.Kind == "feature" && feature == "") {
			continue
		}
		var dur int64
		if e.Kind == "screen" {
			dur = e.DurationMs
		}
		k := dailyKey{bs.CalendarDay(e.At).Format("2006-01-02"), screen, feature}
		r := rows[k]
		if r == nil {
			r = &dailyRow{key: k}
			rows[k] = r
			order = append(order, r)
		}
		switch e.Kind {
		case "open":
			r.opens++
		case "screen":
			r.views++
			r.durationMs += dur
		case "feature":
			r.uses++
		}
		out = append(out, kept{e, dur, feature, screen})
	}
	return out, order
}

type recorded struct {
	Recorded int `json:"recorded"`
}

func (h *Handler) events(c *gin.Context) {
	// Clients batch, so a device past this is looping, not using the app.
	if err := h.limiter.Check(c, "usage-events", 30, h.limiter.FormWindow); err != nil {
		httpx.Fail(c, err)
		return
	}
	p, err := h.guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	client, evs, err := parse(body)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	n, err := h.record(c, p, client, evs, time.Now())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, recorded{n}, "Usage recorded")
}

func (h *Handler) record(ctx context.Context, p *authz.Principal, client string, evs []event, now time.Time) (int, error) {
	events, rows := rollUp(evs, now)
	if len(events) == 0 {
		return 0, nil
	}
	userID, _ := bson.ObjectIDFromHex(p.UserID)
	var hostelID any
	if len(p.HostelIDs) > 0 {
		if id, err := bson.ObjectIDFromHex(p.HostelIDs[0]); err == nil {
			hostelID = id
		}
	}
	docs := make([]any, len(events))
	for i, e := range events {
		docs[i] = bson.D{{Key: "userId", Value: userID}, {Key: "role", Value: string(p.Role)}, {Key: "hostelId", Value: hostelID},
			{Key: "client", Value: client}, {Key: "kind", Value: e.Kind}, {Key: "screen", Value: e.screen}, {Key: "feature", Value: e.feature},
			{Key: "durationMs", Value: e.durationMs}, {Key: "at", Value: e.At}, {Key: "createdAt", Value: now.UTC()}, {Key: "__v", Value: 0}}
	}
	if _, err := h.db.Collection("usageevents").InsertMany(ctx, docs, options.InsertMany().SetOrdered(false)); err != nil {
		return 0, err
	}
	models := make([]mongo.WriteModel, len(rows))
	for i, r := range rows {
		models[i] = mongo.NewUpdateOneModel().SetUpsert(true).
			SetFilter(bson.D{{Key: "day", Value: r.key.day}, {Key: "feature", Value: r.key.feature}, {Key: "hostelId", Value: hostelID},
				{Key: "screen", Value: r.key.screen}, {Key: "userId", Value: userID}}).
			SetUpdate(bson.D{{Key: "$inc", Value: bson.D{{Key: "durationMs", Value: r.durationMs}, {Key: "opens", Value: r.opens},
				{Key: "uses", Value: r.uses}, {Key: "views", Value: r.views}}}, {Key: "$set", Value: bson.D{{Key: "role", Value: string(p.Role)}}}})
	}
	if _, err := h.db.Collection("usagedailies").BulkWrite(ctx, models, options.BulkWrite().SetOrdered(false)); err != nil {
		return 0, err
	}
	return len(events), nil
}
