package users

import (
	"context"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// ProfilePromptViewThreshold is PROFILE_PROMPT_VIEW_THRESHOLD.
const ProfilePromptViewThreshold = 3

// ProfilePrompt is evaluateProfilePrompt's answer, in its key order.
type ProfilePrompt struct {
	Reason               *string `json:"reason"`
	ShouldCollectProfile bool    `json:"shouldCollectProfile"`
	ViewedHostels        int     `json:"viewedHostels"`
	Views                int64   `json:"views"`
}

func hasCompletedProfile(ctx context.Context, db *mongo.Database, userID bson.ObjectID) (bool, error) {
	n, err := db.Collection("userresidentprofiles").CountDocuments(ctx, bson.D{
		{Key: "completedAt", Value: bson.D{{Key: "$ne", Value: nil}}},
		{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
		{Key: "userId", Value: userID},
	})
	return n > 0, err
}

// EvaluateProfilePrompt decides whether to interrupt a visitor with the
// one-time profile form: after they have clearly been shopping around, never
// on a first visit and never once a profile exists. userID may be "".
func EvaluateProfilePrompt(ctx context.Context, db *mongo.Database, userID, visitorKey string) (ProfilePrompt, error) {
	var filter bson.D
	if userID != "" {
		uid, err := bson.ObjectIDFromHex(userID)
		if err != nil {
			return ProfilePrompt{}, err
		}
		if done, err := hasCompletedProfile(ctx, db, uid); err != nil {
			return ProfilePrompt{}, err
		} else if done {
			return ProfilePrompt{}, nil
		}
		filter = bson.D{{Key: "userId", Value: uid}}
	} else {
		filter = bson.D{{Key: "visitorKey", Value: visitorKey}}
	}
	views := db.Collection("hostelpageviews")
	total, err := views.CountDocuments(ctx, filter)
	if err != nil {
		return ProfilePrompt{}, err
	}
	distinct, err := distinctCount(ctx, views, "hostelId", filter)
	if err != nil {
		return ProfilePrompt{}, err
	}
	out := ProfilePrompt{ViewedHostels: distinct, Views: total}
	if total >= ProfilePromptViewThreshold {
		reason := "BROWSING"
		out.Reason, out.ShouldCollectProfile = &reason, true
	}
	return out, nil
}

func distinctCount(ctx context.Context, c *mongo.Collection, field string, filter bson.D) (int, error) {
	var values []bson.RawValue
	if err := c.Distinct(ctx, field, filter).Decode(&values); err != nil {
		return 0, err
	}
	return len(values), nil
}

// ShouldPromptAfterInquiry is the same question, asked right after someone
// submits an inquiry. A signed-in account is asked until it has a profile; a
// signed-out enquirer when their address has sent one before.
func ShouldPromptAfterInquiry(ctx context.Context, db *mongo.Database, userID, email string) (bool, error) {
	if userID != "" {
		uid, err := bson.ObjectIDFromHex(userID)
		if err != nil {
			return false, err
		}
		done, err := hasCompletedProfile(ctx, db, uid)
		return !done, err
	}
	if email == "" {
		return true, nil
	}
	n, err := db.Collection("inquiries").CountDocuments(ctx, bson.D{{Key: "email", Value: strings.ToLower(email)}, {Key: "isDeleted", Value: false}})
	return n >= 1, err
}
