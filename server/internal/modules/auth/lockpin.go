package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	platauth "github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// One PIN per account; ten wrong tries in a row block it until reset by email
// code. The count shows only once half are gone.
const (
	maxPinFailures   = 10
	quietPinFailures = 5
)

var errPinBlocked = fail(http.StatusLocked, "LOCK_PIN_BLOCKED", "Too many wrong PINs. Reset it with a code sent to your email.")

type pinRow struct {
	Email           *string    `bson:"email"`
	LockPinFailures *int64     `bson:"lockPinFailures"`
	LockPinHash     string     `bson:"lockPinHash"`
	LockPinSetAt    *time.Time `bson:"lockPinSetAt"`
	PasswordHash    string     `bson:"passwordHash"`
}

func (s *Service) loadPinRow(ctx context.Context, id bson.ObjectID) (*pinRow, error) {
	var r pinRow
	err := s.db.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: id}},
		options.FindOne().SetProjection(bson.D{{Key: "lockPinHash", Value: 1}, {Key: "passwordHash", Value: 1}, {Key: "email", Value: 1},
			{Key: "lockPinFailures", Value: 1}, {Key: "lockPinSetAt", Value: 1}})).Decode(&r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, errUserInactive
	}
	return &r, err
}

// checkPin spends one try, then compares.
func (s *Service) checkPin(ctx context.Context, id bson.ObjectID, pin string) error {
	var r pinRow
	err := s.db.Collection("users").FindOneAndUpdate(ctx,
		bson.D{{Key: "_id", Value: id}, {Key: "lockPinFailures", Value: bson.D{{Key: "$lt", Value: maxPinFailures}}}, {Key: "lockPinSetAt", Value: bson.D{{Key: "$ne", Value: nil}}}},
		bson.D{{Key: "$inc", Value: bson.D{{Key: "lockPinFailures", Value: 1}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: s.now()}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After).SetProjection(bson.D{{Key: "lockPinHash", Value: 1}, {Key: "lockPinFailures", Value: 1}})).Decode(&r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return errPinBlocked
	}
	if err != nil {
		return err
	}
	if r.LockPinHash == "" {
		return errPinBlocked
	}
	if !platauth.VerifyPassword(pin, r.LockPinHash) {
		failures := int64(maxPinFailures)
		if r.LockPinFailures != nil {
			failures = *r.LockPinFailures
		}
		left := maxPinFailures - failures
		if left <= 0 {
			return errPinBlocked
		}
		msg := "Wrong PIN. Try again."
		if failures > quietPinFailures {
			word := "tries"
			if left == 1 {
				word = "try"
			}
			msg = fmt.Sprintf("Wrong PIN. %d %s left.", left, word)
		}
		return fail(http.StatusBadRequest, "LOCK_PIN_INCORRECT", msg)
	}
	return s.setUser(ctx, id, bson.E{Key: "lockPinFailures", Value: 0})
}

// pinProof is LockPinProof; nil = absent.
type pinProof struct {
	ChallengeID, Code, CurrentPin, Password *string
}

// assertProof: the current PIN, a code mailed to the account, or — only for a
// login with no inbox — the account password.
func (s *Service) assertProof(ctx context.Context, userID string, r *pinRow, p pinProof) error {
	if p.ChallengeID != nil && p.Code != nil && *p.ChallengeID != "" && *p.Code != "" {
		_, err := s.BiometricVerify(ctx, userID, *p.ChallengeID, *p.Code)
		return err
	}
	id, _ := bson.ObjectIDFromHex(userID)
	if p.CurrentPin != nil && *p.CurrentPin != "" {
		return s.checkPin(ctx, id, *p.CurrentPin)
	}
	noInbox := r.Email == nil || *r.Email == "" || strings.HasSuffix(*r.Email, "@"+cookLoginDomain)
	if p.Password != nil && *p.Password != "" && noInbox && r.PasswordHash != "" {
		if platauth.VerifyPassword(*p.Password, r.PasswordHash) {
			return nil
		}
		return fail(http.StatusBadRequest, "INVALID_CREDENTIALS", "That password is not right.")
	}
	return fail(http.StatusBadRequest, "LOCK_PIN_PROOF_REQUIRED", "Enter your current PIN or the code sent to your email.")
}

// SetLockPin sets the first PIN, or replaces one with proof.
func (s *Service) SetLockPin(ctx context.Context, userID, pin string, p pinProof) (map[string]any, error) {
	id, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return nil, err
	}
	r, err := s.loadPinRow(ctx, id)
	if err != nil {
		return nil, err
	}
	if r.LockPinSetAt != nil {
		if err := s.assertProof(ctx, userID, r, p); err != nil {
			return nil, err
		}
	}
	hash, err := platauth.HashPassword(pin)
	if err != nil {
		return nil, err
	}
	if err := s.setUser(ctx, id, bson.E{Key: "lockPinFailures", Value: 0}, bson.E{Key: "lockPinHash", Value: hash}, bson.E{Key: "lockPinSetAt", Value: s.now()}); err != nil {
		return nil, err
	}
	return map[string]any{"hasLockPin": true}, nil
}

