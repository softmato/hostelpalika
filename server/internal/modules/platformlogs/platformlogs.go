// Package platformlogs is the superadmin log viewer's API over the stored
// server log lines (platform/log), and the watcher that applies the per-category
// levels from site config. Go-only: TS never stored its logs.
package platformlogs

import (
	"context"
	"log/slog"
	"regexp"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	applog "github.com/softmato/hostelpalika/server/internal/platform/log"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

var levels = []string{"debug", "info", "warn", "error"}

type Handler struct {
	coll   *mongo.Collection
	guards *authz.Guards
}

func NewHandler(db *mongo.Database, guards *authz.Guards) *Handler {
	return &Handler{db.Collection(applog.Collection), guards}
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.GET("/platform/logs", h.list)
	v1.GET("/platform/logs/summary", h.summary)
}

// timeRange reads from/to (RFC 3339); summary defaults to the last day.
func timeRange(q map[string]string, is *valid.Issues, def time.Duration) bson.D {
	r := bson.D{}
	for _, k := range []string{"from", "to"} {
		raw, ok := q[k]
		if !ok {
			continue
		}
		t, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			is.Add(k, "Invalid datetime")
			continue
		}
		op := "$gte"
		if k == "to" {
			op = "$lte"
		}
		r = append(r, bson.E{Key: op, Value: t})
	}
	if len(r) == 0 && def > 0 {
		r = bson.D{{Key: "$gte", Value: time.Now().Add(-def)}}
	}
	return r
}

func (h *Handler) list(c *gin.Context) {
	if _, err := h.guards.RequireSuperadmin(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	f := bson.D{}
	if v := valid.QueryEnum(q, "level", &is, levels...); v != nil {
		f = append(f, bson.E{Key: "level", Value: *v})
	}
	if v := valid.QueryEnum(q, "category", &is, applog.Categories...); v != nil {
		f = append(f, bson.E{Key: "category", Value: *v})
	}
	for key, field := range map[string]string{"route": "route", "requestId": "requestId", "userId": "userId", "hostelId": "hostelId"} {
		if v := valid.QueryString(q, key, 1, 200, &is); v != nil {
			f = append(f, bson.E{Key: field, Value: *v})
		}
	}
	if v := valid.QueryString(q, "q", 1, 200, &is); v != nil {
		f = append(f, bson.E{Key: "message", Value: bson.D{{Key: "$regex", Value: regexp.QuoteMeta(*v)}, {Key: "$options", Value: "i"}}})
	}
	if r := timeRange(q, &is, 0); len(r) > 0 {
		f = append(f, bson.E{Key: "at", Value: r})
	}
	if raw, ok := q["cursor"]; ok {
		id, err := bson.ObjectIDFromHex(raw)
		if err != nil {
			is.Add("cursor", "Invalid cursor")
		}
		f = append(f, bson.E{Key: "_id", Value: bson.D{{Key: "$lt", Value: id}}})
	}
	limit := 50
	if v := valid.QueryNumber(q, "limit", true, &is); v != nil {
		limit = max(1, min(200, int(*v)))
	}
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err := h.coll.Find(c, f, options.Find().SetSort(bson.D{{Key: "_id", Value: -1}}).SetLimit(int64(limit+1)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	entries := []applog.Entry{}
	if err := cur.All(c, &entries); err != nil {
		httpx.Fail(c, err)
		return
	}
	var next *string
	if len(entries) > limit {
		entries = entries[:limit]
		s := entries[limit-1].ID.Hex()
		next = &s
	}
	httpx.OK(c, ordered.Map{{Key: "entries", Value: entries}, {Key: "nextCursor", Value: next}}, "Server logs loaded")
}

type count struct {
	Level    string `bson:"level" json:"level"`
	Category string `bson:"category" json:"category"`
	Count    int64  `bson:"count" json:"count"`
}

func (h *Handler) summary(c *gin.Context) {
	if _, err := h.guards.RequireSuperadmin(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	var is valid.Issues
	r := timeRange(valid.Query(c), &is, 24*time.Hour)
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err := h.coll.Aggregate(c, mongo.Pipeline{
		{{Key: "$match", Value: bson.D{{Key: "at", Value: r}}}},
		{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: bson.D{{Key: "level", Value: "$level"}, {Key: "category", Value: "$category"}}},
			{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
		}}},
		{{Key: "$project", Value: bson.D{{Key: "_id", Value: 0}, {Key: "level", Value: "$_id.level"}, {Key: "category", Value: "$_id.category"}, {Key: "count", Value: 1}}}},
		{{Key: "$sort", Value: bson.D{{Key: "category", Value: 1}, {Key: "level", Value: 1}}}},
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	counts := []count{}
	if err := cur.All(c, &counts); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "counts", Value: counts}, {Key: "dropped", Value: applog.Dropped()}, {Key: "categories", Value: applog.Categories}}, "Server log summary loaded")
}

// Watch applies site config's `logs.levels` now and then every interval, so
// a superadmin's change reaches every instance without a restart.
func Watch(ctx context.Context, cfg *platformconfig.Service, every time.Duration) {
	apply := func() {
		v, err := cfg.Section(ctx, "logs")
		if err != nil {
			return // the levels in force stay until the next read works
		}
		var s struct {
			Levels map[string]string `json:"levels"`
		}
		if platformconfig.Decode(v, &s) != nil {
			return
		}
		applog.SetCategoryLevels(parseLevels(s.Levels))
	}
	apply()
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			apply()
		}
	}
}

func parseLevels(in map[string]string) map[string]slog.Level {
	out := map[string]slog.Level{}
	for cat, name := range in {
		var l slog.Level
		if name != "default" && l.UnmarshalText([]byte(name)) == nil {
			out[cat] = l
		}
	}
	return out
}
