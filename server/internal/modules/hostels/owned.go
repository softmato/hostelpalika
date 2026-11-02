package hostels

import (
	"context"
	"errors"
	"regexp"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// owned is the part of a hostel resolveOwnedHostel returns.
type owned struct {
	ID                 bson.ObjectID  `bson:"_id"`
	Name               string         `bson:"name"`
	OwnerID            *bson.ObjectID `bson:"ownerId"`
	Slug               string         `bson:"slug"`
	Status             string         `bson:"status"`
	VerificationStatus string         `bson:"verificationStatus"`
}

// OwnerIdentities is ownerIdentitiesFor: the caller's own id plus every live
// account sharing their email or phone, so an owner who signed up twice still owns.
func OwnerIdentities(ctx context.Context, db *mongo.Database, userID string) (map[string]bool, error) {
	ids := map[string]bool{userID: true}
	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return ids, nil
	}
	var u struct {
		Email string `bson:"email"`
		Phone string `bson:"phone"`
	}
	if err := db.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: uid}}, options.FindOne().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "phone", Value: 1}})).Decode(&u); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return ids, nil
		}
		return nil, err
	}
	var or bson.A
	if u.Email != "" {
		or = append(or, bson.D{{Key: "email", Value: strings.ToLower(u.Email)}})
	}
	if u.Phone != "" {
		or = append(or, bson.D{{Key: "phone", Value: u.Phone}})
	}
	if len(or) == 0 {
		return ids, nil
	}
	cur, err := db.Collection("users").Find(ctx, bson.D{{Key: "$or", Value: or}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
		options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}).SetLimit(50))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	for _, r := range rows {
		ids[r.ID.Hex()] = true
	}
	return ids, nil
}

// ResolveOwned is resolveOwnedHostel: the hostel, if the caller is its owner.
func ResolveOwned(ctx context.Context, db *mongo.Database, hostelID, userID string) (*owned, error) {
	id, err := bson.ObjectIDFromHex(hostelID)
	if err != nil {
		return nil, httpx.NewError(422, "INVALID_OBJECT_ID", "Invalid hostel id.", nil)
	}
	var h owned
	err = db.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&h)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, httpx.NewError(404, "HOSTEL_NOT_FOUND", "Hostel not found.", nil)
	}
	if err != nil {
		return nil, err
	}
	idents, err := OwnerIdentities(ctx, db, userID)
	if err != nil {
		return nil, err
	}
	if h.OwnerID == nil || !idents[h.OwnerID.Hex()] {
		return nil, httpx.NewError(403, "NOT_HOSTEL_OWNER", "This hostel is not yours to manage.", nil)
	}
	return &h, nil
}

var (
	nameJunk  = regexp.MustCompile("[^a-z0-9ऀ-ॿ]+")
	nameWords = regexp.MustCompile(`\b(hostel|hostels|pg|boys|girls|home|house|the)\b`)
	spaces    = regexp.MustCompile(`\s+`)
)

// NameKey is hostelNameKey: a hostel's name reduced to what tells it apart.
func NameKey(name string) string {
	s := nameJunk.ReplaceAllString(strings.ToLower(name), " ")
	s = nameWords.ReplaceAllString(s, " ")
	return strings.TrimSpace(spaces.ReplaceAllString(s, " "))
}

// PanKey is panKey: nine digits or nothing.
func PanKey(pan *string) *string {
	if pan == nil {
		return nil
	}
	digits := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, *pan)
	if len(digits) != 9 {
		return nil
	}
	return &digits
}
