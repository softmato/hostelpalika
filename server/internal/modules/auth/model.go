// Package auth is modules/auth: the 20 /api/v1/auth routes, sign-in, sessions,
// OTP, the app-lock PIN, Google sign-in and the password flows.
package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/hostels"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// fail is AuthServiceError: default status 401.
func fail(status int, code, msg string) *httpx.Error { return httpx.NewError(status, code, msg, nil) }

var (
	errInvalidCredentials = fail(http.StatusUnauthorized, "INVALID_CREDENTIALS", "Invalid credentials.")
	errUserInactive       = fail(http.StatusUnauthorized, "USER_INACTIVE", "User no longer has access.")
	errInvalidSession     = fail(http.StatusUnauthorized, "INVALID_SESSION", "Refresh session is invalid.")
	errTempInvalid        = fail(http.StatusUnauthorized, "TEMPORARY_CREDENTIAL_INVALID", "This temporary login is no longer valid.")
)

// cookLoginDomain is COOK_LOGIN_DOMAIN: a minted cook login is a username, not an inbox.
const cookLoginDomain = "cook.local"

// claimable: INVITED is pending, not revoked.
func claimable(status string) bool { return status == "ACTIVE" || status == "INVITED" }

// userRow is what the auth flows read of a User (passwordHash/lockPinHash are select:false in TS).
type userRow struct {
	ID                 bson.ObjectID   `bson:"_id"`
	Name               string          `bson:"name"`
	Email              *string         `bson:"email"`
	EmailVerified      bool            `bson:"emailVerified"`
	EmailVerifiedAt    *time.Time      `bson:"emailVerifiedAt"`
	HostelIDs          []bson.ObjectID `bson:"hostelIds"`
	Image              *string         `bson:"image"`
	LockPinSetAt       *time.Time      `bson:"lockPinSetAt"`
	MustChangePassword bool            `bson:"mustChangePassword"`
	Phone              *string         `bson:"phone"`
	Role               string          `bson:"role"`
	Status             string          `bson:"status"`
	UserResidentID     *string         `bson:"userResidentId"`
	PasswordHash       string          `bson:"passwordHash"`
	TokenVersion       *int64          `bson:"tokenVersion"`
	GoogleID           string          `bson:"googleId"`
}

func (u *userRow) hostelIDs() []string {
	ids := make([]string, len(u.HostelIDs))
	for i, h := range u.HostelIDs {
		ids[i] = h.Hex()
	}
	return ids
}

func (u *userRow) verified() bool { return u.EmailVerified || u.EmailVerifiedAt != nil }

func (u *userRow) tokenVersion() int64 {
	if u.TokenVersion == nil {
		return 0
	}
	return *u.TokenVersion
}

// PublicUser is publicUser, in its key order.
type PublicUser struct {
	ID                 string   `json:"id"`
	Email              *string  `json:"email"`
	EmailVerified      bool     `json:"emailVerified"`
	HostelIDs          []string `json:"hostelIds"`
	Image              *string  `json:"image"`
	HasLockPin         bool     `json:"hasLockPin"`
	MustChangePassword bool     `json:"mustChangePassword"`
	Name               string   `json:"name"`
	Phone              *string  `json:"phone"`
	Role               string   `json:"role"`
	RedirectPath       string   `json:"redirectPath"`
	Status             string   `json:"status"`
	UserResidentID     *string  `json:"userResidentId"`
}

func publicUser(u *userRow) PublicUser {
	return PublicUser{
		ID: u.ID.Hex(), Email: u.Email, EmailVerified: u.verified(), HostelIDs: u.hostelIDs(), Image: u.Image,
		HasLockPin: u.LockPinSetAt != nil, MustChangePassword: u.MustChangePassword, Name: u.Name, Phone: u.Phone,
		Role: u.Role, RedirectPath: authz.LandingPath(authz.Role(u.Role)), Status: u.Status, UserResidentID: u.UserResidentID,
	}
}

// SessionUser is the user a sign-in returns. cookFingerprintLock is absent
// (undefined) for every role but COOK.
type SessionUser struct {
	PublicUser
	CookFingerprintLock    *bool               `json:"cookFingerprintLock,omitempty"`
	HostelKyc              *hostels.AccountKyc `json:"hostelKyc"`
	IsServiceProvider      bool                `json:"isServiceProvider"`
	ViaTemporaryCredential bool                `json:"viaTemporaryCredential"`
}

