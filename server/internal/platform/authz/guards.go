package authz

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/background"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/obs"
)

// Principal is ApiPrincipal.
type Principal struct {
	UserID    string
	Role      Role
	HostelIDs []string
	// Every live hostel a staff member may open, before HostelIDs was narrowed
	// to the active one. Only the branch switcher and summary read it.
	AllHostelIDs []string
	SessionID    string
	// A browser session of a PIN-locked account that has not typed it yet.
	PinLocked bool
	// Hostels taken out because their suspension landed, so a guard can say
	// "suspended" rather than serve an empty-hostel 404.
	SuspendedHostelIDs    []string
	TemporaryCredentialID string
}

// ActiveHostelHeader names the branch a staff request is about (id or slug).
const ActiveHostelHeader = "x-hostel-id"

func authErr(status int, code, msg string) *httpx.Error {
	return httpx.NewError(status, code, msg, nil)
}

var (
	errAuthRequired  = authErr(http.StatusUnauthorized, "UNAUTHENTICATED", "Authentication is required.")
	errExpired       = authErr(http.StatusUnauthorized, "UNAUTHENTICATED", "Your session has expired.")
	errPinRequired   = authErr(http.StatusLocked, "LOCK_PIN_REQUIRED", "Enter your PIN to continue.")
	errForbidden     = authErr(http.StatusForbidden, "FORBIDDEN", "This role is not allowed to perform this action.")
	errSuspended     = authErr(http.StatusLocked, "HOSTEL_SUSPENDED", HostelSuspendedMessage)
	errKycRequired   = authErr(http.StatusLocked, "KYC_REQUIRED", KycRequiredMessage)
	errTrialEnded    = authErr(http.StatusLocked, "TRIAL_ENDED_KYC", TrialEndedKycMessage)
	errNotFound      = authErr(http.StatusNotFound, "NOT_FOUND", "Not found.")
	errCapability    = authErr(http.StatusForbidden, "CAPABILITY_DENIED", "Your warden account does not have permission for this action.")
	errTempForbidden = authErr(http.StatusForbidden, "TEMPORARY_CREDENTIAL_FORBIDDEN", "Sign in with your own password to manage account access.")
)

// What a PIN-locked browser may still call: the unlock, its reset, signing out.
var openWhilePinLocked = []string{"/api/v1/auth/lock-pin", "/api/v1/auth/biometric/", "/api/v1/auth/logout"}

// Guards holds what every guard reads.
type Guards struct {
	Tokens     *auth.Tokens
	Cookies    *auth.Cookies
	DB         *mongo.Database
	Cache      *cache.Cache       // nil = nothing to bump
	Background *background.Runner // nil only with a nil Cache
	now        func() time.Time
}

func New(tokens *auth.Tokens, cookies *auth.Cookies, db *mongo.Database, c *cache.Cache, bg *background.Runner) *Guards {
	return &Guards{tokens, cookies, db, c, bg, time.Now}
}

// Load is loadApiPrincipal: nil when signed out. A bearer token that no
// longer verifies is a 401 (so the app refreshes), not a signed-out reader.
func (g *Guards) Load(c *gin.Context) (*Principal, error) {
	bearer := auth.BearerToken(c.GetHeader("Authorization"))
	token := bearer
	if token == "" {
		token = auth.AccessCookieValue(c.Request)
	}
	if token == "" {
		return nil, nil
	}
	p, err := g.load(c, token, bearer != "")
	if err != nil {
		// TS catches every failure inside its try, a DB error included.
		if bearer != "" {
			return nil, errExpired
		}
		return nil, nil
	}
	return p, nil
}

