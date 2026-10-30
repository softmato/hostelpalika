package notifications

import (
	"context"
	"log/slog"
	"time"
	_ "time/tzdata" // Asia/Kathmandu must resolve on a bare container

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/background"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/push"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
)

// Service writes the bell rows and fans them out (notification.service.ts
// createInAppNotification + publishNewNotification).
type Service struct {
	DB   *mongo.Database
	Push *push.Sender
	RT   *realtime.Client
	// Cache's Bump skips a hostel's cached reads; nil in tests.
	Cache realtime.Bumper
	BG    *background.Runner
}

// Input is createInAppNotification's argument.
type Input struct {
	Actions   []Action
	ActionURL string
	Body      string
	Category  string
	CreatedBy string
	Data      ordered.Map
	HostelID  string
	ImageURL  string
	Kind      string // "" = NORMAL, or ACTION when a destination or buttons are given
	// NoPush suppresses only the per-row Expo send: the live bell and the topic
	// fan-out still happen.
	NoPush   bool
	Priority string
	Title    string
	UserID   string
}

// Action is one inline button of an ACTION row.
type Action struct {
	Endpoint string      `json:"endpoint" bson:"endpoint"`
	Key      string      `json:"key" bson:"key"`
	Label    string      `json:"label" bson:"label"`
	Method   string      `json:"method,omitempty" bson:"method"`
	Payload  ordered.Map `json:"payload,omitempty" bson:"payload,omitempty"`
	Tone     string      `json:"tone,omitempty" bson:"tone"`
}

// Row is a written notification, as the realtime channel and the bell see it.
type Row struct {
	ID        bson.ObjectID
	CreatedAt time.Time
	Input     Input
	Kind      string
	Priority  string
}

func objectID(s string) (bson.ObjectID, bool) {
	id, err := bson.ObjectIDFromHex(s)
	return id, err == nil
}

