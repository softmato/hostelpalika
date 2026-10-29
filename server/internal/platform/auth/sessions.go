package auth

import (
	"context"
	"net/http"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// ErrInvalidSession is AuthServiceError("Refresh session is invalid.", "INVALID_SESSION").
var ErrInvalidSession = httpx.NewError(http.StatusUnauthorized, "INVALID_SESSION", "Refresh session is invalid.", nil)

// RefreshReuseWindow: a browser may present the token rotated away this
// recently (an aborted navigation's cookie) without it counting as theft.
const RefreshReuseWindow = time.Minute

// Session is a row of the mongoose `sessions` collection (timestamps on).
type Session struct {
	ID                       bson.ObjectID  `bson:"_id"`
	UserID                   bson.ObjectID  `bson:"userId"`
	TemporaryCredentialID    *bson.ObjectID `bson:"temporaryCredentialId"`
	RefreshTokenHash         *string        `bson:"refreshTokenHash"`
	PreviousRefreshTokenHash *string        `bson:"previousRefreshTokenHash"`
	RefreshTokenRotatedAt    *time.Time     `bson:"refreshTokenRotatedAt"`
	UserAgent                string         `bson:"userAgent,omitempty"`
	IPAddress                string         `bson:"ipAddress,omitempty"`
	ExpiresAt                time.Time      `bson:"expiresAt"`
	LastSeenAt               *time.Time     `bson:"lastSeenAt,omitempty"`
	RevokedAt                *time.Time     `bson:"revokedAt"`
	CreatedAt                time.Time      `bson:"createdAt"`
	UpdatedAt                time.Time      `bson:"updatedAt"`
	V                        int            `bson:"__v"`
}

type Sessions struct {
	c          *mongo.Collection
	refreshTTL time.Duration
	now        func() time.Time
}

func NewSessions(db *mongo.Database, refreshTTL time.Duration) *Sessions {
	return &Sessions{db.Collection("sessions"), refreshTTL, time.Now}
}

// New is the unsaved row issueSessionForUser builds first: its id goes into
// the tokens, then Insert stores it with the refresh token's hash.
func (s *Sessions) New(userID bson.ObjectID, temporaryCredentialID *bson.ObjectID, ip, userAgent string) *Session {
	now := s.now()
	return &Session{
		ID: bson.NewObjectID(), UserID: userID, TemporaryCredentialID: temporaryCredentialID,
		UserAgent: userAgent, IPAddress: ip, ExpiresAt: now.Add(s.refreshTTL),
		CreatedAt: now, UpdatedAt: now,
	}
}

func (s *Sessions) Insert(ctx context.Context, sess *Session, refreshToken string) error {
	h := HashToken(refreshToken)
	sess.RefreshTokenHash = &h
	_, err := s.c.InsertOne(ctx, sess)
	return err
}

// Presented is a refresh token matched to its live session.
type Presented struct {
	Session     *Session
	Hash        string
	IsCurrent   bool
	JustRotated bool // previous token, rotated inside RefreshReuseWindow
}

// Find loads the live session a verified refresh token names. A correctly
// signed token that is neither the current nor the previous one is a
// replayed copy: the session ends for every holder (reuse detection).
func (s *Sessions) Find(ctx context.Context, sessionID, refreshToken string) (*Presented, error) {
	id, err := bson.ObjectIDFromHex(sessionID)
	if err != nil {
		return nil, ErrInvalidSession
	}
	now := s.now()
	var sess Session
	err = s.c.FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "expiresAt", Value: bson.D{{Key: "$gt", Value: now}}}, {Key: "revokedAt", Value: nil}}).Decode(&sess)
	if err == mongo.ErrNoDocuments {
		return nil, ErrInvalidSession
	}
	if err != nil {
		return nil, err
	}
	p := &Presented{Session: &sess, Hash: HashToken(refreshToken)}
	p.IsCurrent = eq(sess.RefreshTokenHash, p.Hash)
	isPrevious := eq(sess.PreviousRefreshTokenHash, p.Hash)
	p.JustRotated = isPrevious && sess.RefreshTokenRotatedAt != nil && sess.RefreshTokenRotatedAt.After(now.Add(-RefreshReuseWindow))
	if !p.IsCurrent && !isPrevious {
		if _, err := s.c.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "revokedAt", Value: nil}}, set(now, bson.E{Key: "revokedAt", Value: now})); err != nil {
			return nil, err
		}
		return nil, ErrInvalidSession
	}
	return p, nil
}