// RemoveLockPin turns the lock off everywhere.
func (s *Service) RemoveLockPin(ctx context.Context, userID string, p pinProof) (map[string]any, error) {
	id, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return nil, err
	}
	r, err := s.loadPinRow(ctx, id)
	if err != nil {
		return nil, err
	}
	if r.LockPinSetAt != nil {
		if err := s.assertProof(ctx, userID, r, p); err != nil {
			return nil, err
		}
		if _, err := s.db.Collection("users").UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{
			{Key: "$set", Value: bson.D{{Key: "lockPinFailures", Value: 0}, {Key: "lockPinSetAt", Value: nil}, {Key: "updatedAt", Value: s.now()}}},
			{Key: "$unset", Value: bson.D{{Key: "lockPinHash", Value: 1}}}}); err != nil {
			return nil, err
		}
	}
	return map[string]any{"hasLockPin": false}, nil
}

// VerifyLockPin: an account with no PIN has nothing to unlock and passes.
func (s *Service) VerifyLockPin(ctx context.Context, userID, pin string) (map[string]any, error) {
	id, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return nil, err
	}
	r, err := s.loadPinRow(ctx, id)
	if err != nil {
		return nil, err
	}
	if r.LockPinSetAt != nil {
		if err := s.checkPin(ctx, id, pin); err != nil {
			return nil, err
		}
	}
	return map[string]any{"verified": true}, nil
}

// --- lib/auth-attempts.ts: failed guesses only, in Mongo -------------------

const (
	failedAttemptLimit  = 5
	failedAttemptsPerIP = 30
	failedAttemptWindow = 15 * time.Minute
)

type attemptKeys struct {
	expiresAt   time.Time
	ip, subject string
}

func (s *Service) attemptKeys(c *gin.Context, namespace, subject string) attemptKeys {
	ms := failedAttemptWindow.Milliseconds()
	window := s.now().UnixMilli() / ms
	ip := c.ClientIP()
	if ip == "" {
		ip = "unknown-ip"
	}
	w := fmt.Sprint(window)
	return attemptKeys{
		expiresAt: time.UnixMilli((window + 1) * ms).UTC(),
		ip:        namespace + "|" + ip + "|*|" + w,
		subject:   namespace + "|" + ip + "|" + strings.ToLower(strings.TrimSpace(subject)) + "|" + w,
	}
}

// refuseIfTooManyFailures: a 429 once either budget is spent, checked before the secret.
func (s *Service) refuseIfTooManyFailures(c *gin.Context, namespace, subject string) error {
	k := s.attemptKeys(c, namespace, subject)
	cur, err := s.db.Collection("authattempts").Find(c, bson.D{{Key: "key", Value: bson.D{{Key: "$in", Value: bson.A{k.ip, k.subject}}}}},
		options.Find().SetProjection(bson.D{{Key: "key", Value: 1}, {Key: "count", Value: 1}}))
	if err != nil {
		return err
	}
	var rows []struct {
		Key   string `bson:"key"`
		Count int64  `bson:"count"`
	}
	if err := cur.All(c, &rows); err != nil {
		return err
	}
	count := func(key string) int64 {
		for _, r := range rows {
			if r.Key == key {
				return r.Count
			}
		}
		return 0
	}
	if count(k.subject) < failedAttemptLimit && count(k.ip) < failedAttemptsPerIP {
		return nil
	}
	retry := (k.expiresAt.Sub(s.now()) + time.Second - 1) / time.Second // Math.ceil
	return httpx.NewError(http.StatusTooManyRequests, "RATE_LIMITED", "Too many failed attempts. Please wait before trying again.",
		map[string]int64{"retryAfterSeconds": max(1, int64(retry))})
}

// recordFailedAttempt counts one wrong guess against both budgets; never throws.
func (s *Service) recordFailedAttempt(c *gin.Context, namespace, subject string) {
	k := s.attemptKeys(c, namespace, subject)
	for _, key := range []string{k.ip, k.subject} {
		if _, err := s.db.Collection("authattempts").UpdateOne(c, bson.D{{Key: "key", Value: key}},
			bson.D{{Key: "$inc", Value: bson.D{{Key: "count", Value: 1}}}, {Key: "$setOnInsert", Value: bson.D{{Key: "expiresAt", Value: k.expiresAt}}}},
			options.UpdateOne().SetUpsert(true)); err != nil {
			slogWarn(c, "auth_attempt_count_failed", err, namespace)
			return
		}
	}
}
