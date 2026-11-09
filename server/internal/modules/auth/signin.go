package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"log/slog"
	"math/big"
	"net/http"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	platauth "github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// Login: an identifier without "@" is a temporary username, with one an email;
// no fallback between them (one attempt must not become two).
func (s *Service) Login(ctx context.Context, identifier, password string, rc reqCtx) (*Issued, error) {
	identifier = strings.ToLower(strings.TrimSpace(identifier))
	if !strings.Contains(identifier, "@") {
		owner, credID, err := s.authenticateTemporaryCredential(ctx, identifier, password)
		if err != nil {
			return nil, err
		}
		if owner == nil {
			return nil, errInvalidCredentials
		}
		return s.issueSession(ctx, owner, rc, credID)
	}
	u, err := s.findUser(ctx, bson.D{{Key: "email", Value: identifier}, notDeleted(),
		{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "INVITED"}}}}})
	if err != nil {
		return nil, err
	}
	if u == nil || u.PasswordHash == "" || !platauth.VerifyPassword(password, u.PasswordHash) {
		return nil, errInvalidCredentials
	}
	if !u.verified() {
		return nil, fail(http.StatusForbidden, "EMAIL_NOT_VERIFIED", "Email is not verified. Check your inbox for the verification link.")
	}
	if u.Status == "INVITED" {
		u.Status = "ACTIVE"
		if err := s.setUser(ctx, u.ID, bson.E{Key: "status", Value: "ACTIVE"}); err != nil {
			return nil, err
		}
	}
	return s.issueSession(ctx, u, rc, "")
}

// authenticateTemporaryCredential: the live credential, its password, and an
// ACTIVE owner; a use is counted. nil owner = refused.
func (s *Service) authenticateTemporaryCredential(ctx context.Context, username, password string) (*userRow, string, error) {
	creds := s.db.Collection("temporarycredentials")
	var cred struct {
		ID           bson.ObjectID `bson:"_id"`
		PasswordHash string        `bson:"passwordHash"`
		UserID       bson.ObjectID `bson:"userId"`
		UseCount     int64         `bson:"useCount"`
	}
	err := creds.FindOne(ctx, bson.D{{Key: "expiresAt", Value: bson.D{{Key: "$gt", Value: s.now()}}}, {Key: "revokedAt", Value: nil}, {Key: "username", Value: username}}).Decode(&cred)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, "", nil
	}
	if err != nil {
		return nil, "", err
	}
	if cred.PasswordHash == "" || !platauth.VerifyPassword(password, cred.PasswordHash) {
		return nil, "", nil
	}
	owner, err := s.findUser(ctx, bson.D{{Key: "_id", Value: cred.UserID}, notDeleted(), {Key: "status", Value: "ACTIVE"}})
	if err != nil || owner == nil {
		return nil, "", err
	}
	now := s.now()
	if _, err := creds.UpdateOne(ctx, bson.D{{Key: "_id", Value: cred.ID}}, bson.D{{Key: "$set", Value: bson.D{
		{Key: "lastUsedAt", Value: now}, {Key: "useCount", Value: cred.UseCount + 1}, {Key: "updatedAt", Value: now}}}}); err != nil {
		return nil, "", err
	}
	return owner, cred.ID.Hex(), nil
}

// --- OTP -------------------------------------------------------------------

func (s *Service) hashOTP(identifier, code string) string {
	return platauth.HashToken(identifier + ":" + code + ":" + s.cfg.OTP.HashSecret)
}

// OTPRequest is requestOtpChallenge. purpose "biometric" and "plan-checkout"
// come only from server code, never the public route.
// otpChallenge keeps TS's key order; devCode is absent in production.
type otpChallenge struct {
	ChallengeID string      `json:"challengeId"`
	Delivery    otpDelivery `json:"delivery"`
	ExpiresAt   string      `json:"expiresAt"`
	DevCode     string      `json:"devCode,omitempty"`
}

