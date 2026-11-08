package bookings

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// dailyFloor is dailyFloor: the lowest nightly rate that keeps a short stay above its markup.
func dailyFloor(monthlyRent float64, minMarkupPercent float64) int64 {
	return int64(math.Max(1, math.Ceil(monthlyRent*(100+minMarkupPercent)/3000)))
}

type shortRoom struct {
	DailyRate   *int64
	Floor       *int64
	MonthlyRent *float64
	RoomType    string
}

type shortStaysStored struct {
	Enabled   bool `bson:"enabled"`
	MinNights *int `bson:"minNights"`
	Rates     []struct {
		DailyRate int64  `bson:"dailyRate"`
		RoomType  string `bson:"roomType"`
	} `bson:"rates"`
}

type hostelRooms struct {
	Rooms []struct {
		RoomType string `bson:"roomType"`
	} `bson:"roomConfigurations"`
	ShortStays *shortStaysStored `bson:"shortStays"`
}

func (h *Hostel) loadRooms(ctx context.Context, hostel bson.ObjectID) (*hostelRooms, error) {
	var r hostelRooms
	err := h.db.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "roomConfigurations", Value: 1}, {Key: "shortStays", Value: 1}})).Decode(&r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, bookingErr("Hostel not found.", "HOSTEL_NOT_FOUND", http.StatusNotFound)
	}
	return &r, err
}

func (h *Hostel) rooms(ctx context.Context, hostel bson.ObjectID, r *hostelRooms, c Config, now time.Time) ([]shortRoom, error) {
	period, err := bs.PeriodOf(now)
	if err != nil {
		return nil, err
	}
	sched, err := finance.EffectiveSchedule(ctx, h.db, hostel, period)
	if err != nil {
		return nil, err
	}
	out := make([]shortRoom, 0, len(r.Rooms))
	for _, room := range r.Rooms {
		sr := shortRoom{RoomType: room.RoomType}
		if rate := finance.RateForRoomType(sched, room.RoomType); rate != nil && rate.MonthlyAmount != nil && *rate.MonthlyAmount > 0 {
			sr.MonthlyRent = rate.MonthlyAmount
			f := dailyFloor(*rate.MonthlyAmount, c.ShortStayMinMarkupPercent)
			sr.Floor = &f
		}
		if r.ShortStays != nil {
			for _, rt := range r.ShortStays.Rates {
				if finance.SameRoomType(rt.RoomType, room.RoomType) {
					d := rt.DailyRate
					sr.DailyRate = &d
					break
				}
			}
		}
		out = append(out, sr)
	}
	return out, nil
}

func ptr[T any](p *T) any {
	if p == nil {
		return nil
	}
	return *p
}

// ShortStays is getShortStaySettings.
func (h *Hostel) ShortStays(ctx context.Context, hostel bson.ObjectID) (ordered.Map, error) {
	r, err := h.loadRooms(ctx, hostel)
	if err != nil {
		return nil, err
	}
	c := h.BookingConfig(ctx)
	rooms, err := h.rooms(ctx, hostel, r, c, time.Now().UTC())
	if err != nil {
		return nil, err
	}
	views := make([]ordered.Map, 0, len(rooms))
	for _, room := range rooms {
		views = append(views, ordered.Map{{Key: "dailyRate", Value: ptr(room.DailyRate)}, {Key: "floor", Value: ptr(room.Floor)}, {Key: "monthlyRent", Value: ptr(room.MonthlyRent)}, {Key: "roomType", Value: room.RoomType}})
	}
	enabled, minNights := false, 1
	if r.ShortStays != nil {
		enabled = r.ShortStays.Enabled
		if r.ShortStays.MinNights != nil {
			minNights = *r.ShortStays.MinNights
		}
	}
	return ordered.Map{{Key: "enabled", Value: enabled},
		{Key: "limits", Value: ordered.Map{{Key: "hostelSharePercent", Value: c.ShortStayHostelSharePercent}, {Key: "maxNights", Value: c.ShortStayMaxNights}, {Key: "minMarkupPercent", Value: c.ShortStayMinMarkupPercent}}},
		{Key: "minNights", Value: minNights}, {Key: "rooms", Value: views}}, nil
}

// ShortStaysIn is shortStaysInputSchema.
type ShortStaysIn struct {
	Enabled   bool
	MinNights int
	Rates     []struct {
		DailyRate int64
		RoomType  string
	}
}