func (g *Guards) load(c *gin.Context, token string, isBearer bool) (*Principal, error) {
	claims, err := g.Tokens.VerifyAccess(token)
	if err != nil {
		return nil, err
	}
	if claims.Subject == "" || !IsRole(claims.Role) {
		return nil, auth.ErrInvalidToken
	}
	// Revocation bites now, not at the next refresh.
	if id := claims.TemporaryCredentialID; id != "" {
		ok, err := g.temporaryCredentialActive(c, id)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, auth.ErrInvalidToken
		}
	}
	p := &Principal{
		UserID: claims.Subject, Role: Role(claims.Role), HostelIDs: claims.HostelIDs,
		SessionID: claims.SessionID, TemporaryCredentialID: claims.TemporaryCredentialID,
	}
	if p.HostelIDs == nil {
		p.HostelIDs = []string{}
	}
	// The app (bearer) draws its own lock; only a browser session is held here.
	if !isBearer && claims.LockPin {
		p.PinLocked = !g.Cookies.PinUnlocked(c.Request, p.UserID, p.SessionID)
	}
	return p, nil
}

func (g *Guards) temporaryCredentialActive(ctx context.Context, id string) (bool, error) {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return false, nil
	}
	err = g.DB.Collection("temporarycredentials").FindOne(ctx,
		bson.D{{Key: "expiresAt", Value: bson.D{{Key: "$gt", Value: g.now()}}}, {Key: "revokedAt", Value: nil}, {Key: "_id", Value: oid}},
		options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Err()
	if err == mongo.ErrNoDocuments {
		return false, nil
	}
	return err == nil, err
}

// Require is requireApiPrincipal.
func (g *Guards) Require(c *gin.Context) (*Principal, error) {
	p, err := g.Load(c)
	if err != nil {
		return nil, err
	}
	if p == nil {
		return nil, errAuthRequired
	}
	path := c.Request.URL.Path
	if p.PinLocked && !slices.ContainsFunc(openWhilePinLocked, func(s string) bool { return strings.HasPrefix(path, s) }) {
		return nil, errPinRequired
	}
	q, err := g.narrowToLiveHostels(c, p)
	if err != nil {
		return nil, err
	}
	g.announceWrite(c, q.HostelIDs)
	return q, nil
}

// announceWrite's cache half: every signed-in write to hostel data skips that
// hostel's cached reads — now, and again after the response, so a read landing
// mid-write can't cache the old answer under the new version. Its realtime
// topics half (topicsForWrite → publishResourceChange) arrives with Realtime.
func (g *Guards) announceWrite(c *gin.Context, hostelIDs []string) {
	if g.Cache == nil || len(hostelIDs) == 0 || isRead(c.Request.Method) {
		return
	}
	ids := slices.Clone(hostelIDs)
	g.Cache.Bump(c, ids...)
	g.Background.After(c, func(ctx context.Context) error { g.Cache.Bump(ctx, ids...); return nil })
}

type hostelGateRow struct {
	ID             bson.ObjectID  `bson:"_id"`
	Kyc            *Kyc           `bson:"kyc"`
	ParentHostelID *bson.ObjectID `bson:"parentHostelId"`
	Slug           string         `bson:"slug"`
	Suspension     *Suspension    `bson:"suspension"`
}