// otpGates holds one short-lived document per address while a code is being sent
// (OTPRequest); its TTL index on `until` is declared in cmd/indexes.
const otpGates = "otpgates"

const otpGateHold = 5 * time.Second

func (s *Service) OTPRequest(ctx context.Context, channel, identifier, purpose string, rc reqCtx) (*otpChallenge, error) {
	identifier = strings.ToLower(strings.TrimSpace(identifier))
	if purpose == "registration" && channel == "email" {
		taken, err := s.exists(ctx, "users", bson.D{{Key: "email", Value: identifier}, notDeleted()})
		if err != nil {
			return nil, err
		}
		if taken {
			return nil, fail(http.StatusConflict, "ACCOUNT_ALREADY_EXISTS", "An account already exists for this email. Try signing in.")
		}
	}
	// The row is written first and counted with the others, so a parallel burst
	// cannot all pass a count read before any of them wrote (P11-16). A refused or
	// undelivered request removes its own row.
	now := s.now().Truncate(time.Millisecond)
	coll := s.db.Collection("otpchallenges")
	n, err := rand.Int(rand.Reader, big.NewInt(900000))
	if err != nil {
		return nil, err
	}
	code := big.NewInt(0).Add(n, big.NewInt(100000)).String()
	expiresAt := now.Add(s.cfg.OTP.TTL).Truncate(time.Millisecond)
	id := bson.NewObjectID()
	doc := bson.D{{Key: "_id", Value: id}, {Key: "attempts", Value: 0}, {Key: "channel", Value: channel},
		{Key: "codeHash", Value: s.hashOTP(identifier, code)}, {Key: "codeLastSentAt", Value: now},
		{Key: "consumedAt", Value: nil}, {Key: "expiresAt", Value: expiresAt}, {Key: "identifier", Value: identifier}}
	if rc.IP != "" {
		doc = append(doc, bson.E{Key: "ipAddress", Value: rc.IP})
	}
	doc = append(doc, bson.E{Key: "purpose", Value: purpose}, bson.E{Key: "requestCount", Value: 1})
	if rc.UserAgent != "" {
		doc = append(doc, bson.E{Key: "userAgent", Value: rc.UserAgent})
	}
	doc = append(doc, bson.E{Key: "verifiedAt", Value: nil}, bson.E{Key: "createdAt", Value: now},
		bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	refuse := func(err error) (*otpChallenge, error) {
		if _, derr := coll.DeleteOne(context.WithoutCancel(ctx), bson.D{{Key: "_id", Value: id}}); derr != nil {
			slog.WarnContext(ctx, derr.Error(), "action", "otp_challenge_cleanup_failed")
		}
		return nil, err
	}
	// An insert that errors may still have landed (a reply lost on the way back):
	// remove it by id, a no-op when it did not.
	if _, err := coll.InsertOne(ctx, doc); err != nil {
		return refuse(err)
	}
	same := bson.D{{Key: "channel", Value: channel}, {Key: "identifier", Value: identifier}, {Key: "purpose", Value: purpose}}
	// Only rows up to this one count, so the earliest requests of a burst are the ones served.
	recent, err := coll.CountDocuments(ctx, append(same, bson.E{Key: "_id", Value: bson.D{{Key: "$lte", Value: id}}},
		bson.E{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: now.Add(-s.cfg.OTP.RateLimitWindow)}}}))
	if err != nil {
		return refuse(err)
	}
	if recent > int64(s.cfg.OTP.RateLimitMax) {
		return refuse(fail(http.StatusTooManyRequests, "OTP_RATE_LIMITED", "Too many OTP requests. Please wait before trying again."))
	}
	// Of two requests inside the cooldown, the earlier row wins.
	earlier, err := s.exists(ctx, "otpchallenges", append(same, bson.E{Key: "_id", Value: bson.D{{Key: "$lt", Value: id}}},
		bson.E{Key: "consumedAt", Value: nil}, bson.E{Key: "expiresAt", Value: bson.D{{Key: "$gt", Value: now}}},
		bson.E{Key: "codeLastSentAt", Value: bson.D{{Key: "$gt", Value: now.Add(-s.cfg.OTP.ResendCooldown)}}}))
	if err != nil {
		return refuse(err)
	}
	if earlier {
		return refuse(fail(http.StatusTooManyRequests, "OTP_RESEND_COOLDOWN", "Please wait before requesting another OTP."))
	}
	// The row check alone loses a burst: each request picks its _id before its insert
	// lands, and _ids from two replicas in one second do not sort by time, so two can
	// each check before the other's row exists and both send. The gate is one document
	// per address keyed by _id: of concurrent upserts one finds it free and the rest hit
	// the duplicate _id. Held past _id's one-second granularity, after which the row
	// check above sees every earlier send.
	gates := s.db.Collection(otpGates)
	gateKey := channel + ":" + purpose + ":" + identifier
	gateUntil := now.Add(min(s.cfg.OTP.ResendCooldown, otpGateHold))
	if _, err := gates.UpdateOne(ctx, bson.D{{Key: "_id", Value: gateKey}, {Key: "until", Value: bson.D{{Key: "$lte", Value: now}}}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "until", Value: gateUntil}}}}, options.UpdateOne().SetUpsert(true)); err != nil {
		if mongo.IsDuplicateKeyError(err) {
			return refuse(fail(http.StatusTooManyRequests, "OTP_RESEND_COOLDOWN", "Please wait before requesting another OTP."))
		}
		return refuse(err)
	}
	instruction := ""
	if purpose == "biometric" {
		instruction = "Enter this code to confirm it is you. It lets you set a new app-lock PIN, or turns the lock off."
	}
	delivery, err := s.dispatchOTP(ctx, channel, code, identifier, instruction)
	if err != nil {
		// Nothing was sent: the next request must not wait on this one.
		_, _ = gates.DeleteOne(context.WithoutCancel(ctx), bson.D{{Key: "_id", Value: gateKey}, {Key: "until", Value: gateUntil}})
		return refuse(err)
	}
	out := &otpChallenge{ChallengeID: id.Hex(), Delivery: delivery, ExpiresAt: httpx.ISO(expiresAt)}
	if !s.cfg.IsProduction() {
		out.DevCode = code
	}
	return out, nil
}

