package auth

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/modules/hostels"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	platauth "github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
)

// Service holds what the auth flows read and write.
type Service struct {
	db       *mongo.Database
	cfg      *config.Config
	tokens   *platauth.Tokens
	sessions *platauth.Sessions
	email    *email.Sender
	audit    *audit.Log
	google   *googleVerifier
	now      func() time.Time
}

func NewService(db *mongo.Database, cfg *config.Config, tokens *platauth.Tokens, sessions *platauth.Sessions, sender *email.Sender, log *audit.Log) *Service {
	return &Service{db: db, cfg: cfg, tokens: tokens, sessions: sessions, email: sender, audit: log,
		google: newGoogleVerifier(), now: time.Now}
}

// reqCtx is RequestContext.
type reqCtx struct{ IP, UserAgent string }

// Issued is what every sign-in returns.
type Issued struct {
	AccessToken  string
	RefreshToken string // "" on a browser reuse-window refresh
	User         any
}

// releaseStrandedResident: a RESIDENT who lives nowhere becomes PUBLIC again.
func (s *Service) releaseStrandedResident(ctx context.Context, u *userRow) error {
	if u.Role != "RESIDENT" {
		return nil
	}
	live, err := s.exists(ctx, "residents", bson.D{notDeleted(),
		{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "PENDING", "SUSPENDED"}}}}, {Key: "userId", Value: u.ID}})
	if err != nil || live {
		return err
	}
	if _, err := s.db.Collection("users").UpdateOne(ctx, bson.D{{Key: "_id", Value: u.ID}, {Key: "role", Value: "RESIDENT"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "hostelIds", Value: bson.A{}}, {Key: "role", Value: "PUBLIC"}, {Key: "updatedAt", Value: s.now()}}}}); err != nil {
		return err
	}
	u.HostelIDs, u.Role = nil, "PUBLIC"
	return nil
}

// isApprovedServiceProvider: only asked for PUBLIC accounts.
func (s *Service) isApprovedServiceProvider(ctx context.Context, u *userRow) (bool, error) {
	if u.Role != "PUBLIC" {
		return false, nil
	}
	return s.exists(ctx, "serviceproviders", bson.D{{Key: "isDeleted", Value: false}, {Key: "status", Value: "APPROVED"}, {Key: "userId", Value: u.ID}})
}

// cookFingerprintLock: nil (absent) for every role but COOK.
func (s *Service) cookFingerprintLock(ctx context.Context, u *userRow) (*bool, error) {
	if u.Role != "COOK" || len(u.HostelIDs) == 0 {
		return nil, nil
	}
	on, err := s.exists(ctx, "hostelsettings", bson.D{{Key: "cookFingerprintLock", Value: true}, {Key: "hostelId", Value: bson.D{{Key: "$in", Value: u.HostelIDs}}}})
	return &on, err
}

func (s *Service) hostelKyc(ctx context.Context, u *userRow) (*hostels.AccountKyc, error) {
	if u.Role != "HOSTEL_ADMIN" && u.Role != "WARDEN" {
		return nil, nil
	}
	return hostels.KycForAccount(ctx, s.db, u.hostelIDs())
}

func tokenInput(u *userRow, sessionID, tempID string) platauth.TokenInput {
	return platauth.TokenInput{
		UserID: u.ID.Hex(), Role: u.Role, HostelIDs: u.hostelIDs(),
		// A borrowed login never knows the PIN; a public account has no portal to lock.
		LockPin:   u.LockPinSetAt != nil && u.Role != "PUBLIC" && tempID == "",
		SessionID: sessionID, TemporaryCredentialID: tempID,
	}
}