// narrowToLiveHostels takes out hostels whose suspension has landed and, for
// staff, hostels deleted since the token was issued; then picks the active
// branch and applies the KYC gates. Token order is kept.
func (g *Guards) narrowToLiveHostels(c *gin.Context, p *Principal) (*Principal, error) {
	path := c.Request.URL.Path
	isStaff := slices.Contains(HostelStaffRoles, p.Role)
	suspensionApplies := !IsOpenWhileSuspended(path)
	if !slices.Contains(SuspendableRoles, p.Role) || len(p.HostelIDs) == 0 || (!isStaff && !suspensionApplies) {
		return p, nil
	}

	var valid []bson.ObjectID
	for _, id := range p.HostelIDs {
		// ponytail: hex only; mongoose's isValid also takes any 12-char string,
		// which no token carries.
		if oid, err := bson.ObjectIDFromHex(id); err == nil {
			valid = append(valid, oid)
		}
	}
	if len(valid) == 0 {
		if isStaff {
			q := *p
			q.HostelIDs = []string{}
			return &q, nil
		}
		return p, nil
	}

	filter := bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: valid}}}}
	if isStaff {
		filter = append(filter, bson.E{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}})
	}
	cur, err := g.DB.Collection("hostels").Find(c, filter, options.Find().SetProjection(
		bson.D{{Key: "_id", Value: 1}, {Key: "kyc", Value: 1}, {Key: "parentHostelId", Value: 1}, {Key: "slug", Value: 1}, {Key: "suspension", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []hostelGateRow
	if err := cur.All(c, &rows); err != nil {
		return nil, err
	}

	now := g.now()
	live := map[string]bool{}
	var suspended []string
	for _, r := range rows {
		live[r.ID.Hex()] = true
		if suspensionApplies && r.Suspension.Stage(now) == "SUSPENDED" {
			suspended = append(suspended, r.ID.Hex())
		}
	}
	open := []string{}
	for _, id := range p.HostelIDs {
		if (!isStaff || live[id]) && !slices.Contains(suspended, id) {
			open = append(open, id)
		}
	}
	hostelIDs := open
	if isStaff {
		hostelIDs = activeHostel(c.GetHeader(ActiveHostelHeader), open, rows)
		gate := func(f func(*hostelGateRow) bool) bool {
			return slices.ContainsFunc(rows, func(r hostelGateRow) bool { return slices.Contains(hostelIDs, r.ID.Hex()) && f(&r) })
		}
		if IsKycFrozenRequest(c.Request.Method, path) && gate(func(r *hostelGateRow) bool { return r.Kyc.Locked() }) {
			return nil, errKycRequired
		}
		if IsBlockedAfterTrial(c.Request.Method, path) && gate(func(r *hostelGateRow) bool { return r.Kyc.TrialOverWithoutKyc(now) }) {
			return nil, errTrialEnded
		}
	}

	q := *p
	if isStaff {
		q.AllHostelIDs = open
	}
	q.HostelIDs = hostelIDs
	if len(suspended) > 0 {
		q.SuspendedHostelIDs = suspended
	}
	return &q, nil
}

// activeHostel: staff with several hostels work in one at a time — the header's
// (by id or slug, only if held), else the main hostel (found by kind, not token
// order), else the first.
func activeHostel(header string, ids []string, rows []hostelGateRow) []string {
	if len(ids) <= 1 {
		return ids
	}
	requested := strings.TrimSpace(header)
	var bySlug string
	if requested != "" {
		for _, r := range rows {
			if r.Slug == requested {
				bySlug = r.ID.Hex()
				break
			}
		}
	}
	for _, id := range []string{requested, bySlug} {
		if id != "" && slices.Contains(ids, id) {
			return []string{id}
		}
	}
	for _, id := range ids {
		if slices.ContainsFunc(rows, func(r hostelGateRow) bool { return r.ID.Hex() == id && r.ParentHostelID == nil }) {
			return []string{id}
		}
	}
	return ids[:1]
}

func assertNotSuspended(p *Principal) error {
	if len(p.HostelIDs) == 0 && len(p.SuspendedHostelIDs) > 0 {
		return errSuspended
	}
	return nil
}

// AssertRoles is assertApiRoles.
func AssertRoles(p *Principal, roles ...Role) error {
	if !slices.Contains(roles, p.Role) {
		return errForbidden
	}
	return nil
}

// AssertPrimaryCredential refuses a borrowed (temporary) login.
func AssertPrimaryCredential(p *Principal) error {
	if p.TemporaryCredentialID != "" {
		return errTempForbidden
	}
	return nil
}

// CanAccessHostel is canAccessHostel: superadmin sees every hostel.
func CanAccessHostel(p *Principal, hostelID string) bool {
	return p.Role == Superadmin || slices.Contains(p.HostelIDs, hostelID)
}

// AssertHostelScoped is assertHostelScopedApiAccess: a cross-tenant miss is
// 404, never 403 — a 403 confirms the hostel exists.
func AssertHostelScoped(p *Principal, hostelID string) error {
	if !CanAccessHostel(p, hostelID) {
		return errNotFound
	}
	return nil
}

// HostelScopedFilter is hostelScopedFilter. Ids stay strings, as TS hands them
// to mongoose; callers casting to ObjectId do so at the query.
func HostelScopedFilter(p *Principal, requestedHostelID string) (bson.D, error) {
	if requestedHostelID != "" {
		if err := AssertHostelScoped(p, requestedHostelID); err != nil {
			return nil, err
		}
		return bson.D{{Key: "hostelId", Value: requestedHostelID}}, nil
	}
	if p.Role == Superadmin {
		return bson.D{}, nil
	}
	return bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: p.HostelIDs}}}}, nil
}