// otpDelivery keeps TS's key order: channel, provider, status.
type otpDelivery struct {
	Channel  string `json:"channel"`
	Provider string `json:"provider"`
	Status   string `json:"status"`
}

func (s *Service) dispatchOTP(ctx context.Context, channel, code, identifier, instruction string) (otpDelivery, error) {
	if s.cfg.Email.ResendAPIKey == "" {
		if !s.cfg.IsProduction() {
			return otpDelivery{channel, "development", "development"}, nil
		}
		return otpDelivery{}, fail(http.StatusServiceUnavailable, "OTP_DELIVERY_NOT_CONFIGURED", "OTP delivery provider is not configured.")
	}
	content := email.OTPCode(code, s.cfg.OTP.TTL.Minutes(), instruction, "")
	r := s.email.Send(ctx, email.Message{Category: content.Category, To: []string{identifier}, Subject: content.Subject, HTML: content.HTML})
	if !r.Sent {
		if r.Reason == "not_configured" {
			return otpDelivery{}, fail(http.StatusServiceUnavailable, "OTP_DELIVERY_NOT_CONFIGURED", "Resend OTP email is not configured.")
		}
		return otpDelivery{}, fail(http.StatusBadGateway, "OTP_DELIVERY_FAILED", "Could not send OTP email.")
	}
	return otpDelivery{channel, "resend", "queued"}, nil
}

var errOTPInvalid = fail(http.StatusBadRequest, "OTP_INVALID", "OTP challenge is invalid or expired.")

