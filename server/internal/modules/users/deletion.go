// Package users: so far only cancelling a pending account deletion from its
// emailed link (account-deletion.service.ts). The rest lands with Phase 5.
package users

import (
	"context"
	"errors"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// DeletionRequest is serializeRequest: optional fields are absent, not null.
type DeletionRequest struct {
	Cancelled           bool     `json:"cancelled"`
	CancelledAt         *string  `json:"cancelledAt,omitempty"`
	Executed            bool     `json:"executed"`
	ExecutedAt          *string  `json:"executedAt,omitempty"`
	HostelIDs           []string `json:"hostelIds"`
	ID                  string   `json:"id"`
	Kind                string   `json:"kind"`
	Reason              string   `json:"reason"`
	RequestedAt         string   `json:"requestedAt"`
	RequestedEmail      string   `json:"requestedEmail"`
	RequestedName       *string  `json:"requestedName,omitempty"`
	RequestedRole       string   `json:"requestedRole"`
	ReviewNote          *string  `json:"reviewNote,omitempty"`
	ReviewStatus        *string  `json:"reviewStatus,omitempty"`
	ReviewedAt          *string  `json:"reviewedAt,omitempty"`
	ScheduledDeletionAt *string  `json:"scheduledDeletionAt,omitempty"`
	UserID              string   `json:"userId"`
}

type deletionRow struct {
	ID                  bson.ObjectID   `bson:"_id"`
	Cancelled           bool            `bson:"cancelled"`
	CancelledAt         *time.Time      `bson:"cancelledAt"`
	Executed            bool            `bson:"executed"`
	ExecutedAt          *time.Time      `bson:"executedAt"`
	HostelIDs           []bson.ObjectID `bson:"hostelIds"`
	Kind                string          `bson:"kind"`
	Reason              string          `bson:"reason"`
	RequestedAt         time.Time       `bson:"requestedAt"`
	RequestedEmail      string          `bson:"requestedEmail"`
	RequestedName       *string         `bson:"requestedName"`
	RequestedRole       string          `bson:"requestedRole"`
	ReviewNote          *string         `bson:"reviewNote"`
	ReviewStatus        *string         `bson:"reviewStatus"`
	ReviewedAt          *time.Time      `bson:"reviewedAt"`
	ScheduledDeletionAt *time.Time      `bson:"scheduledDeletionAt"`
	UserID              bson.ObjectID   `bson:"userId"`
}

func iso(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := httpx.ISO(*t)
	return &s
}

func serialize(r deletionRow) DeletionRequest {
	ids := make([]string, len(r.HostelIDs))
	for i, h := range r.HostelIDs {
		ids[i] = h.Hex()
	}
	return DeletionRequest{
		Cancelled: r.Cancelled, CancelledAt: iso(r.CancelledAt), Executed: r.Executed, ExecutedAt: iso(r.ExecutedAt),
		HostelIDs: ids, ID: r.ID.Hex(), Kind: r.Kind, Reason: r.Reason, RequestedAt: httpx.ISO(r.RequestedAt),
		RequestedEmail: r.RequestedEmail, RequestedName: r.RequestedName, RequestedRole: r.RequestedRole,
		ReviewNote: r.ReviewNote, ReviewStatus: r.ReviewStatus, ReviewedAt: iso(r.ReviewedAt),
		ScheduledDeletionAt: iso(r.ScheduledDeletionAt), UserID: r.UserID.Hex(),
	}
}

// CancelByToken is cancelAccountDeletionByToken. The link's purpose token is
// the credential: the account is suspended and cannot sign in.
func CancelByToken(ctx context.Context, db *mongo.Database, tokens *auth.Tokens, sender *email.Sender, outbound, token string, now time.Time) (map[string]any, error) {
	claims, err := tokens.VerifyPurpose(token, auth.CancelAccountDeletion)
	if err != nil {
		return nil, httpx.NewError(400, "INVALID_TOKEN", "This cancellation link is invalid or has expired.", nil)
	}
	sub, _ := claims["sub"].(string)
	id, err := bson.ObjectIDFromHex(sub)
	if err != nil {
		// normalizeObjectId's refusal (resident-access.ts).
		return nil, httpx.NewError(422, "INVALID_OBJECT_ID", "Invalid user id.", nil)
	}
	var row deletionRow
	err = db.Collection("accountdeletionrequests").FindOneAndUpdate(ctx, bson.D{
		{Key: "cancelled", Value: false},
		{Key: "executed", Value: false},
		{Key: "scheduledDeletionAt", Value: bson.D{{Key: "$exists", Value: true}, {Key: "$ne", Value: nil}}},
		{Key: "userId", Value: id},
	}, bson.D{{Key: "$set", Value: bson.D{{Key: "cancelled", Value: true}, {Key: "cancelledAt", Value: now}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, httpx.NewError(404, "NOT_FOUND", "There is no deletion request to cancel on this account.", nil)
	}
	if err != nil {
		return nil, err
	}
	var user struct {
		Email string `bson:"email"`
		Name  string `bson:"name"`
	}
	err = db.Collection("users").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: id}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "ACTIVE"}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&user)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	// TS also tries an AuditLog row here, but with fields the schema doesn't
	// have and no actorId, so its validator refuses it and the .catch swallows
	// it — no row is ever written. Go writes none either.
	if user.Email != "" {
		content := email.AccountDeletionCancelled(outbound+"/login", user.Name)
		// sendNotificationEmail passes only subject and html: info@, not the template's security@.
		sender.Send(ctx, email.Message{To: []string{user.Email}, Subject: content.Subject, HTML: content.HTML})
	}
	return map[string]any{"request": serialize(row)}, nil
}