// RefreshUser is the user a refresh returns: no cook lock.
type RefreshUser struct {
	PublicUser
	HostelKyc              *hostels.AccountKyc `json:"hostelKyc"`
	IsServiceProvider      bool                `json:"isServiceProvider"`
	ViaTemporaryCredential bool                `json:"viaTemporaryCredential"`
}

// MeUser is getCurrentUser plus the route's pinLocked.
type MeUser struct {
	PublicUser
	CookFingerprintLock    *bool                      `json:"cookFingerprintLock,omitempty"`
	HostelKyc              *hostels.AccountKyc        `json:"hostelKyc"`
	HostelSuspension       *hostels.AccountSuspension `json:"hostelSuspension"`
	IsServiceProvider      bool                       `json:"isServiceProvider"`
	SessionStale           bool                       `json:"sessionStale"`
	ViaTemporaryCredential bool                       `json:"viaTemporaryCredential"`
	PinLocked              bool                       `json:"pinLocked"`
}

func normalizeEmail(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

func notDeleted() bson.E { return bson.E{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}} }

func (s *Service) findUser(ctx context.Context, filter bson.D) (*userRow, error) {
	var u userRow
	err := s.db.Collection("users").FindOne(ctx, filter).Decode(&u)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// exists is Model.exists: one _id, nothing else read.
func (s *Service) exists(ctx context.Context, coll string, filter bson.D) (bool, error) {
	err := s.db.Collection(coll).FindOne(ctx, filter, options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Err()
	if errors.Is(err, mongo.ErrNoDocuments) {
		return false, nil
	}
	return err == nil, err
}

// setUser is a mongoose save/updateOne on a User: $set plus updatedAt.
func (s *Service) setUser(ctx context.Context, id bson.ObjectID, fields ...bson.E) error {
	_, err := s.db.Collection("users").UpdateOne(ctx, bson.D{{Key: "_id", Value: id}},
		bson.D{{Key: "$set", Value: append(bson.D(fields), bson.E{Key: "updatedAt", Value: s.now()})}})
	return err
}

// newUser is UserModel.create: every schema default, in schema order.
type newUser struct {
	Name            string
	Email           string
	Image           *string
	EmailVerified   bool
	EmailVerifiedAt *time.Time
	PasswordHash    string
	AuthProvider    string // "" = LOCAL
	GoogleID        string
}

func (s *Service) createUser(ctx context.Context, n newUser) (*userRow, error) {
	now := s.now().Truncate(time.Millisecond)
	id := bson.NewObjectID()
	var image any // default: null
	if n.Image != nil {
		image = *n.Image
	}
	doc := bson.D{{Key: "_id", Value: id}, {Key: "name", Value: strings.TrimSpace(n.Name)}, {Key: "email", Value: normalizeEmail(n.Email)},
		{Key: "image", Value: image}, {Key: "emailVerified", Value: n.EmailVerified}}
	if n.EmailVerifiedAt != nil {
		doc = append(doc, bson.E{Key: "emailVerifiedAt", Value: *n.EmailVerifiedAt})
	}
	if n.PasswordHash != "" {
		doc = append(doc, bson.E{Key: "passwordHash", Value: n.PasswordHash})
	}
	provider := n.AuthProvider
	if provider == "" {
		provider = "LOCAL"
	}
	doc = append(doc, bson.E{Key: "authProvider", Value: provider})
	if n.GoogleID != "" {
		doc = append(doc, bson.E{Key: "googleId", Value: strings.TrimSpace(n.GoogleID)})
	}
	doc = append(doc,
		bson.E{Key: "role", Value: "PUBLIC"}, bson.E{Key: "mustChangePassword", Value: false},
		bson.E{Key: "lockPinSetAt", Value: nil}, bson.E{Key: "lockPinFailures", Value: 0}, bson.E{Key: "tokenVersion", Value: 0},
		bson.E{Key: "hostelIds", Value: bson.A{}}, bson.E{Key: "status", Value: "ACTIVE"},
		bson.E{Key: "isDemoData", Value: false}, bson.E{Key: "isDeleted", Value: false},
		bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := s.db.Collection("users").InsertOne(ctx, doc); err != nil {
		return nil, err
	}
	return s.findUser(ctx, bson.D{{Key: "_id", Value: id}})
}