func (g *Guards) requireRoles(c *gin.Context, suspendCheck bool, roles ...Role) (*Principal, error) {
	p, err := g.Require(c)
	if err != nil {
		return nil, err
	}
	if err := AssertRoles(p, roles...); err != nil {
		return nil, err
	}
	if suspendCheck {
		if err := assertNotSuspended(p); err != nil {
			return nil, err
		}
	}
	return p, nil
}

// RequirePlatform: SUPERADMIN and the acting-superadmin moderator.
func (g *Guards) RequirePlatform(c *gin.Context) (*Principal, error) {
	return g.requireRoles(c, false, PlatformRoles...)
}

// RequireSuperadmin: privilege management, so a moderator cannot escalate.
func (g *Guards) RequireSuperadmin(c *gin.Context) (*Principal, error) {
	return g.requireRoles(c, false, Superadmin)
}

func (g *Guards) RequireTeam(c *gin.Context) (*Principal, error) {
	return g.requireRoles(c, false, TeamRoles...)
}

func (g *Guards) RequireHostelStaff(c *gin.Context) (*Principal, error) {
	return g.requireRoles(c, true, HostelStaffRoles...)
}

func (g *Guards) RequireHostelAdmin(c *gin.Context) (*Principal, error) {
	return g.requireRoles(c, true, HostelAdmin)
}

func (g *Guards) RequireResident(c *gin.Context) (*Principal, error) {
	return g.requireRoles(c, true, Resident)
}

func (g *Guards) RequireGuardian(c *gin.Context) (*Principal, error) {
	return g.requireRoles(c, true, Guardian)
}

func (g *Guards) RequireHostelScoped(c *gin.Context, hostelID string) (*Principal, error) {
	p, err := g.requireRoles(c, true, Superadmin, HostelAdmin, Warden)
	if err != nil {
		return nil, err
	}
	if err := AssertHostelScoped(p, hostelID); err != nil {
		return nil, err
	}
	return p, nil
}

// RequireHostelCapability: an admin holds every capability; a warden's
// HostelIDs narrow to the hostels granting it (read per request, so a revoke
// is immediate). No grant anywhere → 403.
func (g *Guards) RequireHostelCapability(c *gin.Context, cap Capability) (*Principal, error) {
	p, err := g.RequireHostelStaff(c)
	if err != nil || p.Role != Warden {
		return p, err
	}
	uid, err := bson.ObjectIDFromHex(p.UserID)
	if err != nil {
		return nil, err // mongoose's CastError: a 500 in TS too
	}
	ids := []bson.ObjectID{} // never nil: $in null is a Mongo error
	for _, id := range p.HostelIDs {
		if oid, err := bson.ObjectIDFromHex(id); err == nil {
			ids = append(ids, oid)
		}
	}
	cur, err := g.DB.Collection("hostelmembers").Find(c, bson.D{
		{Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}},
		{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
		{Key: "permissions", Value: bson.D{{Key: "$in", Value: grantingKeys(cap)}}},
		{Key: "status", Value: "ACTIVE"},
		{Key: "userId", Value: uid},
	}, options.Find().SetProjection(bson.D{{Key: "hostelId", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		HostelID bson.ObjectID `bson:"hostelId"`
	}
	if err := cur.All(c, &rows); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, errCapability
	}
	q := *p
	q.HostelIDs = make([]string, len(rows))
	for i, r := range rows {
		q.HostelIDs[i] = r.HostelID.Hex()
	}
	return &q, nil
}

const principalKey = "authz.principal"

// Use turns a guard into Gin middleware: refused → the TS envelope, passed →
// the principal for the handler (From).
func Use(guard func(*gin.Context) (*Principal, error)) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, err := guard(c)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		c.Set(principalKey, p)
		c.Set(obs.PrincipalIDKey, p.UserID)
		c.Next()
	}
}

// From is the principal a guard middleware stored.
func From(c *gin.Context) *Principal {
	p, _ := c.Get(principalKey)
	return p.(*Principal)
}
