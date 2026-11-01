package residents

import (
	"context"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// ResolveContact is resolveResidentContact: the resident's own address, else their
// linked account's; nil when neither can be mailed.
func ResolveContact(ctx context.Context, db *mongo.Database, addr, first, last string, userID *bson.ObjectID) *Contact {
	name := strings.TrimSpace(first + " " + last)
	uid := ""
	if userID != nil {
		uid = userID.Hex()
	}
	if addr != "" {
		return &Contact{Email: addr, Name: name, UserID: uid}
	}
	if userID == nil {
		return nil
	}
	var user userRow
	err := db.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: *userID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&user)
	if err != nil || user.Email == "" {
		return nil
	}
	if user.Name != nil && *user.Name != "" {
		name = *user.Name
	}
	return &Contact{Email: user.Email, Name: name, UserID: uid}
}
