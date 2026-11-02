// Package hostelrooms is modules/hostels/hostel-capacity.service and
// hostel-rooms.service: the per-type bed counts on Hostel.roomConfigurations,
// the numbered floor plan under them, and the room-change queue.
package hostelrooms

import (
	"context"
	"errors"
	"math"
	"net/http"
	"sort"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
)

// Capacity owns the roomConfigurations array. Every claim, release and move
// ends in Write, so one realtime publish covers all three.
type Capacity struct {
	DB   *mongo.Database
	RT   *realtime.Client
	Bump realtime.Bumper
}

// Config is one roomConfigurations row, kept as the stored document so fields
// this code never reads (securityDeposit, _id, mealInclusion) survive a write.
type Config bson.D

func (c Config) get(key string) any {
	for _, e := range c {
		if e.Key == key {
			return e.Value
		}
	}
	return nil
}

func (c *Config) set(key string, v any) {
	for i := range *c {
		if (*c)[i].Key == key {
			(*c)[i].Value = v
			return
		}
	}
	*c = append(*c, bson.E{Key: key, Value: v})
}

func numOf(v any) (float64, bool) {
	switch n := v.(type) {
	case int32:
		return float64(n), true
	case int64:
		return float64(n), true
	case float64:
		return n, true
	}
	return 0, false
}

func (c Config) num(key string) float64 { n, _ := numOf(c.get(key)); return n }

// RoomType is the row's roomType.
func (c Config) RoomType() string { s, _ := c.get("roomType").(string); return s }

func (c Config) rooms() float64    { return c.num("rooms") }
func (c Config) bedsEach() float64 { return c.num("bedsPerRoom") }
func (c Config) vacant() float64   { return c.num("vacantBeds") }

// totalBeds is totalBedsFor: rooms × max(1, bedsPerRoom).
func (c Config) totalBeds() float64 { return c.rooms() * math.Max(1, c.bedsEach()) }

// jsNum stores a count the way a JS number lands in Mongo: int32 when whole.
func jsNum(n float64) any {
	if n == math.Trunc(n) && n >= math.MinInt32 && n <= math.MaxInt32 {
		return int32(n)
	}
	return n
}

// Summary is summarizeConfigurations.
type Summary struct{ TotalBeds, TotalRooms, VacantBeds float64 }

func Summarize(cs []Config) Summary {
	var s Summary
	for _, c := range cs {
		s.TotalBeds += c.totalBeds()
		s.TotalRooms += c.rooms()
		s.VacantBeds += c.vacant()
	}
	return s
}

func (s Summary) doc() bson.D {
	return bson.D{{Key: "totalRooms", Value: jsNum(s.TotalRooms)}, {Key: "totalBeds", Value: jsNum(s.TotalBeds)}, {Key: "vacantBeds", Value: jsNum(s.VacantBeds)}}
}

// Load is loadConfigurations: 404 when the hostel is gone.
func (k *Capacity) Load(ctx context.Context, hostel bson.ObjectID) ([]Config, error) {
	var h struct {
		Rooms []Config `bson:"roomConfigurations"`
	}
	err := k.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}, {Key: "isDeleted", Value: false}},
		options.FindOne().SetProjection(bson.D{{Key: "roomConfigurations", Value: 1}})).Decode(&h)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, httpx.NewError(http.StatusNotFound, "HOSTEL_NOT_FOUND", "Hostel was not found.", nil)
	}
	return h.Rooms, err
}

// Write is writeConfigurations.
func (k *Capacity) Write(ctx context.Context, hostel bson.ObjectID, cs []Config) error {
	if cs == nil {
		cs = []Config{}
	}
	_, err := k.DB.Collection("hostels").UpdateOne(ctx, bson.D{{Key: "_id", Value: hostel}, {Key: "isDeleted", Value: false}}, bson.D{{Key: "$set", Value: bson.D{
		{Key: "capacitySummary", Value: Summarize(cs).doc()}, {Key: "roomConfigurations", Value: cs}, {Key: "updatedAt", Value: time.Now().UTC()}}}})
	if err != nil {
		return err
	}
	realtime.PublishResourceChange(ctx, k.RT, k.Bump, realtime.Change{HostelIDs: []string{hostel.Hex()}, Topics: []realtime.Topic{realtime.Rooms, realtime.Residents}})
	return nil
}

