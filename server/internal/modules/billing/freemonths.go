package billing

import (
	"context"
	"errors"
	"math"
	"regexp"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// free-months.ts: a building gets its free months once, however many times it
// is registered. hostel-name-key.ts lives here too, since both desks read it.

var (
	nameNoise  = regexp.MustCompile(`[^a-z0-9\x{0900}-\x{097F}]+`)
	nameFiller = regexp.MustCompile(`\b(hostel|hostels|pg|boys|girls|home|house|the)\b`)
	spaces     = regexp.MustCompile(`\s+`)
	nonDigit   = regexp.MustCompile(`\D`)
)

// HostelNameKey is hostelNameKey: a name with the words every hostel shares taken out.
func HostelNameKey(name string) string {
	s := nameNoise.ReplaceAllString(strings.ToLower(name), " ")
	s = nameFiller.ReplaceAllString(s, " ")
	return strings.TrimSpace(spaces.ReplaceAllString(s, " "))
}

type buildingPrint struct {
	Area       string   `bson:"area"`
	Lat        *float64 `bson:"lat"`
	Lng        *float64 `bson:"lng"`
	NameKey    string   `bson:"nameKey"`
	OwnerPhone *string  `bson:"ownerPhone"`
	PAN        *string  `bson:"panNumber"`
}

func phoneKey(phone string) *string {
	d := nonDigit.ReplaceAllString(phone, "")
	if len(d) < 7 {
		return nil
	}
	if len(d) > 10 {
		d = d[len(d)-10:]
	}
	return &d
}

func panKey(pan string) *string {
	d := nonDigit.ReplaceAllString(pan, "")
	if len(d) != 9 {
		return nil
	}
	return &d
}

func metresBetween(aLat, aLng, bLat, bLng float64) float64 {
	rad := math.Pi / 180
	dLat, dLng := (bLat-aLat)*rad, (bLng-aLng)*rad
	h := math.Pow(math.Sin(dLat/2), 2) + math.Cos(aLat*rad)*math.Cos(bLat*rad)*math.Pow(math.Sin(dLng/2), 2)
	return 2 * 6_371_000 * math.Asin(math.Sqrt(h))
}

func eqPtr(a, b *string) bool { return a != nil && b != nil && *a == *b }

func sameBuilding(claim, print buildingPrint) bool {
	sameArea := print.Area != "" && claim.Area == print.Area
	switch {
	case print.NameKey != "" && sameArea && claim.NameKey == print.NameKey:
		return true
	case print.PAN != nil && eqPtr(claim.PAN, print.PAN):
		return true
	case print.OwnerPhone != nil && sameArea && eqPtr(claim.OwnerPhone, print.OwnerPhone):
		return true
	}
	return print.Lat != nil && print.Lng != nil && claim.Lat != nil && claim.Lng != nil && metresBetween(*claim.Lat, *claim.Lng, *print.Lat, *print.Lng) <= 50
}

func (s *Service) buildingPrint(ctx context.Context, hostelID bson.ObjectID) (*buildingPrint, error) {
	var h struct {
		Contact struct {
			Phone string `bson:"phone"`
		} `bson:"contact"`
		Location struct {
			Area string   `bson:"area"`
			Lat  *float64 `bson:"lat"`
			Lng  *float64 `bson:"lng"`
		} `bson:"location"`
		Name    string         `bson:"name"`
		OwnerID *bson.ObjectID `bson:"ownerId"`
		PAN     string         `bson:"panNumber"`
	}
	if err := s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostelID}}).Decode(&h); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil
		}
		return nil, err
	}
	phone := h.Contact.Phone
	if h.OwnerID != nil {
		var o struct {
			Phone *string `bson:"phone"`
		}
		if err := s.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: *h.OwnerID}}).Decode(&o); err == nil && o.Phone != nil {
			phone = *o.Phone
		}
	}
	return &buildingPrint{Area: strings.ToLower(strings.TrimSpace(h.Location.Area)), Lat: h.Location.Lat, Lng: h.Location.Lng, NameKey: HostelNameKey(h.Name),
		OwnerPhone: phoneKey(phone), PAN: panKey(h.PAN)}, nil
}