// SaveShortStays is saveShortStaySettings.
func (h *Hostel) SaveShortStays(ctx context.Context, hostel bson.ObjectID, in ShortStaysIn, actor bson.ObjectID) (ordered.Map, error) {
	r, err := h.loadRooms(ctx, hostel)
	if err != nil {
		return nil, err
	}
	c := h.BookingConfig(ctx)
	rooms, err := h.rooms(ctx, hostel, r, c, time.Now().UTC())
	if err != nil {
		return nil, err
	}
	if float64(in.MinNights) > c.ShortStayMaxNights {
		return nil, bookingErr("The minimum stay can be at most "+jsNum(c.ShortStayMaxNights)+" nights. Longer stays are monthly.", "SHORT_STAY_MIN_NIGHTS_TOO_HIGH", http.StatusUnprocessableEntity)
	}
	rates := bson.A{}
	seen := []string{}
	for _, rate := range in.Rates {
		var room *shortRoom
		for i := range rooms {
			if finance.SameRoomType(rooms[i].RoomType, rate.RoomType) {
				room = &rooms[i]
				break
			}
		}
		if room == nil {
			return nil, bookingErr(`This hostel has no "`+rate.RoomType+`" room type.`, "ROOM_NOT_FOUND", http.StatusUnprocessableEntity)
		}
		if room.Floor == nil {
			return nil, bookingErr("Set a monthly rent for "+email.RoomTypeLabel(room.RoomType)+" on the rate card first. The daily rate is checked against it.", "SHORT_STAY_ROOM_NOT_PRICED", http.StatusUnprocessableEntity)
		}
		if rate.DailyRate < *room.Floor {
			return nil, httpx.NewError(http.StatusUnprocessableEntity, "SHORT_STAY_RATE_TOO_LOW", email.RoomTypeLabel(room.RoomType)+" must be at least Rs "+money.GroupIN(*room.Floor)+" a night.",
				ordered.Map{{Key: "floor", Value: *room.Floor}, {Key: "roomType", Value: room.RoomType}})
		}
		dup := false
		for _, s := range seen {
			dup = dup || finance.SameRoomType(s, room.RoomType)
		}
		if !dup {
			seen = append(seen, room.RoomType)
			rates = append(rates, bson.D{{Key: "dailyRate", Value: rate.DailyRate}, {Key: "roomType", Value: room.RoomType}})
		}
	}
	if in.Enabled && len(rates) == 0 {
		return nil, bookingErr("Give at least one room type a daily rate to take short stays.", "SHORT_STAY_NO_RATES", http.StatusUnprocessableEntity)
	}
	stays := bson.D{{Key: "enabled", Value: in.Enabled}, {Key: "minNights", Value: in.MinNights}, {Key: "rates", Value: rates}}
	if _, err := h.db.Collection("hostels").UpdateOne(ctx, bson.D{{Key: "_id", Value: hostel}}, bson.D{{Key: "$set", Value: bson.D{{Key: "shortStays", Value: stays}, {Key: "updatedAt", Value: time.Now().UTC()}}}}); err != nil {
		return nil, err
	}
	_ = h.Audit.Write(ctx, audit.Entry{ActorID: actor, HostelID: hostel, Action: "HOSTEL_SHORT_STAYS_SAVED", EntityType: "Hostel", EntityID: hostel.Hex(), Metadata: stays})
	cache.PublicChangedOn(ctx, h.Bump)
	return h.ShortStays(ctx, hostel)
}

func (h *Hostel) getShortStays(c *gin.Context) {
	hostel, ok := hostelrooms.HostelOf(c, valid.Query(c)["hostelId"])
	if !ok {
		return
	}
	out, err := h.ShortStays(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Short stays")
}

func (h *Hostel) putShortStays(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	m, _ := body.(map[string]any)
	requested, _ := m["hostelId"].(string)
	hostel, ok := hostelrooms.HostelOf(c, requested)
	if !ok {
		return
	}
	f := valid.NewForm(body)
	var in ShortStaysIn
	in.Enabled, _ = f.Bool("enabled", false, nil)
	if n, ok := f.Num("minNights", valid.N{Coerce: true, Int: true, Min: valid.P(1), Max: valid.P(29)}); ok {
		in.MinNights = int(n)
	}
	if arr, ok := f.Array("rates", false, false); ok {
		for i, v := range arr {
			sub := valid.NewForm(v)
			path := "rates." + strconv.Itoa(i)
			rate, rok := v.(map[string]any)
			if !rok {
				f.Is.Add(path, valid.Type("object", valid.Received(v, false)))
				continue
			}
			_ = rate
			daily, dok := sub.Num("dailyRate", valid.N{Coerce: true, Int: true, IntMsg: "Use whole rupees.", Min: valid.P(1)})
			rt, rtok := sub.Str("roomType", valid.S{Trim: true, Min: 1, Max: 80})
			f.Join(path, sub)
			if dok && rtok {
				in.Rates = append(in.Rates, struct {
					DailyRate int64
					RoomType  string
				}{int64(daily), rt})
			}
		}
		f.Size("rates", len(arr), 0, 30, "", false)
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.SaveShortStays(c, hostel, in, hostelrooms.UserID(authz.From(c)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Short stays saved")
}