// issueSession is issueSessionForUser.
func (s *Service) issueSession(ctx context.Context, u *userRow, rc reqCtx, tempID string) (*Issued, error) {
	if err := s.releaseStrandedResident(ctx, u); err != nil {
		return nil, err
	}
	// Registered at the desk with this email: the first sign-in opens the resident portal.
	if u.Role == "PUBLIC" && tempID == "" && residents.LinkDeskIntakeOnSignIn(ctx, s.db, s.audit, u.ID, s.now()) {
		if fresh, err := s.findUser(ctx, bson.D{{Key: "_id", Value: u.ID}}); err == nil && fresh != nil {
			u.HostelIDs, u.Role = fresh.HostelIDs, fresh.Role
		}
	}
	var tempOID *bson.ObjectID
	if tempID != "" {
		if oid, err := bson.ObjectIDFromHex(tempID); err == nil {
			tempOID = &oid
		}
	}
	sess := s.sessions.New(u.ID, tempOID, rc.IP, rc.UserAgent)
	in := tokenInput(u, sess.ID.Hex(), tempID)
	access, err := s.tokens.SignAccess(in)
	if err != nil {
		return nil, err
	}
	refresh, err := s.tokens.SignRefresh(in)
	if err != nil {
		return nil, err
	}
	sp, err := s.isApprovedServiceProvider(ctx, u)
	if err != nil {
		return nil, err
	}
	cook, err := s.cookFingerprintLock(ctx, u)
	if err != nil {
		return nil, err
	}
	kyc, err := s.hostelKyc(ctx, u)
	if err != nil {
		return nil, err
	}
	if err := s.sessions.Insert(ctx, sess, refresh); err != nil {
		return nil, err
	}
	if err := s.setUser(ctx, u.ID, bson.E{Key: "lastLoginAt", Value: s.now()}); err != nil {
		return nil, err
	}
	return &Issued{AccessToken: access, RefreshToken: refresh, User: SessionUser{
		PublicUser: publicUser(u), CookFingerprintLock: cook, HostelKyc: kyc,
		IsServiceProvider: sp, ViaTemporaryCredential: tempID != "",
	}}, nil
}

// temporaryCredentialActive is isTemporaryCredentialActive.
func (s *Service) temporaryCredentialActive(ctx context.Context, id string) (bool, error) {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return false, nil
	}
	return s.exists(ctx, "temporarycredentials", bson.D{{Key: "expiresAt", Value: bson.D{{Key: "$gt", Value: s.now()}}}, {Key: "revokedAt", Value: nil}, {Key: "_id", Value: oid}})
}

// Refresh is refreshAccessToken: Sessions does the row state machine; this
// re-authorises the account in between.
func (s *Service) Refresh(ctx context.Context, refreshToken string, cookieSession bool) (*Issued, error) {
	claims, err := s.tokens.VerifyRefresh(refreshToken)
	if err != nil {
		return nil, errInvalidSession
	}
	p, err := s.sessions.Find(ctx, claims.SessionID, refreshToken)
	if err == platauth.ErrInvalidSession {
		return nil, errInvalidSession
	}
	if err != nil {
		return nil, err
	}
	uid, err := bson.ObjectIDFromHex(claims.Subject)
	if err != nil {
		return nil, err // mongoose CastError → 500
	}
	u, err := s.findUser(ctx, bson.D{{Key: "_id", Value: uid}, notDeleted(), {Key: "status", Value: "ACTIVE"}})
	if err != nil {
		return nil, err
	}
	if u == nil {
		return nil, errUserInactive
	}
	tempID := ""
	if p.Session.TemporaryCredentialID != nil {
		tempID = p.Session.TemporaryCredentialID.Hex()
		active, err := s.temporaryCredentialActive(ctx, tempID)
		if err != nil {
			return nil, err
		}
		if !active {
			if err := s.sessions.Revoke(ctx, p.Session.ID); err != nil {
				return nil, err
			}
			return nil, errTempInvalid
		}
	}
	if err := s.releaseStrandedResident(ctx, u); err != nil {
		return nil, err
	}
	in := tokenInput(u, p.Session.ID.Hex(), tempID)
	access, err := s.tokens.SignAccess(in)
	if err != nil {
		return nil, err
	}
	signed, err := s.tokens.SignRefresh(in)
	if err != nil {
		return nil, err
	}
	sp, err := s.isApprovedServiceProvider(ctx, u)
	if err != nil {
		return nil, err
	}
	kyc, err := s.hostelKyc(ctx, u)
	if err != nil {
		return nil, err
	}
	rotated, err := s.sessions.Rotate(ctx, p, signed, cookieSession)
	if err == platauth.ErrInvalidSession {
		return nil, errInvalidSession
	}
	if err != nil {
		return nil, err
	}
	if !rotated {
		signed = ""
	}
	return &Issued{AccessToken: access, RefreshToken: signed, User: RefreshUser{
		PublicUser: publicUser(u), HostelKyc: kyc, IsServiceProvider: sp, ViaTemporaryCredential: tempID != "",
	}}, nil
}

