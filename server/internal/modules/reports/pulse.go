// Package reports: so far the public home-page pulse (platform-pulse.service.ts).
package reports

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

type Handler struct {
	db *mongo.Database

	mu    sync.Mutex
	at    time.Time
	pulse *Pulse
}

func NewHandler(db *mongo.Database) *Handler { return &Handler{db: db} }

func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.GET("/public/pulse", h.get)
}

type latest struct {
	City string `json:"city"`
	Name any    `json:"name"`
}

// Pulse is PlatformPulse: counts below ten are null rather than said out loud.
type Pulse struct {
	Hostels    *int64  `json:"hostels"`
	Residents  *int64  `json:"residents"`
	AddedToday int64   `json:"addedToday"`
	Latest     *latest `json:"latest"`
}

const minPublicCount = 10

var liveHostels = bson.D{{Key: "isDeleted", Value: false}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"APPROVED", "PUBLISHED"}}}}}

// nepalDayStart is midnight in Kathmandu (UTC+5:45) as an instant.
func nepalDayStart(now time.Time) time.Time {
	const offset = (5*60 + 45) * int64(time.Minute/time.Millisecond)
	const day = 24 * int64(time.Hour/time.Millisecond)
	ms := now.UnixMilli()
	return time.UnixMilli((ms+offset)/day*day - offset).UTC()
}

func atLeast(n int64) *int64 {
	if n >= minPublicCount {
		return &n
	}
	return nil
}

// Pulse is getPlatformPulse, held a minute per instance like TS.
func (h *Handler) Pulse(ctx context.Context) (*Pulse, error) {
	h.mu.Lock()
	if h.pulse != nil && time.Since(h.at) < time.Minute {
		p := h.pulse
		h.mu.Unlock()
		return p, nil
	}
	h.mu.Unlock()
	hostels := h.db.Collection("hostels")
	today := append(append(bson.D{}, liveHostels...), bson.E{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: nepalDayStart(time.Now())}}})
	live, err := hostels.CountDocuments(ctx, liveHostels)
	if err != nil {
		return nil, err
	}
	residents, err := h.db.Collection("residents").CountDocuments(ctx, bson.D{{Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}})
	if err != nil {
		return nil, err
	}
	added, err := hostels.CountDocuments(ctx, today)
	if err != nil {
		return nil, err
	}
	var row struct {
		Name     any `bson:"name"`
		Location *struct {
			City *string `bson:"city"`
		} `bson:"location"`
	}
	p := &Pulse{Hostels: atLeast(live), Residents: atLeast(residents), AddedToday: added}
	err = hostels.FindOne(ctx, today, options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "location.city", Value: 1}})).Decode(&row)
	switch {
	case err == nil:
		city := ""
		if row.Location != nil && row.Location.City != nil {
			city = *row.Location.City
		}
		p.Latest = &latest{City: city, Name: row.Name}
	case !errors.Is(err, mongo.ErrNoDocuments):
		return nil, err
	}
	h.mu.Lock()
	h.pulse, h.at = p, time.Now()
	h.mu.Unlock()
	return p, nil
}

func (h *Handler) get(c *gin.Context) {
	p, err := h.Pulse(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.PublicCache(c)
	httpx.OK(c, gin.H{"pulse": p}, "Platform pulse loaded")
}
