// Package hostels: so far only what the auth routes read about an account's
// hostels (hostel-kyc-lock.ts kycForAccount, hostel-suspension.ts
// suspensionForAccount). The rest of the module lands with Phase 3/6.
package hostels

import (
	"context"
	"errors"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

func objectIDs(hostelIDs []string) []bson.ObjectID {
	ids := []bson.ObjectID{}
	for _, h := range hostelIDs {
		if id, err := bson.ObjectIDFromHex(h); err == nil {
			ids = append(ids, id)
		}
	}
	return ids
}

// AccountKyc is kycForAccount's answer, in its key order.
type AccountKyc struct {
	HostelID    string   `json:"hostelId"`
	HostelName  string   `json:"hostelName"`
	Locked      bool     `json:"locked"`
	Note        *string  `json:"note"`
	Status      string   `json:"status"`
	SubmittedAt *string  `json:"submittedAt"`
	TrialDays   *float64 `json:"trialDays"`
	TrialEndsAt *string  `json:"trialEndsAt"`
}

// KycForAccount: the quick sign-up's KYC and trial, nil for every other hostel.
func KycForAccount(ctx context.Context, db *mongo.Database, hostelIDs []string) (*AccountKyc, error) {
	ids := objectIDs(hostelIDs)
	if len(ids) == 0 {
		return nil, nil
	}
	var h struct {
		ID  bson.ObjectID `bson:"_id"`
		Kyc *struct {
			authz.Kyc   `bson:",inline"`
			Note        *string    `bson:"note"`
			SubmittedAt *time.Time `bson:"submittedAt"`
		} `bson:"kyc"`
		Name string `bson:"name"`
	}
	err := db.Collection("hostels").FindOne(ctx, bson.D{
		{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}},
		{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
		{Key: "kyc.required", Value: true},
	}, options.FindOne().SetProjection(bson.D{{Key: "kyc", Value: 1}, {Key: "name", Value: 1}})).Decode(&h)
	if errors.Is(err, mongo.ErrNoDocuments) || err == nil && h.Kyc == nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var sub struct {
		TrialDays   *float64   `bson:"trialDays"`
		TrialEndsAt *time.Time `bson:"trialEndsAt"`
	}
	err = db.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "hostelId", Value: h.ID}},
		options.FindOne().SetProjection(bson.D{{Key: "trialDays", Value: 1}, {Key: "trialEndsAt", Value: 1}})).Decode(&sub)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	status := "DRAFT"
	if h.Kyc.Status != nil {
		status = *h.Kyc.Status
	}
	out := &AccountKyc{HostelID: h.ID.Hex(), HostelName: h.Name, Locked: h.Kyc.Kyc.Locked(), Status: status, TrialDays: sub.TrialDays}
	if status == "REJECTED" {
		out.Note = h.Kyc.Note
	}
	if h.Kyc.SubmittedAt != nil {
		s := httpx.ISO(*h.Kyc.SubmittedAt)
		out.SubmittedAt = &s
	}
	if sub.TrialEndsAt != nil {
		s := httpx.ISO(*sub.TrialEndsAt)
		out.TrialEndsAt = &s
	}
	return out, nil
}

// AccountSuspension is serializeSuspension plus the hostel it is about.
type AccountSuspension struct {
	GraceEndsAt string `json:"graceEndsAt"`
	Reason      string `json:"reason"`
	Stage       string `json:"stage"`
	StartedAt   string `json:"startedAt"`
	HostelID    string `json:"hostelId"`
	HostelName  string `json:"hostelName"`
}

// SuspensionForAccount: only when every live hostel is under one; the latest
// deadline wins, since the account is not blocked until the last lands.
func SuspensionForAccount(ctx context.Context, db *mongo.Database, hostelIDs []string, now time.Time) (*AccountSuspension, error) {
	ids := objectIDs(hostelIDs)
	if len(ids) == 0 {
		return nil, nil
	}
	cur, err := db.Collection("hostels").Find(ctx, bson.D{
		{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}},
		{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
	}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "suspension", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID         bson.ObjectID `bson:"_id"`
		Name       string        `bson:"name"`
		Suspension *struct {
			authz.Suspension `bson:",inline"`
			Reason           *string `bson:"reason"`
		} `bson:"suspension"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	var latest *AccountSuspension
	for _, r := range rows {
		if r.Suspension == nil {
			return nil, nil
		}
		stage := r.Suspension.Suspension.Stage(now)
		if stage == "" {
			return nil, nil
		}
		reason := "PLAN_PAYMENT"
		if r.Suspension.Reason != nil {
			reason = *r.Suspension.Reason
		}
		view := AccountSuspension{GraceEndsAt: httpx.ISO(*r.Suspension.GraceEndsAt), Reason: reason, Stage: stage,
			StartedAt: httpx.ISO(*r.Suspension.StartedAt), HostelID: r.ID.Hex(), HostelName: r.Name}
		if latest == nil || view.GraceEndsAt > latest.GraceEndsAt {
			latest = &view
		}
	}
	return latest, nil
}