// CreateInApp writes the row and fans it out to the recipient's socket, the
// panels its category implies, and their phones.
func (s *Service) CreateInApp(ctx context.Context, in Input) (Row, error) {
	kind := in.Kind
	if kind == "" {
		kind = "NORMAL"
		if in.ActionURL != "" || len(in.Actions) > 0 {
			kind = "ACTION"
		}
	}
	priority := in.Priority
	if priority == "" {
		priority = "NORMAL"
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	id := bson.NewObjectID()
	uid, _ := objectID(in.UserID)
	doc := bson.D{{Key: "_id", Value: id}, {Key: "userId", Value: uid}}
	if hid, ok := objectID(in.HostelID); ok {
		doc = append(doc, bson.E{Key: "hostelId", Value: hid})
	}
	doc = append(doc, bson.E{Key: "title", Value: in.Title}, bson.E{Key: "body", Value: in.Body}, bson.E{Key: "category", Value: in.Category},
		bson.E{Key: "kind", Value: kind})
	if in.ActionURL != "" {
		doc = append(doc, bson.E{Key: "actionUrl", Value: in.ActionURL})
	}
	if kind == "ACTION" && len(in.Actions) > 0 {
		acts := make(bson.A, len(in.Actions))
		for i, a := range in.Actions {
			method, tone := a.Method, a.Tone
			if method == "" {
				method = "POST"
			}
			if tone == "" {
				tone = "default"
			}
			d := bson.D{{Key: "endpoint", Value: a.Endpoint}, {Key: "key", Value: a.Key}, {Key: "label", Value: a.Label}, {Key: "method", Value: method}}
			if a.Payload != nil {
				d = append(d, bson.E{Key: "payload", Value: ordered.ToBSON(a.Payload)})
			}
			acts[i] = append(d, bson.E{Key: "tone", Value: tone})
		}
		doc = append(doc, bson.E{Key: "actions", Value: acts})
	}
	data := in.Data
	if data == nil {
		data = ordered.Map{}
	}
	doc = append(doc, bson.E{Key: "actionState", Value: "PENDING"}, bson.E{Key: "channel", Value: "IN_APP"}, bson.E{Key: "data", Value: ordered.ToBSON(data)})
	if cb, ok := objectID(in.CreatedBy); ok {
		doc = append(doc, bson.E{Key: "createdBy", Value: cb})
	}
	doc = append(doc, bson.E{Key: "priority", Value: priority}, bson.E{Key: "status", Value: "SENT"},
		bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := s.DB.Collection("notifications").InsertOne(ctx, doc, options.InsertOne()); err != nil {
		return Row{}, err
	}
	row := Row{ID: id, CreatedAt: now, Input: in, Kind: kind, Priority: priority}
	s.publish(ctx, row)
	return row, nil
}

// serialized is serializeNotification, key order and all.
func (r Row) serialized() ordered.Map {
	in := r.Input
	var actions any = []any{}
	if r.Kind == "ACTION" && len(in.Actions) > 0 {
		actions = in.Actions
	}
	m := ordered.Map{{Key: "actions", Value: actions}, {Key: "actionState", Value: "PENDING"},
		{Key: "actionTakenAt", Value: ordered.Undefined}, {Key: "actionTakenKey", Value: ordered.Undefined}}
	if in.ActionURL != "" {
		m = m.Set("actionUrl", in.ActionURL)
	} else {
		m = m.Set("actionUrl", ordered.Undefined)
	}
	data := in.Data
	if data == nil {
		data = ordered.Map{}
	}
	hostel := any(ordered.Undefined)
	if in.HostelID != "" {
		hostel = in.HostelID
	}
	return append(m, ordered.Pair{Key: "body", Value: in.Body}, ordered.Pair{Key: "category", Value: in.Category},
		ordered.Pair{Key: "channel", Value: "IN_APP"}, ordered.Pair{Key: "createdAt", Value: httpx.ISO(r.CreatedAt)},
		ordered.Pair{Key: "data", Value: data}, ordered.Pair{Key: "hostelId", Value: hostel}, ordered.Pair{Key: "id", Value: r.ID.Hex()},
		ordered.Pair{Key: "isRead", Value: false}, ordered.Pair{Key: "kind", Value: r.Kind},
		ordered.Pair{Key: "needsAction", Value: r.Kind == "ACTION"}, ordered.Pair{Key: "priority", Value: r.Priority},
		ordered.Pair{Key: "readAt", Value: ordered.Undefined}, ordered.Pair{Key: "status", Value: "SENT"},
		ordered.Pair{Key: "title", Value: in.Title}, ordered.Pair{Key: "userId", Value: in.UserID})
}

// publish is publishNewNotification: the Expo/web push (off the response's
// critical path), then the live bell and the topic fan-out. Wholly best-effort:
// the row is already committed.
func (s *Service) publish(ctx context.Context, r Row) {
	in := r.Input
	if !in.NoPush && s.Push != nil {
		payload := push.Payload{ActionURL: in.ActionURL, Body: in.Body, Category: in.Category, Data: dataMap(in.Data), HostelID: in.HostelID,
			ImageURL: in.ImageURL, NotificationID: r.ID.Hex(), Priority: in.Priority, Title: in.Title}
		send := func(ctx context.Context) error { s.Push.ToUsers(ctx, []string{in.UserID}, payload); return nil }
		if s.BG != nil {
			s.BG.After(ctx, send)
		} else {
			_ = send(ctx)
		}
	}
	defer func() {
		if p := recover(); p != nil {
			slog.WarnContext(ctx, "notification publish failed", "panic", p)
		}
	}()
	if s.RT != nil {
		s.RT.PublishNotification(ctx, in.UserID, r.serialized())
	}
	if topics := realtime.TopicsForCategory(in.Category); len(topics) > 0 {
		realtime.PublishResourceChange(ctx, s.RT, s.Cache, realtime.Change{Topics: topics, UserIDs: []string{in.UserID}})
	}
}

func dataMap(m ordered.Map) map[string]any {
	out := make(map[string]any, len(m))
	for _, p := range m {
		out[p.Key] = p.Value
	}
	return out
}
