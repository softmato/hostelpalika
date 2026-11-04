package log

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/indexes"
)

// Collection holds the stored lines; Go-only, so Go owns its index.
const Collection = "serverlogs"

const (
	queueSize   = 4096
	batchSize   = 200
	flushEvery  = time.Second
	keepFor     = 30 * 24 * time.Hour
	surgeWindow = 10 * time.Second
	surgeCap    = 300 // stored lines per category per window; the rest only reach stdout
)

// Entry is one stored line.
type Entry struct {
	ID         bson.ObjectID  `bson:"_id" json:"id"`
	At         time.Time      `bson:"at" json:"at"`
	Level      string         `bson:"level" json:"level"`
	Category   string         `bson:"category" json:"category"`
	Message    string         `bson:"message" json:"message"`
	RequestID  string         `bson:"requestId,omitempty" json:"requestId,omitempty"`
	Method     string         `bson:"method,omitempty" json:"method,omitempty"`
	Route      string         `bson:"route,omitempty" json:"route,omitempty"`
	Status     int            `bson:"status,omitempty" json:"status,omitempty"`
	DurationMs float64        `bson:"durationMs,omitempty" json:"durationMs,omitempty"`
	UserID     string         `bson:"userId,omitempty" json:"userId,omitempty"`
	HostelID   string         `bson:"hostelId,omitempty" json:"hostelId,omitempty"`
	Attrs      map[string]any `bson:"attrs,omitempty" json:"attrs,omitempty"`
}

type sink struct {
	ch      chan Entry
	dropped atomic.Int64
	quit    chan struct{}
	done    chan struct{}

	mu    sync.Mutex
	start time.Time
	count map[string]int
}

var current atomic.Pointer[sink]

// Dropped counts lines refused by a full queue, the surge cap or a failed write.
func Dropped() int64 {
	if s := current.Load(); s != nil {
		return s.dropped.Load()
	}
	return 0
}

// IndexSpecs for the stored lines; built by cmd/indexes (RULES.md §6).
var IndexSpecs = []indexes.Spec{
	{Collection: Collection, Keys: bson.D{{Key: "at", Value: 1}}, TTLSeconds: ttl(keepFor)},
	{Collection: Collection, Keys: bson.D{{Key: "requestId", Value: 1}}, Sparse: true},
	{Collection: Collection, Keys: bson.D{{Key: "category", Value: 1}, {Key: "_id", Value: -1}}},
}

func ttl(d time.Duration) *int32 { s := int32(d.Seconds()); return &s }

// Attach starts storing lines in db and returns the flush-and-stop function.
// A request never waits on it: a full queue drops and counts.
func Attach(ctx context.Context, db *mongo.Database) (stop func(), err error) {
	coll := db.Collection(Collection)
	s := &sink{ch: make(chan Entry, queueSize), quit: make(chan struct{}), done: make(chan struct{}), count: map[string]int{}}
	current.Store(s)
	go s.run(coll)
	// ch is never closed: a line racing the stop lands in the buffer, not a panic.
	return func() { current.CompareAndSwap(s, nil); close(s.quit); <-s.done }, nil
}

func (s *sink) run(coll *mongo.Collection) {
	defer close(s.done)
	batch := make([]any, 0, batchSize)
	tick := time.NewTicker(flushEvery)
	defer tick.Stop()
	flush := func() {
		if len(batch) == 0 {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		// Unordered: one bad row must not cost the rest. Its own failure is
		// not logged, or a Mongo outage would feed itself.
		if _, err := coll.InsertMany(ctx, batch, options.InsertMany().SetOrdered(false)); err != nil {
			s.dropped.Add(int64(len(batch)))
		}
		cancel()
		batch = batch[:0]
	}
	for {
		select {
		case <-s.quit:
			for {
				select {
				case e := <-s.ch:
					if batch = append(batch, e); len(batch) == batchSize {
						flush()
					}
				default:
					flush()
					return
				}
			}
		case e := <-s.ch:
			if batch = append(batch, e); len(batch) == batchSize {
				flush()
			}
		case <-tick.C:
			flush()
		}
	}
}

func (s *sink) allow(cat string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if now.Sub(s.start) >= surgeWindow {
		s.start, s.count = now, map[string]int{}
	}
	s.count[cat]++
	return s.count[cat] <= surgeCap
}

func keep(r slog.Record, pre []slog.Attr, cat, requestID string) {
	s := current.Load()
	if s == nil {
		return
	}
	if !s.allow(cat, r.Time) {
		s.dropped.Add(1)
		return
	}
	e := Entry{ID: bson.NewObjectIDFromTimestamp(r.Time), At: r.Time.UTC(), Level: levelName(r.Level),
		Category: cat, Message: r.Message, RequestID: requestID}
	add := func(a slog.Attr) bool {
		a = redact(nil, a)
		v := a.Value.Resolve()
		switch a.Key {
		case "category", "operational":
		case "method":
			e.Method = v.String()
		case "route", "path":
			e.Route = v.String()
		case "status":
			e.Status = int(v.Int64())
		case "app_ms":
			e.DurationMs = v.Float64()
		case "user", "userId":
			e.UserID = v.String()
		case "hostel", "hostelId":
			e.HostelID = v.String()
		default:
			if e.Attrs == nil {
				e.Attrs = map[string]any{}
			}
			e.Attrs[a.Key] = plain(v)
		}
		return true
	}
	for _, a := range pre {
		add(a)
	}
	r.Attrs(add)
	select {
	case s.ch <- e:
	default:
		s.dropped.Add(1)
	}
}

func plain(v slog.Value) any {
	switch v.Kind() {
	case slog.KindString:
		return v.String()
	case slog.KindInt64:
		return v.Int64()
	case slog.KindUint64:
		return v.Uint64()
	case slog.KindFloat64:
		return v.Float64()
	case slog.KindBool:
		return v.Bool()
	case slog.KindDuration:
		return v.Duration().String()
	case slog.KindTime:
		return v.Time()
	case slog.KindGroup:
		m := map[string]any{}
		for _, a := range v.Group() {
			a = redact(nil, a)
			m[a.Key] = plain(a.Value.Resolve())
		}
		return m
	}
	if err, ok := v.Any().(error); ok {
		return err.Error()
	}
	return fmt.Sprint(v.Any())
}

func levelName(l slog.Level) string {
	switch {
	case l >= slog.LevelError:
		return "error"
	case l >= slog.LevelWarn:
		return "warn"
	case l >= slog.LevelInfo:
		return "info"
	}
	return "debug"
}
