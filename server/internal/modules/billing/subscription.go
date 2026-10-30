package billing

import (
	"context"
	"errors"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Subscription is the part of a HostelSubscription row the registration paths read.
type Subscription struct {
	ID            bson.ObjectID `bson:"_id"`
	Status        string        `bson:"status"`
	TrialDays     *int          `bson:"trialDays"`
	TrialEndsAt   *time.Time    `bson:"trialEndsAt"`
	LifetimeSince *time.Time    `bson:"lifetimeSince"`
}

// BillingHostelID is billingHostelId: a branch has no subscription of its own,
// its main hostel's is the one.
func BillingHostelID(ctx context.Context, db *mongo.Database, hostelID bson.ObjectID) (bson.ObjectID, error) {
	var h struct {
		Parent *bson.ObjectID `bson:"parentHostelId"`
	}
	err := db.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostelID}},
		options.FindOne().SetProjection(bson.D{{Key: "parentHostelId", Value: 1}})).Decode(&h)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return hostelID, err
	}
	if h.Parent != nil {
		return *h.Parent, nil
	}
	return hostelID, nil
}

// GetOrCreateSubscription is getOrCreateSubscription: the row exists from the
// moment the hostel does, holding no plan yet. source is PUBLIC or TEAM.
func GetOrCreateSubscription(ctx context.Context, db *mongo.Database, hostelID bson.ObjectID, source string, agentID *bson.ObjectID) (Subscription, error) {
	id, err := BillingHostelID(ctx, db, hostelID)
	if err != nil {
		return Subscription{}, err
	}
	coll := db.Collection("hostelsubscriptions")
	var sub Subscription
	err = coll.FindOne(ctx, bson.D{{Key: "hostelId", Value: id}}).Decode(&sub)
	if err == nil {
		return sub, nil
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		return sub, err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	var agent any
	if agentID != nil {
		agent = *agentID
	}
	sub = Subscription{ID: bson.NewObjectID(), Status: "PENDING_SELECTION"}
	_, err = coll.InsertOne(ctx, bson.D{
		{Key: "_id", Value: sub.ID}, {Key: "hostelId", Value: id}, {Key: "status", Value: sub.Status},
		{Key: "planId", Value: nil}, {Key: "planName", Value: nil}, {Key: "cycle", Value: nil}, {Key: "cycleMonths", Value: nil}, {Key: "monthlyRate", Value: nil},
		{Key: "cycleTotal", Value: nil}, {Key: "freeMonths", Value: nil}, {Key: "freeUntil", Value: nil}, {Key: "freeMonthsWelcomed", Value: bson.A{}},
		{Key: "currency", Value: "NPR"}, {Key: "trialDays", Value: nil}, {Key: "trialEndsAt", Value: nil}, {Key: "trialReminded", Value: bson.A{}},
		{Key: "lifetime", Value: false}, {Key: "lifetimeSince", Value: nil}, {Key: "selectedAt", Value: nil}, {Key: "selectedBy", Value: nil},
		{Key: "source", Value: source}, {Key: "agentId", Value: agent}, {Key: "activatedAt", Value: nil}, {Key: "currentPeriodEnd", Value: nil}, {Key: "dueBy", Value: nil},
		{Key: "cancelledAt", Value: nil}, {Key: "cancelledReason", Value: nil}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0},
	})
	return sub, err
}
