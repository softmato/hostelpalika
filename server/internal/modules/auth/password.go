package auth

import (
	"context"
	"net/http"
	"net/url"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	platauth "github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
)

const (
	verifyEmailTTL   = 24 * time.Hour
	passwordResetTTL = 60 * time.Minute
)

// encodeURIComponent for a JWT: its alphabet (A–Z a–z 0–9 - _ .) is all unreserved.
func linkToken(t string) string { return url.QueryEscape(t) }

func (s *Service) dispatchVerificationEmail(ctx context.Context, u *userRow) error {
	if u.Email == nil || *u.Email == "" {
		return nil
	}
	token, err := s.tokens.SignPurpose(platauth.PurposeInput{UserID: u.ID.Hex(), Purpose: platauth.VerifyEmail, TTL: verifyEmailTTL})
	if err != nil {
		return err
	}
	c := email.Verification(s.cfg.OutboundURL()+"/verify-email?token="+linkToken(token), int(verifyEmailTTL.Hours()))
	s.email.Send(ctx, email.Message{Category: c.Category, To: []string{*u.Email}, Subject: c.Subject, HTML: c.HTML})
	return nil
}

// Signup is signupWithEmailVerification: no session until the email is verified.
type signedUp struct {
	Email  string `json:"email"`
	UserID string `json:"userId"`
}

func (s *Service) Signup(ctx context.Context, addr, name, password string) (*signedUp, error) {
	addr = normalizeEmail(addr)
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
	hash, err := platauth.HashPassword(password)
	if err != nil {
		return nil, err
	}
	u, err := s.createUser(ctx, newUser{Name: name, Email: addr, PasswordHash: hash})
	if err != nil {
		return nil, err
	}
	if err := s.dispatchVerificationEmail(ctx, u); err != nil {
		return nil, err
	}
	return &signedUp{addr, u.ID.Hex()}, nil
}

func (s *Service) purposeUser(token string, p platauth.Purpose, invalid error) (bson.ObjectID, map[string]any, error) {
	claims, err := s.tokens.VerifyPurpose(token, p)
	if err != nil {
		return bson.ObjectID{}, nil, invalid
	}
	sub, _ := claims["sub"].(string)
	id, err := bson.ObjectIDFromHex(sub)
	if err != nil {
		return bson.ObjectID{}, nil, err // mongoose CastError → 500
	}
	return id, claims, nil
}

var errAccountGone = fail(http.StatusUnauthorized, "USER_INACTIVE", "Account no longer exists.")

func (s *Service) VerifyEmail(ctx context.Context, token string) (map[string]any, error) {
	id, _, err := s.purposeUser(token, platauth.VerifyEmail, fail(http.StatusBadRequest, "VERIFICATION_TOKEN_INVALID", "Verification link is invalid or expired."))
	if err != nil {
		return nil, err
	}
	u, err := s.findUser(ctx, bson.D{{Key: "_id", Value: id}, notDeleted()})
	if err != nil {
		return nil, err
	}
	if u == nil {
		return nil, errAccountGone
	}
	if !u.EmailVerified {
		set := []bson.E{{Key: "emailVerified", Value: true}}
		if u.EmailVerifiedAt == nil {
			set = append(set, bson.E{Key: "emailVerifiedAt", Value: s.now()})
		}
		if err := s.setUser(ctx, u.ID, set...); err != nil {
			return nil, err
		}
	}
	return map[string]any{"verified": true}, nil
}

// ResendVerification never says whether the address exists.
func (s *Service) ResendVerification(ctx context.Context, addr string) (map[string]any, error) {
	if addr = normalizeEmail(addr); addr != "" {
		u, err := s.findUser(ctx, bson.D{{Key: "email", Value: addr}, notDeleted()})
		if err != nil {
			return nil, err
		}
		if u != nil && !u.verified() {
			if err := s.dispatchVerificationEmail(ctx, u); err != nil {
				return nil, err
			}
		}
	}
	return map[string]any{"requested": true}, nil
}