// OTPVerify is verifyOtpChallenge: the attempt is spent before the compare, atomically.
type otpVerified struct {
	ChallengeID string `json:"challengeId"`
	Channel     string `json:"channel"`
	Identifier  string `json:"identifier"`
	VerifiedAt  string `json:"verifiedAt"`
}

func (s *Service) OTPVerify(ctx context.Context, challengeID, code string) (*otpVerified, error) {
	id, err := bson.ObjectIDFromHex(challengeID)
	if err != nil {
		return nil, errOTPInvalid
	}
	coll := s.db.Collection("otpchallenges")
	live := bson.D{{Key: "_id", Value: id}, {Key: "consumedAt", Value: nil}, {Key: "expiresAt", Value: bson.D{{Key: "$gt", Value: s.now()}}}}
	if ok, err := s.exists(ctx, "otpchallenges", live); err != nil || !ok {
		if err != nil {
			return nil, err
		}
		return nil, errOTPInvalid
	}
	var ch struct {
		ID         bson.ObjectID `bson:"_id"`
		Channel    string        `bson:"channel"`
		CodeHash   string        `bson:"codeHash"`
		Identifier string        `bson:"identifier"`
	}
	err = coll.FindOneAndUpdate(ctx, append(live, bson.E{Key: "attempts", Value: bson.D{{Key: "$lt", Value: 5}}}),
		bson.D{{Key: "$inc", Value: bson.D{{Key: "attempts", Value: 1}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: s.now()}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&ch)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, fail(http.StatusTooManyRequests, "OTP_ATTEMPT_LIMIT", "Too many OTP verification attempts.")
	}
	if err != nil {
		return nil, err
	}
	if subtle.ConstantTimeCompare([]byte(ch.CodeHash), []byte(s.hashOTP(ch.Identifier, code))) != 1 {
		return nil, fail(http.StatusBadRequest, "OTP_INCORRECT", "OTP code is incorrect.")
	}
	verifiedAt := s.now().Truncate(time.Millisecond)
	if _, err := coll.UpdateOne(ctx, bson.D{{Key: "_id", Value: ch.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "verifiedAt", Value: verifiedAt}, {Key: "updatedAt", Value: verifiedAt}}}}); err != nil {
		return nil, err
	}
	return &otpVerified{ch.ID.Hex(), ch.Channel, ch.Identifier, httpx.ISO(verifiedAt)}, nil
}

// accountEmail: the account's own inbox, never one the caller names.
func (s *Service) accountEmail(ctx context.Context, userID string) (string, error) {
	id, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return "", err
	}
	u, err := s.findUser(ctx, bson.D{{Key: "_id", Value: id}})
	if err != nil {
		return "", err
	}
	addr := ""
	if u != nil && u.Email != nil {
		addr = normalizeEmail(*u.Email)
	}
	if addr == "" || strings.HasSuffix(addr, "@"+cookLoginDomain) {
		return "", fail(http.StatusConflict, "NO_ACCOUNT_EMAIL", "This account has no email address to send a code to.")
	}
	return addr, nil
}

// BiometricCode mails the signed-in account a code (fingerprint-lock recovery).
func (s *Service) BiometricCode(ctx context.Context, userID string, rc reqCtx) (*otpChallenge, error) {
	addr, err := s.accountEmail(ctx, userID)
	if err != nil {
		return nil, err
	}
	return s.OTPRequest(ctx, "email", addr, "biometric", rc)
}

