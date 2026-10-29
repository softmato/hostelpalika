package auth

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

const googleJWKS = "https://www.googleapis.com/oauth2/v3/certs"

// googleVerifier is jose's createRemoteJWKSet: keys cached, refetched for an
// unknown kid at most every 30 s (jose's cooldown), or after 10 min (its maxAge).
type googleVerifier struct {
	url     string
	http    *http.Client
	mu      sync.Mutex
	keys    map[string]*rsa.PublicKey
	fetched time.Time
}

func newGoogleVerifier() *googleVerifier {
	return &googleVerifier{url: googleJWKS, http: &http.Client{Timeout: 5 * time.Second}}
}

func (g *googleVerifier) key(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if k := g.keys[kid]; k != nil && time.Since(g.fetched) < 10*time.Minute {
		return k, nil
	}
	if time.Since(g.fetched) < 30*time.Second && g.keys != nil {
		if k := g.keys[kid]; k != nil {
			return k, nil
		}
		return nil, errors.New("no matching key")
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, g.url, nil)
	res, err := g.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var set struct {
		Keys []struct {
			Kid, Kty, N, E string
		} `json:"keys"`
	}
	if err := json.NewDecoder(res.Body).Decode(&set); err != nil {
		return nil, err
	}
	keys := map[string]*rsa.PublicKey{}
	for _, k := range set.Keys {
		n, err1 := base64.RawURLEncoding.DecodeString(k.N)
		e, err2 := base64.RawURLEncoding.DecodeString(k.E)
		if k.Kty != "RSA" || err1 != nil || err2 != nil {
			continue
		}
		keys[k.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
	}
	g.keys, g.fetched = keys, time.Now()
	if k := keys[kid]; k != nil {
		return k, nil
	}
	return nil, errors.New("no matching key")
}

type googleAccount struct {
	Email, Name, ProviderAccountID string
	Picture                        *string
}

func (s *Service) verifyGoogleIDToken(ctx context.Context, idToken string) (*googleAccount, error) {
	clientID := s.cfg.Google.ClientID
	if clientID == "" {
		return nil, fail(http.StatusServiceUnavailable, "GOOGLE_AUTH_NOT_CONFIGURED", "Google auth is not configured.")
	}
	invalid := fail(http.StatusUnauthorized, "GOOGLE_TOKEN_INVALID", "Google sign-in token is invalid.")
	claims := jwt.MapClaims{}
	_, err := jwt.ParseWithClaims(idToken, claims, func(t *jwt.Token) (any, error) {
		kid, _ := t.Header["kid"].(string)
		return s.google.key(ctx, kid)
	}, jwt.WithValidMethods([]string{"RS256"}), jwt.WithAudience(clientID), jwt.WithTimeFunc(s.now))
	if err != nil {
		return nil, invalid
	}
	if iss, _ := claims["iss"].(string); iss != "https://accounts.google.com" && iss != "accounts.google.com" {
		return nil, invalid
	}
	sub, _ := claims["sub"].(string)
	mail, _ := claims["email"].(string)
	mail = normalizeEmail(mail)
	if verified, _ := claims["email_verified"].(bool); sub == "" || mail == "" || !verified {
		return nil, fail(http.StatusUnauthorized, "GOOGLE_EMAIL_UNVERIFIED", "Google account email must be verified.")
	}
	acc := &googleAccount{Email: mail, Name: mail, ProviderAccountID: sub}
	if p, _ := claims["picture"].(string); strings.TrimSpace(p) != "" {
		p = strings.TrimSpace(p)
		acc.Picture = &p
	}
	if n, _ := claims["name"].(string); strings.TrimSpace(n) != "" {
		acc.Name = strings.TrimSpace(n)
	}
	return acc, nil
}

// Google is authenticateWithGoogle: the linked account, else the email's
// (ACTIVE or INVITED), else a new PUBLIC account; the link is kept current.
func (s *Service) Google(ctx context.Context, idToken string, rc reqCtx) (*Issued, error) {
	g, err := s.verifyGoogleIDToken(ctx, idToken)
	if err != nil {
		return nil, err
	}
	links := s.db.Collection("oauthaccounts")
	var link struct {
		ID     bson.ObjectID `bson:"_id"`
		UserID bson.ObjectID `bson:"userId"`
	}
	err = links.FindOne(ctx, bson.D{notDeleted(), {Key: "provider", Value: "google"}, {Key: "providerAccountId", Value: g.ProviderAccountID}}).Decode(&link)
	hasLink := err == nil
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	var user *userRow
	if hasLink {
		if user, err = s.findUser(ctx, bson.D{{Key: "_id", Value: link.UserID}, notDeleted()}); err != nil {
			return nil, err
		}
	}
	if user != nil && !claimable(user.Status) {
		return nil, fail(http.StatusUnauthorized, "USER_INACTIVE", "Linked Google account no longer has access.")
	}
	orphaned := hasLink && user == nil
	if user == nil {
		if user, err = s.findUser(ctx, bson.D{{Key: "email", Value: g.Email}, notDeleted(),
			{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "INVITED"}}}}}); err != nil {
			return nil, err
		}
	}
	now := s.now().Truncate(time.Millisecond)
	if user == nil {
		if user, err = s.createUser(ctx, newUser{Name: g.Name, Email: g.Email, Image: g.Picture, EmailVerified: true,
			EmailVerifiedAt: &now, AuthProvider: "GOOGLE", GoogleID: g.ProviderAccountID}); err != nil {
			return nil, err
		}
	} else {
		var set []bson.E
		if g.Picture != nil && (user.Image == nil || *user.Image == "") {
			set = append(set, bson.E{Key: "image", Value: *g.Picture})
			user.Image = g.Picture
		}
		if user.GoogleID == "" {
			set = append(set, bson.E{Key: "googleId", Value: g.ProviderAccountID})
			user.GoogleID = g.ProviderAccountID
		}
		if !user.verified() {
			set = append(set, bson.E{Key: "emailVerified", Value: true}, bson.E{Key: "emailVerifiedAt", Value: now})
			user.EmailVerified, user.EmailVerifiedAt = true, &now
		}
		// The first sign-in activates an admin-issued account, as in login.
		if user.Status == "INVITED" {
			set = append(set, bson.E{Key: "status", Value: "ACTIVE"})
			user.Status = "ACTIVE"
		}
		if len(set) > 0 {
			if err := s.setUser(ctx, user.ID, set...); err != nil {
				return nil, err
			}
		}
	}
	switch {
	case orphaned:
		// Reuse the stale row: {provider, providerAccountId} is unique.
		_, err = links.UpdateOne(ctx, bson.D{{Key: "_id", Value: link.ID}}, bson.D{{Key: "$set", Value: bson.D{
			{Key: "email", Value: g.Email}, {Key: "userId", Value: user.ID}, {Key: "linkedAt", Value: now}, {Key: "updatedAt", Value: now}}}})
	case !hasLink:
		_, err = links.InsertOne(ctx, bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "email", Value: g.Email},
			{Key: "isDeleted", Value: false}, {Key: "provider", Value: "google"}, {Key: "providerAccountId", Value: g.ProviderAccountID},
			{Key: "userId", Value: user.ID}, {Key: "linkedAt", Value: now}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}})
	}
	if err != nil {
		return nil, err
	}
	return s.issueSession(ctx, user, rc, "")
}
