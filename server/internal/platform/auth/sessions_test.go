package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
)

// Runs against the local compose Mongo in a throwaway database; skipped when
// it isn't up. Cases mirror auth.service.test.ts's refresh tests.
func TestRotation(t *testing.T) {
	ctx := context.Background()
	client, db, err := appmongo.Connect(ctx, "mongodb://127.0.0.1:27018/hostelpalika_authtest?directConnection=true")
	if err != nil {
		t.Skip("local Mongo not running:", err)
	}
	defer func() { _ = db.Drop(ctx); _ = client.Disconnect(ctx) }()

	now := time.Now()
	s := NewSessions(db, time.Hour)
	s.now = func() time.Time { return now }
	open := func() (*Session, string) {
		sess := s.New(bson.NewObjectID(), nil, "1.2.3.4", "test")
		tok := "refresh-" + sess.ID.Hex()
		if err := s.Insert(ctx, sess, tok); err != nil {
			t.Fatal(err)
		}
		return sess, tok
	}
	refresh := func(sess *Session, tok, next string, cookie bool) (bool, error) {
		p, err := s.Find(ctx, sess.ID.Hex(), tok)
		if err != nil {
			return false, err
		}
		return s.Rotate(ctx, p, next, cookie)
	}
	live := func(sess *Session) bool {
		n, _ := s.c.CountDocuments(ctx, bson.D{{Key: "_id", Value: sess.ID}, {Key: "revokedAt", Value: nil}})
		return n == 1
	}

	// rotates, and the old token becomes "previous"
	sess, t0 := open()
	if ok, err := refresh(sess, t0, "t1", false); !ok || err != nil {
		t.Fatalf("rotate: %v %v", ok, err)
	}
	// a browser re-presenting the just-rotated token: access only, no new refresh token
	if ok, err := refresh(sess, t0, "t1b", true); ok || err != nil {
		t.Fatalf("browser reuse: %v %v", ok, err)
	}
	// a phone whose rotation reply was lost: gets a fresh token over the lost one
	if ok, err := refresh(sess, t0, "t2", false); !ok || err != nil {
		t.Fatalf("lost reply: %v %v", ok, err)
	}
	if ok, err := refresh(sess, "t2", "t3", false); !ok || err != nil {
		t.Fatalf("reissued token rotates: %v %v", ok, err)
	}
	// a token two rotations old is a replayed copy: session ends for everyone
	if _, err := refresh(sess, "t1", "x", false); !errors.Is(err, ErrInvalidSession) || live(sess) {
		t.Fatalf("replay: %v live=%v", err, live(sess))
	}
	if _, err := refresh(sess, "t3", "x", false); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("revoked session still refreshes: %v", err)
	}

	// concurrent refresh: both read, only one rotates; the loser's phone retry is refused nothing
	sess, t0 = open()
	p1, _ := s.Find(ctx, sess.ID.Hex(), t0)
	p2, _ := s.Find(ctx, sess.ID.Hex(), t0)
	if ok, _ := s.Rotate(ctx, p1, "w", true); !ok {
		t.Fatal("winner did not rotate")
	}
	if ok, err := s.Rotate(ctx, p2, "l", true); ok || err != nil {
		t.Fatalf("cookie loser: %v %v (must not hand out a token)", ok, err)
	}

	// logout revokes only that session
	sess, t0 = open()
	other, _ := open()
	if err := s.Logout(ctx, t0); err != nil || live(sess) || !live(other) {
		t.Fatalf("logout: %v", err)
	}
	// expired sessions are invalid
	sess, t0 = open()
	s.now = func() time.Time { return now.Add(2 * time.Hour) }
	if _, err := s.Find(ctx, sess.ID.Hex(), t0); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("expired: %v", err)
	}
}