// BiometricVerify checks and spends that account's own biometric code.
func (s *Service) BiometricVerify(ctx context.Context, userID, challengeID, code string) (map[string]any, error) {
	addr, err := s.accountEmail(ctx, userID)
	if err != nil {
		return nil, err
	}
	id, err := bson.ObjectIDFromHex(challengeID)
	if err != nil {
		return nil, errOTPInvalid
	}
	owned, err := s.exists(ctx, "otpchallenges", bson.D{{Key: "_id", Value: id}, {Key: "identifier", Value: addr}, {Key: "purpose", Value: "biometric"}})
	if err != nil {
		return nil, err
	}
	if !owned {
		return nil, errOTPInvalid
	}
	if _, err := s.OTPVerify(ctx, challengeID, code); err != nil {
		return nil, err
	}
	now := s.now()
	if _, err := s.db.Collection("otpchallenges").UpdateOne(ctx, bson.D{{Key: "_id", Value: id}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "consumedAt", Value: now}, {Key: "updatedAt", Value: now}}}}); err != nil {
		return nil, err
	}
	return map[string]any{"verified": true}, nil
}

// Register is registerPublicAccount: a verified registration OTP for this email.
func (s *Service) Register(ctx context.Context, emailAddr, name, challengeID, password string, rc reqCtx) (*Issued, error) {
	addr := normalizeEmail(emailAddr)
	if addr == "" {
		return nil, fail(http.StatusBadRequest, "EMAIL_REQUIRED", "Email is required.")
	}
	existing, err := s.findUser(ctx, bson.D{{Key: "email", Value: addr}, notDeleted()})
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return nil, fail(http.StatusConflict, "ACCOUNT_ALREADY_EXISTS", "An account already exists for this email.")
	}
	id, _ := bson.ObjectIDFromHex(challengeID) // schema-checked
	var ch struct {
		ID         bson.ObjectID `bson:"_id"`
		Channel    string        `bson:"channel"`
		Identifier string        `bson:"identifier"`
	}
	err = s.db.Collection("otpchallenges").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "consumedAt", Value: nil},
		{Key: "expiresAt", Value: bson.D{{Key: "$gt", Value: s.now()}}}, {Key: "purpose", Value: "registration"},
		{Key: "verifiedAt", Value: bson.D{{Key: "$ne", Value: nil}}}}).Decode(&ch)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, fail(http.StatusBadRequest, "REGISTRATION_OTP_REQUIRED", "A verified registration OTP is required.")
	}
	if err != nil {
		return nil, err
	}
	if ch.Channel != "email" || addr != ch.Identifier {
		return nil, fail(http.StatusBadRequest, "REGISTRATION_OTP_MISMATCH", "Verified OTP does not match this registration.")
	}
	now := s.now().Truncate(time.Millisecond)
	hash, err := platauth.HashPassword(password)
	if err != nil {
		return nil, err
	}
	u, err := s.createUser(ctx, newUser{Name: name, Email: addr, EmailVerified: true, EmailVerifiedAt: &now, PasswordHash: hash})
	if err != nil {
		return nil, err
	}
	if _, err := s.db.Collection("otpchallenges").UpdateOne(ctx, bson.D{{Key: "_id", Value: ch.ID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "consumedAt", Value: now}, {Key: "updatedAt", Value: s.now()}}}}); err != nil {
		return nil, err
	}
	return s.issueSession(ctx, u, rc, "")
}

// PlanCheckoutOTP is requestOtpChallenge for the public plan checkout: a code to
// the hostel's email. devCode is empty in production.
func (s *Service) PlanCheckoutOTP(ctx context.Context, email, ip, userAgent string) (id, expiresAt, devCode string, err error) {
	ch, err := s.OTPRequest(ctx, "email", email, "plan-checkout", reqCtx{IP: ip, UserAgent: userAgent})
	if err != nil {
		return "", "", "", err
	}
	return ch.ChallengeID, ch.ExpiresAt, ch.DevCode, nil
}

// VerifiedIdentifier is verifyOtpChallenge's identifier.
func (s *Service) VerifiedIdentifier(ctx context.Context, challengeID, code string) (string, error) {
	v, err := s.OTPVerify(ctx, challengeID, code)
	if err != nil {
		return "", err
	}
	return v.Identifier, nil
}

// ResendCooldown is otpResendCooldownMs.
func (s *Service) ResendCooldown() time.Duration { return s.cfg.OTP.ResendCooldown }
