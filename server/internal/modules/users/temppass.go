package users

import (
	"context"
	"errors"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/auth"
)

// TemporaryPasswordIfMissing is issueTemporaryPasswordIfMissing: an account with
// no password gets a temporary one (returned); either way it is opened and its
// email counted as verified. ok is false for a missing or deleted account.
func TemporaryPasswordIfMissing(ctx context.Context, db *mongo.Database, userID bson.ObjectID) (email, password string, ok bool, err error) {
	var u struct {
		Email        string `bson:"email"`
		PasswordHash string `bson:"passwordHash"`
	}
	err = db.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: userID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
		options.FindOne().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "passwordHash", Value: 1}})).Decode(&u)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	set := bson.D{{Key: "emailVerified", Value: true}, {Key: "status", Value: "ACTIVE"}}
	if u.PasswordHash == "" {
		password = temporaryPassword()
		hash, err := auth.HashPassword(password)
		if err != nil {
			return "", "", false, err
		}
		set = append(set, bson.E{Key: "mustChangePassword", Value: true}, bson.E{Key: "passwordHash", Value: hash})
	}
	set = append(set, bson.E{Key: "updatedAt", Value: time.Now().UTC().Truncate(time.Millisecond)})
	_, err = db.Collection("users").UpdateOne(ctx, bson.D{{Key: "_id", Value: userID}}, bson.D{{Key: "$set", Value: set}})
	return u.Email, password, err == nil, err
}
