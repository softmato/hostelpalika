// Package auth ports apps/web/src/lib/auth.ts and the session half of
// modules/auth/auth.service.ts: HS256 access/refresh tokens with the same
// secrets and claims, purpose tokens for email links, and refresh rotation on
// the same Session rows, so a token minted by either server works on the other.
package auth

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type TokenType string

const (
	Access  TokenType = "access"
	Refresh TokenType = "refresh"
)

// Claims are AuthTokenPayload. Field order is jose's: payload keys as
// signAccessToken lists them, then sub, iat, exp.
type Claims struct {
	Role      string   `json:"role"`
	HostelIDs []string `json:"hostelIds"`
	// The account has an app-lock PIN; cookie sessions also need the unlock cookie.
	LockPin   bool   `json:"lockPin,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
	// Present only on a session opened with a temporary credential; its presence is the flag.
	TemporaryCredentialID string           `json:"temporaryCredentialId,omitempty"`
	TokenType             TokenType        `json:"tokenType"`
	Subject               string           `json:"sub"`
	IssuedAt              *jwt.NumericDate `json:"iat"`
	ExpiresAt             *jwt.NumericDate `json:"exp"`
}

// jwt.Claims, spelled out instead of embedding RegisteredClaims, whose field
// order (sub, exp, iat) would differ from jose's bytes.
func (c Claims) GetExpirationTime() (*jwt.NumericDate, error) { return c.ExpiresAt, nil }
func (c Claims) GetIssuedAt() (*jwt.NumericDate, error)       { return c.IssuedAt, nil }
func (c Claims) GetNotBefore() (*jwt.NumericDate, error)      { return nil, nil }
func (c Claims) GetIssuer() (string, error)                   { return "", nil }
func (c Claims) GetSubject() (string, error)                  { return c.Subject, nil }
func (c Claims) GetAudience() (jwt.ClaimStrings, error)       { return nil, nil }

// TokenInput is what a session signs; UserID becomes sub.
type TokenInput struct {
	UserID                string
	Role                  string
	HostelIDs             []string
	LockPin               bool
	SessionID             string
	TemporaryCredentialID string
}

// Tokens signs and verifies with the shared secrets (config.Auth).
type Tokens struct {
	AccessSecret, RefreshSecret []byte
	AccessTTL, RefreshTTL       time.Duration
	now                         func() time.Time // tests only
}

func NewTokens(accessSecret, refreshSecret string, accessTTL, refreshTTL time.Duration) *Tokens {
	return &Tokens{[]byte(accessSecret), []byte(refreshSecret), accessTTL, refreshTTL, time.Now}
}

// ErrInvalidToken covers every verify failure; callers map it to their own
// refusal (TS: "Invalid authentication token." / jose errors → INVALID_SESSION).
var ErrInvalidToken = errors.New("invalid authentication token")

func (t *Tokens) SignAccess(in TokenInput) (string, error) {
	return t.sign(in, Access, t.AccessSecret, t.AccessTTL)
}

// SignRefresh never carries lockPin, as in TS.
func (t *Tokens) SignRefresh(in TokenInput) (string, error) {
	in.LockPin = false
	return t.sign(in, Refresh, t.RefreshSecret, t.RefreshTTL)
}

func (t *Tokens) sign(in TokenInput, typ TokenType, secret []byte, ttl time.Duration) (string, error) {
	hostels := in.HostelIDs
	if hostels == nil {
		hostels = []string{} // `input.hostelIds ?? []`
	}
	iat := t.now().Truncate(time.Second)
	c := Claims{
		Role: in.Role, HostelIDs: hostels, LockPin: in.LockPin, SessionID: in.SessionID,
		TemporaryCredentialID: in.TemporaryCredentialID, TokenType: typ, Subject: in.UserID,
		IssuedAt: jwt.NewNumericDate(iat), ExpiresAt: jwt.NewNumericDate(iat.Add(ttl.Truncate(time.Second))),
	}
	return signed(c, secret)
}

func (t *Tokens) VerifyAccess(token string) (*Claims, error) {
	return t.verify(token, Access, t.AccessSecret)
}

func (t *Tokens) VerifyRefresh(token string) (*Claims, error) {
	return t.verify(token, Refresh, t.RefreshSecret)
}

func (t *Tokens) verify(token string, typ TokenType, secret []byte) (*Claims, error) {
	var c Claims
	if err := t.parse(token, &c, secret); err != nil {
		return nil, err
	}
	if c.TokenType != typ || c.Subject == "" || c.Role == "" {
		return nil, ErrInvalidToken
	}
	return &c, nil
}

// Purpose is PurposeTokenPurpose: single-use email/app links, signed with the
// access secret under a distinct tokenType so they never pass as a session.
type Purpose string

const (
	CancelAccountDeletion Purpose = "cancel-account-deletion"
	LockPinUnlock         Purpose = "lock-pin-unlock"
	NightStatusAnswer     Purpose = "night-status-answer"
	PasswordReset         Purpose = "password-reset"
	VerifyEmail           Purpose = "verify-email"
)

// PurposeInput mirrors signPurposeToken's input. TokenVersion nil = absent.
type PurposeInput struct {
	UserID       string
	Purpose      Purpose
	TTL          time.Duration
	TokenVersion *int
	Claims       map[string]string // narrow what the token is good for
}

// SignPurpose: extra claims first, then tokenType and tokenVersion override
// them, as the TS spread order does.
// ponytail: a map, so key order inside the payload differs from jose's; no
// reader depends on claim order.
func (t *Tokens) SignPurpose(in PurposeInput) (string, error) {
	iat := t.now().Truncate(time.Second)
	m := jwt.MapClaims{}
	for k, v := range in.Claims {
		m[k] = v
	}
	m["tokenType"] = string(in.Purpose)
	if in.TokenVersion != nil {
		m["tokenVersion"] = *in.TokenVersion
	}
	m["sub"] = in.UserID
	m["iat"] = iat.Unix()
	m["exp"] = iat.Add(in.TTL.Truncate(time.Second)).Unix()
	return signed(m, t.AccessSecret)
}

// VerifyPurpose returns the whole payload (claims are route-specific).
func (t *Tokens) VerifyPurpose(token string, p Purpose) (jwt.MapClaims, error) {
	m := jwt.MapClaims{}
	if err := t.parse(token, m, t.AccessSecret); err != nil {
		return nil, err
	}
	if typ, _ := m["tokenType"].(string); typ != string(p) {
		return nil, ErrInvalidToken
	}
	if sub, _ := m["sub"].(string); sub == "" {
		return nil, ErrInvalidToken
	}
	return m, nil
}

// signed writes jose's header exactly: {"alg":"HS256"}, no typ.
func signed(c jwt.Claims, secret []byte) (string, error) {
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, c)
	delete(tok.Header, "typ")
	return tok.SignedString(secret)
}

// parse checks signature and exp/nbf like jose's jwtVerify (no leeway, iat unchecked).
// ponytail: HS256 only; jose would also take HS384/512 with this secret, but
// neither server mints them.
func (t *Tokens) parse(token string, c jwt.Claims, secret []byte) error {
	_, err := jwt.ParseWithClaims(token, c, func(*jwt.Token) (any, error) { return secret, nil },
		jwt.WithValidMethods([]string{"HS256"}), jwt.WithTimeFunc(t.now))
	if err != nil {
		return ErrInvalidToken
	}
	return nil
}

// HashToken is the sha256 hex stored in Session.refreshTokenHash.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// BearerToken is getBearerToken: "" when the header isn't "Bearer …".
func BearerToken(header string) string {
	rest, ok := strings.CutPrefix(header, "Bearer ")
	if !ok {
		return ""
	}
	return strings.TrimSpace(rest)
}