// errBadToken is what verifyAccessToken throws: a plain Error (or jose's),
// which handleRouteError answers as a 500 — /me included.
type errBadToken struct{}

func (errBadToken) Error() string { return "Invalid authentication token." }

// Me is getCurrentUser; the route adds pinLocked.
func (s *Service) Me(ctx context.Context, accessToken string) (*MeUser, *platauth.Claims, error) {
	claims, err := s.tokens.VerifyAccess(accessToken)
	if err != nil {
		return nil, nil, errBadToken{}
	}
	via := claims.TemporaryCredentialID != ""
	if via {
		active, err := s.temporaryCredentialActive(ctx, claims.TemporaryCredentialID)
		if err != nil {
			return nil, nil, err
		}
		if !active {
			return nil, nil, errTempInvalid
		}
	}
	uid, err := bson.ObjectIDFromHex(claims.Subject)
	if err != nil {
		return nil, nil, err
	}
	u, err := s.findUser(ctx, bson.D{{Key: "_id", Value: uid}, notDeleted(), {Key: "status", Value: "ACTIVE"}})
	if err != nil {
		return nil, nil, err
	}
	if u == nil {
		return nil, nil, errUserInactive
	}
	sp, err := s.isApprovedServiceProvider(ctx, u)
	if err != nil {
		return nil, nil, err
	}
	safe := publicUser(u)
	var susp *hostels.AccountSuspension
	switch u.Role {
	case "HOSTEL_ADMIN", "WARDEN", "RESIDENT", "GUARDIAN", "COOK":
		if susp, err = hostels.SuspensionForAccount(ctx, s.db, safe.HostelIDs, s.now()); err != nil {
			return nil, nil, err
		}
	}
	kyc, err := s.hostelKyc(ctx, u)
	if err != nil {
		return nil, nil, err
	}
	cook, err := s.cookFingerprintLock(ctx, u)
	if err != nil {
		return nil, nil, err
	}
	stale := claims.Role != u.Role || !sameIDs(claims.HostelIDs, safe.HostelIDs) || claims.LockPin != (safe.HasLockPin && !via)
	return &MeUser{PublicUser: safe, CookFingerprintLock: cook, HostelKyc: kyc, HostelSuspension: susp,
		IsServiceProvider: sp, SessionStale: stale, ViaTemporaryCredential: via}, claims, nil
}

// sameIDs: set equality, order and duplicates ignored.
func sameIDs(fromToken, fromAccount []string) bool {
	claimed := map[string]bool{}
	for _, id := range fromToken {
		claimed[id] = true
	}
	account := map[string]bool{}
	for _, id := range fromAccount {
		account[id] = true
	}
	if len(claimed) != len(account) {
		return false
	}
	for id := range account {
		if !claimed[id] {
			return false
		}
	}
	return true
}

// Logout revokes the session holding this refresh token.
func (s *Service) Logout(ctx context.Context, refreshToken string) error {
	return s.sessions.Logout(ctx, refreshToken)
}