// claimFreeMonths is claimFreeMonths: zero when an earlier claim was the same building.
func (s *Service) claimFreeMonths(ctx context.Context, hostelID bson.ObjectID, planID string, freeMonths int) (int, error) {
	coll := s.DB.Collection("freeplanclaims")
	var existing struct {
		FreeMonths int `bson:"freeMonths"`
	}
	if err := coll.FindOne(ctx, bson.D{{Key: "hostelId", Value: hostelID}}).Decode(&existing); err == nil {
		return existing.FreeMonths, nil
	} else if !errors.Is(err, mongo.ErrNoDocuments) {
		return 0, err
	}
	print, err := s.buildingPrint(ctx, hostelID)
	if err != nil {
		return 0, err
	}
	var earlier *bson.ObjectID
	if print != nil {
		or := bson.A{}
		if print.NameKey != "" && print.Area != "" {
			or = append(or, bson.D{{Key: "area", Value: print.Area}, {Key: "nameKey", Value: print.NameKey}})
		}
		if print.PAN != nil {
			or = append(or, bson.D{{Key: "panNumber", Value: *print.PAN}})
		}
		if print.OwnerPhone != nil && print.Area != "" {
			or = append(or, bson.D{{Key: "area", Value: print.Area}, {Key: "ownerPhone", Value: *print.OwnerPhone}})
		}
		if print.Lat != nil && print.Lng != nil {
			const box = 0.0005
			or = append(or, bson.D{{Key: "lat", Value: bson.D{{Key: "$gte", Value: *print.Lat - box}, {Key: "$lte", Value: *print.Lat + box}}},
				{Key: "lng", Value: bson.D{{Key: "$gte", Value: *print.Lng - box}, {Key: "$lte", Value: *print.Lng + box}}}})
		}
		if len(or) > 0 {
			cur, err := coll.Find(ctx, bson.D{{Key: "$or", Value: or}, {Key: "hostelId", Value: bson.D{{Key: "$ne", Value: hostelID}}}}, options.Find().SetSort(bson.D{{Key: "claimedAt", Value: 1}}))
			if err != nil {
				return 0, err
			}
			var rows []struct {
				Print    buildingPrint `bson:",inline"` // named: an unexported embedded inline struct is skipped
				HostelID bson.ObjectID `bson:"hostelId"`
			}
			if err := cur.All(ctx, &rows); err != nil {
				return 0, err
			}
			for _, r := range rows {
				if sameBuilding(r.Print, *print) {
					earlier = &r.HostelID
					break
				}
			}
		}
	}
	months := max(0, freeMonths)
	if earlier != nil {
		months = 0
	}
	insert := bson.D{}
	if print != nil {
		insert = append(insert, bson.E{Key: "area", Value: print.Area}, bson.E{Key: "lat", Value: print.Lat}, bson.E{Key: "lng", Value: print.Lng},
			bson.E{Key: "nameKey", Value: print.NameKey}, bson.E{Key: "ownerPhone", Value: print.OwnerPhone}, bson.E{Key: "panNumber", Value: print.PAN})
	}
	var matched any
	if earlier != nil {
		matched = *earlier
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	insert = append(insert, bson.E{Key: "claimedAt", Value: now}, bson.E{Key: "freeMonths", Value: months}, bson.E{Key: "matchedHostelId", Value: matched},
		bson.E{Key: "planId", Value: planID}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	var row struct {
		FreeMonths int `bson:"freeMonths"`
	}
	// Upsert: two go-lives racing land on one row.
	err = coll.FindOneAndUpdate(ctx, bson.D{{Key: "hostelId", Value: hostelID}}, bson.D{{Key: "$setOnInsert", Value: insert}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&row)
	if mongo.IsDuplicateKeyError(err) {
		err = coll.FindOne(ctx, bson.D{{Key: "hostelId", Value: hostelID}}).Decode(&row)
	}
	return row.FreeMonths, err
}