// Rotate stores the new refresh token after the caller has re-authorised the
// user and signed it. It reports whether the new token is the session's now;
// false means a browser reuse, whose jar keeps the winner's cookie, so the
// caller sends no refresh token back.
func (s *Sessions) Rotate(ctx context.Context, p *Presented, newRefreshToken string, cookieSession bool) (bool, error) {
	now := s.now()
	newHash := HashToken(newRefreshToken)
	rotated := false
	if p.IsCurrent {
		// Compare-and-set on the presented hash: of two concurrent refreshes only one rotates.
		res, err := s.c.UpdateOne(ctx, bson.D{{Key: "_id", Value: p.Session.ID}, {Key: "refreshTokenHash", Value: p.Hash}},
			set(now, bson.E{Key: "lastSeenAt", Value: now}, bson.E{Key: "previousRefreshTokenHash", Value: p.Hash},
				bson.E{Key: "refreshTokenHash", Value: newHash}, bson.E{Key: "refreshTokenRotatedAt", Value: now}))
		if err != nil {
			return false, err
		}
		rotated = res.ModifiedCount == 1
	}
	if rotated {
		return true, nil
	}
	if cookieSession && (p.IsCurrent || p.JustRotated) {
		// The concurrent winner's reply is writing the new cookie into the same jar.
		_, err := s.c.UpdateOne(ctx, bson.D{{Key: "_id", Value: p.Session.ID}}, set(now, bson.E{Key: "lastSeenAt", Value: now}))
		return false, err
	}
	// The reply carrying the replacement was lost (a phone's dropped
	// connection): replace the token it never received.
	res, err := s.c.UpdateOne(ctx, bson.D{{Key: "_id", Value: p.Session.ID}, {Key: "previousRefreshTokenHash", Value: p.Hash}, {Key: "revokedAt", Value: nil}},
		set(now, bson.E{Key: "lastSeenAt", Value: now}, bson.E{Key: "refreshTokenHash", Value: newHash}))
	if err != nil {
		return false, err
	}
	if res.ModifiedCount != 1 {
		return false, ErrInvalidSession
	}
	return true, nil
}

// Revoke ends one session (a temporary credential that stopped being valid).
func (s *Sessions) Revoke(ctx context.Context, id bson.ObjectID) error {
	now := s.now()
	_, err := s.c.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, set(now, bson.E{Key: "revokedAt", Value: now}))
	return err
}

// Logout revokes the session holding this refresh token, if still live.
func (s *Sessions) Logout(ctx context.Context, refreshToken string) error {
	now := s.now()
	_, err := s.c.UpdateOne(ctx, bson.D{{Key: "refreshTokenHash", Value: HashToken(refreshToken)}, {Key: "revokedAt", Value: nil}}, set(now, bson.E{Key: "revokedAt", Value: now}))
	return err
}

// RevokeAll signs a user out everywhere (password reset/change).
func (s *Sessions) RevokeAll(ctx context.Context, userID bson.ObjectID) error {
	now := s.now()
	_, err := s.c.UpdateMany(ctx, bson.D{{Key: "userId", Value: userID}, {Key: "revokedAt", Value: nil}}, set(now, bson.E{Key: "revokedAt", Value: now}))
	return err
}

// set is a $set that also stamps updatedAt, as mongoose's timestamps do on every update.
func set(now time.Time, fields ...bson.E) bson.D {
	return bson.D{{Key: "$set", Value: append(bson.D{{Key: "updatedAt", Value: now}}, fields...)}}
}

func eq(stored *string, hash string) bool { return stored != nil && *stored == hash }
