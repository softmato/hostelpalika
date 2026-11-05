package auth_test

import (
	"context"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/contract/fixture"
	"github.com/softmato/hostelpalika/server/internal/platform/auth"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
)

// The previous refresh token replaces a lost reply for a day after the
// rotation; an older one is a replay and ends the session (P11-16).
func TestPreviousTokenIsBounded(t *testing.T) {
	ctx := context.Background()
	client, _, err := appmongo.Connect(ctx, fixture.URI)
	if err != nil {
		t.Skip("contract Mongo not running:", err)
	}
	db := client.Database("hostelpalika_contract_sessions")
	if err := db.Drop(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Drop(ctx); _ = client.Disconnect(ctx) })
	s := auth.NewSessions(db, 30*24*time.Hour)

	for name, tc := range map[string]struct {
		rotated time.Duration
		ok      bool
	}{"an hour ago": {time.Hour, true}, "two days ago": {48 * time.Hour, false}} {
		sess := s.New(bson.NewObjectID(), nil, "", "")
		if err := s.Insert(ctx, sess, "current-"+name); err != nil {
			t.Fatal(err)
		}
		prev, at := auth.HashToken("previous-"+name), time.Now().Add(-tc.rotated)
		if _, err := db.Collection("sessions").UpdateOne(ctx, bson.D{{Key: "_id", Value: sess.ID}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "previousRefreshTokenHash", Value: prev}, {Key: "refreshTokenRotatedAt", Value: at}}}}); err != nil {
			t.Fatal(err)
		}
		_, err := s.Find(ctx, sess.ID.Hex(), "previous-"+name)
		if (err == nil) != tc.ok {
			t.Fatalf("%s: Find err = %v, want ok=%v", name, err, tc.ok)
		}
		var row struct {
			RevokedAt *time.Time `bson:"revokedAt"`
		}
		_ = db.Collection("sessions").FindOne(ctx, bson.D{{Key: "_id", Value: sess.ID}}).Decode(&row)
		if (row.RevokedAt == nil) != tc.ok {
			t.Fatalf("%s: revokedAt = %v", name, row.RevokedAt)
		}
	}
}