// ForgotPassword says plainly when no account uses the address.
func (s *Service) ForgotPassword(ctx context.Context, addr string) (map[string]any, error) {
	var u *userRow
	var err error
	if addr = normalizeEmail(addr); addr != "" {
		if u, err = s.findUser(ctx, bson.D{{Key: "email", Value: addr}, notDeleted()}); err != nil {
			return nil, err
		}
	}
	if u == nil || u.Email == nil || *u.Email == "" {
		return nil, fail(http.StatusNotFound, "ACCOUNT_NOT_FOUND", "No HostelPalika account uses this email.")
	}
	if !claimable(u.Status) {
		return nil, fail(http.StatusForbidden, "USER_INACTIVE", "This account is switched off. Ask your hostel to turn it back on.")
	}
	v := int(u.tokenVersion())
	token, err := s.tokens.SignPurpose(platauth.PurposeInput{UserID: u.ID.Hex(), Purpose: platauth.PasswordReset, TTL: passwordResetTTL, TokenVersion: &v})
	if err != nil {
		return nil, err
	}
	c := email.PasswordReset(s.cfg.OutboundURL()+"/reset-password?token="+linkToken(token), int(passwordResetTTL.Minutes()))
	r := s.email.Send(ctx, email.Message{Category: c.Category, To: []string{*u.Email}, Subject: c.Subject, HTML: c.HTML})
	if !r.Sent && r.Reason == "send_failed" {
		return nil, fail(http.StatusBadGateway, "EMAIL_SEND_FAILED", "We could not send the reset email. Try again in a minute.")
	}
	return map[string]any{"requested": true}, nil
}

// setPassword is the shared tail of reset and change: new hash, flag cleared,
// tokenVersion bumped (old reset links die), every session revoked.
func (s *Service) setPassword(ctx context.Context, u *userRow, password string) error {
	hash, err := platauth.HashPassword(password)
	if err != nil {
		return err
	}
	if err := s.setUser(ctx, u.ID, bson.E{Key: "passwordHash", Value: hash}, bson.E{Key: "mustChangePassword", Value: false},
		bson.E{Key: "tokenVersion", Value: u.tokenVersion() + 1}); err != nil {
		return err
	}
	u.MustChangePassword = false
	return s.sessions.RevokeAll(ctx, u.ID)
}

func (s *Service) ResetPassword(ctx context.Context, token, password string) (map[string]any, error) {
	id, claims, err := s.purposeUser(token, platauth.PasswordReset, fail(http.StatusBadRequest, "RESET_TOKEN_INVALID", "Reset link is invalid or expired."))
	if err != nil {
		return nil, err
	}
	u, err := s.findUser(ctx, bson.D{{Key: "_id", Value: id}, notDeleted()})
	if err != nil {
		return nil, err
	}
	if u == nil {
		return nil, errAccountGone
	}
	tv, _ := claims["tokenVersion"].(float64)
	if float64(u.tokenVersion()) != tv {
		return nil, fail(http.StatusBadRequest, "RESET_TOKEN_STALE", "Reset link is no longer valid.")
	}
	if err := s.setPassword(ctx, u, password); err != nil {
		return nil, err
	}
	return map[string]any{"reset": true}, nil
}

// ChangePassword: the current password unless the account must change it;
// every session revoked, a fresh one issued so the caller stays signed in.
func (s *Service) ChangePassword(ctx context.Context, userID string, current *string, password string, rc reqCtx) (*Issued, error) {
	id, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return nil, err
	}
	u, err := s.findUser(ctx, bson.D{{Key: "_id", Value: id}, notDeleted(), {Key: "status", Value: "ACTIVE"}})
	if err != nil {
		return nil, err
	}
	if u == nil {
		return nil, errUserInactive
	}
	if !u.MustChangePassword {
		if current == nil {
			return nil, fail(http.StatusBadRequest, "CURRENT_PASSWORD_REQUIRED", "Current password is required.")
		}
		if u.PasswordHash == "" || !platauth.VerifyPassword(*current, u.PasswordHash) {
			return nil, fail(http.StatusUnauthorized, "INVALID_CREDENTIALS", "Current password is incorrect.")
		}
	}
	if err := s.setPassword(ctx, u, password); err != nil {
		return nil, err
	}
	return s.issueSession(ctx, u, rc, "")
}