// Available is one row of listAvailableRoomTypes.
type Available struct {
	MonthlyRent float64 `json:"monthlyRent"`
	RoomType    string  `json:"roomType"`
	VacantBeds  float64 `json:"vacantBeds"`
}

// ListAvailable is listAvailableRoomTypes: types with a free bed, by name.
func (k *Capacity) ListAvailable(ctx context.Context, hostel bson.ObjectID) ([]Available, error) {
	cs, err := k.Load(ctx, hostel)
	if err != nil {
		return nil, err
	}
	out := []Available{}
	for _, c := range cs {
		if c.vacant() > 0 {
			out = append(out, Available{c.num("monthlyRent"), c.RoomType(), c.vacant()})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return jsLess(out[i].RoomType, out[j].RoomType) })
	return out, nil
}

// Claim is claimBedForRoomType. The decrement is one atomic update on the
// matched row, so two admins admitting at once cannot both take the last bed.
func (k *Capacity) Claim(ctx context.Context, hostel bson.ObjectID, roomType string) error {
	cs, err := k.Load(ctx, hostel)
	if err != nil {
		return err
	}
	var target *Config
	for i := range cs {
		if cs[i].RoomType() == roomType {
			target = &cs[i]
			break
		}
	}
	if target == nil {
		return httpx.NewError(http.StatusNotFound, "ROOM_TYPE_NOT_FOUND", `"`+roomType+`" is not one of this hostel's room types.`, nil)
	}
	full := httpx.NewError(http.StatusConflict, "ROOM_TYPE_FULL", `No vacant beds left in "`+TypeLabel(roomType)+`".`, nil)
	if target.vacant() <= 0 {
		return full
	}
	// The first row of that type is the one TS decrements (find()).
	res, err := k.DB.Collection("hostels").UpdateOne(ctx, bson.D{{Key: "_id", Value: hostel}, {Key: "isDeleted", Value: false},
		{Key: "roomConfigurations", Value: bson.D{{Key: "$elemMatch", Value: bson.D{{Key: "roomType", Value: roomType}, {Key: "vacantBeds", Value: bson.D{{Key: "$gt", Value: 0}}}}}}}},
		bson.D{{Key: "$inc", Value: bson.D{{Key: "roomConfigurations.$.vacantBeds", Value: -1}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: time.Now().UTC()}}}})
	if err != nil {
		return err
	}
	if res.MatchedCount == 0 {
		return full
	}
	return k.resum(ctx, hostel)
}

// resum recomputes capacitySummary after a counter moved, and tells clients.
func (k *Capacity) resum(ctx context.Context, hostel bson.ObjectID) error {
	cs, err := k.Load(ctx, hostel)
	if err != nil {
		return err
	}
	return k.Write(ctx, hostel, cs)
}

// Release is releaseBedForRoomType: capped at the type's total beds, and a type
// that no longer exists is not an error — the resident still has to leave.
func (k *Capacity) Release(ctx context.Context, hostel bson.ObjectID, roomType string) error {
	cs, err := k.Load(ctx, hostel)
	if err != nil {
		return err
	}
	for i := range cs {
		if cs[i].RoomType() == roomType {
			cs[i].set("vacantBeds", jsNum(math.Min(cs[i].vacant()+1, cs[i].totalBeds())))
			return k.Write(ctx, hostel, cs)
		}
	}
	return nil
}

// Move is moveBedBetweenRoomTypes: claim the new type first, so a refusal never
// leaves the old bed released.
func (k *Capacity) Move(ctx context.Context, hostel bson.ObjectID, from, to string) error {
	if from == to {
		return nil
	}
	if err := k.Claim(ctx, hostel, to); err != nil {
		return err
	}
	return k.Release(ctx, hostel, from)
}
