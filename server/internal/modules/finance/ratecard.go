// Package finance: so far the rate-card read the booking availability needs
// (fee-schedule.service.ts getEffectiveSchedule / rateForRoomType, bed-type.ts).
// Billing itself lands with Phase 6.
package finance

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
)

type Rate struct {
	RoomType      *string  `bson:"roomType"`
	BedType       *string  `bson:"bedType"`
	MonthlyAmount *float64 `bson:"monthlyAmount"`
}

type Schedule struct {
	ID    bson.ObjectID `bson:"_id"`
	Rates []Rate        `bson:"rates"`
}

// EffectiveSchedule is getEffectiveSchedule: the rate card in force at any
// point of the BS period, latest first. nil when the hostel has none.
func EffectiveSchedule(ctx context.Context, db *mongo.Database, hostelID bson.ObjectID, period string) (*Schedule, error) {
	b, err := bs.PeriodBounds(period)
	if err != nil {
		return nil, err
	}
	var s Schedule
	err = db.Collection("feeschedules").FindOne(ctx, bson.D{
		{Key: "effectiveFrom", Value: bson.D{{Key: "$lte", Value: b.End}}},
		{Key: "hostelId", Value: hostelID},
		{Key: "$or", Value: bson.A{bson.D{{Key: "effectiveTo", Value: nil}}, bson.D{{Key: "effectiveTo", Value: bson.D{{Key: "$gte", Value: b.Start}}}}}},
	}, options.FindOne().SetSort(bson.D{{Key: "effectiveFrom", Value: -1}})).Decode(&s)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return &s, err
}

var nonAlnum = regexp.MustCompile(`[^A-Z0-9]`)

func key(s string) string { return nonAlnum.ReplaceAllString(strings.ToUpper(s), "") }

// SameRoomType is case- and punctuation-insensitive: a room type is text a human typed.
func SameRoomType(left, right string) bool {
	if left == "" || right == "" {
		return false
	}
	return key(strings.TrimSpace(left)) == key(strings.TrimSpace(right))
}

var exactBedType = map[string]string{}

func register(bedType string, spellings ...string) {
	for _, s := range spellings {
		exactBedType[key(s)] = bedType
	}
}

func init() {
	register("SINGLE", "Single", "Single Room", "Single Occupancy", "Private", "Private Room", "One Seater", "1 Seater", "ONE_SEATER")
	register("DOUBLE_SHARING", "Double", "Double Sharing", "Double Room", "Two Sharing", "Twin Sharing", "Two Seater", "2 Seater", "TWO_SEATER")
	register("TRIPLE_SHARING", "Triple", "Triple Sharing", "Three Sharing", "Three Seater", "3 Seater", "THREE_SEATER")
	register("FOUR_SHARING", "Four Sharing", "Four Seater", "Quad", "Quad Sharing", "4 Seater", "FOUR_SEATER")
	register("DORMITORY", "Dormitory", "Dorm", "Dorm Bed", "DORMITORY")
}

var counted = regexp.MustCompile(`^(\d{1,2})(SEATER|SHARING|SHARED|BED|BEDS|PERSON|PAX)$`)

var byOccupancy = map[int]string{1: "SINGLE", 2: "DOUBLE_SHARING", 3: "TRIPLE_SHARING", 4: "FOUR_SHARING"}

// NormalizeBedType maps free-text room types onto the five bed types; "" when unmappable.
func NormalizeBedType(roomType string) string {
	k := key(roomType)
	if k == "" {
		return ""
	}
	if b, ok := exactBedType[k]; ok {
		return b
	}
	if m := counted.FindStringSubmatch(k); m != nil {
		n, _ := strconv.Atoi(m[1])
		if n >= 5 {
			return "DORMITORY"
		}
		return byOccupancy[n]
	}
	return ""
}

// RateForRoomType is rateForRoomType: room type first, then a rate not yet
// re-keyed whose bed type matches.
func RateForRoomType(s *Schedule, roomType string) *Rate {
	if s == nil {
		return nil
	}
	for i := range s.Rates {
		if r := s.Rates[i].RoomType; r != nil && SameRoomType(*r, roomType) {
			return &s.Rates[i]
		}
	}
	resolved := NormalizeBedType(roomType)
	if resolved == "" {
		return nil
	}
	for i := range s.Rates {
		r := s.Rates[i]
		if (r.RoomType == nil || *r.RoomType == "") && r.BedType != nil && *r.BedType == resolved {
			return &s.Rates[i]
		}
	}
	return nil
}
