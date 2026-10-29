package authz

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	goredis "github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/background"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
)

func TestHostelGates(t *testing.T) {
	cases := []struct {
		method, path   string
		frozen, closed bool
	}{
		{"POST", "/api/v1/hostel-admin/residents", true, true},
		{"GET", "/api/v1/hostel-admin/residents", false, false},
		{"PATCH", "/api/v1/hostel-admin/finance/payment-profile", false, false},
		{"POST", "/api/v1/hostel-admin/finance/x", true, true},
		{"POST", "/api/v1/hostel-admin/residentsx", false, true},
		{"POST", "/api/v1/users/resident-identity/1", true, false},
		{"POST", "/api/v1/hostel-admin/kyc/submit", false, false},
		{"POST", "/api/v1/hostel-admin", false, true},
	}
	for _, tc := range cases {
		if IsKycFrozenRequest(tc.method, tc.path) != tc.frozen || IsBlockedAfterTrial(tc.method, tc.path) != tc.closed {
			t.Errorf("%s %s", tc.method, tc.path)
		}
	}
	if !IsOpenWhileSuspended("/api/v1/files") || !IsOpenWhileSuspended("/api/v1/hostel-admin/billing/x") || IsOpenWhileSuspended("/api/v1/filesx") {
		t.Error("open while suspended")
	}
	now := time.Now()
	past, future := now.Add(-time.Hour), now.Add(time.Hour)
	for want, s := range map[string]*Suspension{
		"":               nil,
		"PRE_SUSPENSION": {StartedAt: &past, GraceEndsAt: &future},
		"SUSPENDED":      {StartedAt: &past, GraceEndsAt: &past},
	} {
		if got := s.Stage(now); got != want {
			t.Errorf("stage %q, want %q", got, want)
		}
	}
	if (&Suspension{StartedAt: &future, GraceEndsAt: &future}).Stage(now) != "" {
		t.Error("a future start is nothing yet")
	}
	approved := "APPROVED"
	if (&Kyc{Required: true, Status: &approved}).Locked() || !(&Kyc{Required: true}).Locked() || (*Kyc)(nil).Locked() {
		t.Error("kyc lock")
	}
	if slices.Equal(grantingKeys("reversePayments"), []string{"reversePayments", "verifyPayments"}) ||
		!slices.Equal(grantingKeys("recordCash"), []string{"recordCash", "verifyPayments"}) {
		t.Error("verifyPayments alias")
	}
}

// Against the local compose Mongo in a throwaway db; skipped when it is down.
func TestGuards(t *testing.T) {
	ctx := context.Background()
	client, db, err := appmongo.Connect(ctx, "mongodb://127.0.0.1:27018/hostelpalika_authztest?directConnection=true")
	if err != nil {
		t.Skip("local Mongo not running:", err)
	}
	defer func() { _ = db.Drop(ctx); _ = client.Disconnect(ctx) }()
	gin.SetMode(gin.ReleaseMode)

	tokens := auth.NewTokens("test-access-secret", "test-refresh-secret", time.Hour, time.Hour)
	g := New(tokens, &auth.Cookies{Tokens: tokens}, db, nil, nil)
	now := time.Now()
	past, future := now.Add(-time.Hour), now.Add(time.Hour)

	id := func() bson.ObjectID { return bson.NewObjectID() }
	main, branch, suspended, deleted, kycLocked, trialOver := id(), id(), id(), id(), id(), id()
	draft := "DRAFT"
	_, err = db.Collection("hostels").InsertMany(ctx, []any{
		bson.M{"_id": main, "slug": "main", "parentHostelId": nil},
		bson.M{"_id": branch, "slug": "branch", "parentHostelId": main},
		bson.M{"_id": suspended, "slug": "s", "suspension": bson.M{"startedAt": past, "graceEndsAt": past}},
		bson.M{"_id": deleted, "slug": "d", "isDeleted": true},
		bson.M{"_id": kycLocked, "slug": "k", "kyc": bson.M{"required": true, "status": draft, "trialEndsAt": future}},
		bson.M{"_id": trialOver, "slug": "t", "kyc": bson.M{"required": true, "status": draft, "trialEndsAt": past}},
	})
	if err != nil {
		t.Fatal(err)
	}
	warden := id()
	_, _ = db.Collection("hostelmembers").InsertMany(ctx, []any{
		bson.M{"hostelId": main, "userId": warden, "status": "ACTIVE", "permissions": []string{"verifyPayments"}},
		bson.M{"hostelId": branch, "userId": warden, "status": "ACTIVE", "permissions": []string{"manageFood"}},
	})
	revoked, active := id(), id()
	_, _ = db.Collection("temporarycredentials").InsertMany(ctx, []any{
		bson.M{"_id": revoked, "expiresAt": future, "revokedAt": past},
		bson.M{"_id": active, "expiresAt": future, "revokedAt": nil},
	})

	type call struct {
		method, path string
		bearer       string
		cookie       string
		header       string
	}
	run := func(cl call, guard func(*gin.Context) (*Principal, error)) (*Principal, error) {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		if cl.method == "" {
			cl.method = "GET"
		}
		if cl.path == "" {
			cl.path = "/api/v1/x"
		}
		c.Request = httptest.NewRequest(cl.method, cl.path, nil)
		if cl.bearer != "" {
			c.Request.Header.Set("Authorization", "Bearer "+cl.bearer)
		}
		if cl.cookie != "" {
			c.Request.Header.Set("Cookie", cl.cookie)
		}
		if cl.header != "" {
			c.Request.Header.Set(ActiveHostelHeader, cl.header)
		}
		return guard(c)
	}
	tok := func(role Role, lockPin bool, tempID string, hostels ...bson.ObjectID) string {
		ids := make([]string, len(hostels))
		for i, h := range hostels {
			ids[i] = h.Hex()
		}
		uid := id().Hex()
		if role == Warden {
			uid = warden.Hex()
		}
		s, err := tokens.SignAccess(auth.TokenInput{UserID: uid, Role: string(role), HostelIDs: ids, LockPin: lockPin, SessionID: "s1", TemporaryCredentialID: tempID})
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	code := func(err error) string {
		var e *httpx.Error
		if errors.As(err, &e) {
			return e.ErrorCode
		}
		if err != nil {
			return err.Error()
		}
		return ""
	}
	expect := func(name string, cl call, guard func(*gin.Context) (*Principal, error), wantCode string, wantHostels ...bson.ObjectID) {
		t.Helper()
		p, err := run(cl, guard)
		if code(err) != wantCode {
			t.Errorf("%s: err %v, want %s", name, err, wantCode)
			return
		}
		if err == nil && wantHostels != nil {
			want := make([]string, len(wantHostels))
			for i, h := range wantHostels {
				want[i] = h.Hex()
			}
			if !slices.Equal(p.HostelIDs, want) {
				t.Errorf("%s: hostels %v, want %v", name, p.HostelIDs, want)
			}
		}
	}

	expect("signed out", call{}, g.Require, "UNAUTHENTICATED")
	if p, err := run(call{cookie: auth.AccessCookie + "=garbage"}, g.Load); p != nil || err != nil {
		t.Error("a bad cookie is a signed-out reader")
	}
	expired, _ := auth.NewTokens("test-access-secret", "x", -time.Minute, time.Hour).SignAccess(auth.TokenInput{UserID: "u", Role: "RESIDENT"})
	if _, err := run(call{bearer: expired}, g.Load); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Errorf("expired bearer: %v", err)
	}
	expect("legacy cookie", call{cookie: "hostelhub_access_token=" + tok(Resident, false, "", main)}, g.RequireResident, "", main)
	expect("role", call{bearer: tok(Resident, false, "", main)}, g.RequireHostelStaff, "FORBIDDEN")
	expect("moderator platform", call{bearer: tok(PlatformModerator, false, "")}, g.RequirePlatform, "")
	expect("moderator superadmin", call{bearer: tok(PlatformModerator, false, "")}, g.RequireSuperadmin, "FORBIDDEN")
	expect("moderator team", call{bearer: tok(PlatformModerator, false, "")}, g.RequireTeam, "FORBIDDEN")

	// Temporary credentials: revoked = signed out at once.
	expect("revoked temp", call{bearer: tok(Resident, false, revoked.Hex(), main)}, g.Require, "UNAUTHENTICATED")
	p, _ := run(call{bearer: tok(Resident, false, active.Hex(), main)}, g.Require)
	if p == nil || AssertPrimaryCredential(p) == nil {
		t.Error("active temp credential passes the guard but not the primary-credential check")
	}

	// PIN: cookies only; bearer ignores it; the lock-pin routes stay open.
	locked := tok(Resident, true, "", main)
	expect("pin cookie", call{cookie: auth.AccessCookie + "=" + locked}, g.Require, "LOCK_PIN_REQUIRED")
	expect("pin bearer", call{bearer: locked}, g.Require, "")
	expect("pin open path", call{cookie: auth.AccessCookie + "=" + locked, path: "/api/v1/auth/lock-pin/verify"}, g.Require, "")
	claims, _ := tokens.VerifyAccess(locked)
	h := http.Header{}
	_ = g.Cookies.ApplyPinUnlock(h, claims.Subject, "s1")
	unlock := strings.SplitN(h.Get("Set-Cookie"), ";", 2)[0]
	expect("pin unlocked", call{cookie: auth.AccessCookie + "=" + locked + "; " + unlock}, g.Require, "")

	// Suspension: taken out; all suspended = 423; billing stays open.
	expect("resident suspended", call{bearer: tok(Resident, false, "", suspended)}, g.RequireResident, "HOSTEL_SUSPENDED")
	expect("billing open", call{bearer: tok(HostelAdmin, false, "", suspended), path: "/api/v1/hostel-admin/billing"}, g.RequireHostelAdmin, "", suspended)
	expect("partly suspended", call{bearer: tok(Resident, false, "", suspended, main)}, g.RequireResident, "", main)

	// Staff: deleted hostels drop; main by kind; header by id or slug, only if held.
	expect("deleted", call{bearer: tok(HostelAdmin, false, "", deleted, main)}, g.RequireHostelStaff, "", main)
	expect("main by kind", call{bearer: tok(HostelAdmin, false, "", branch, main)}, g.RequireHostelStaff, "", main)
	expect("header slug", call{bearer: tok(HostelAdmin, false, "", branch, main), header: "branch"}, g.RequireHostelStaff, "", branch)
	expect("header id", call{bearer: tok(HostelAdmin, false, "", branch, main), header: branch.Hex()}, g.RequireHostelStaff, "", branch)
	expect("header not held", call{bearer: tok(HostelAdmin, false, "", branch, main), header: kycLocked.Hex()}, g.RequireHostelStaff, "", main)
	p, _ = run(call{bearer: tok(HostelAdmin, false, "", branch, main)}, g.RequireHostelStaff)
	if p == nil || len(p.AllHostelIDs) != 2 {
		t.Error("AllHostelIDs keeps every live hostel")
	}

	// KYC.
	expect("kyc frozen", call{method: "POST", path: "/api/v1/hostel-admin/residents", bearer: tok(HostelAdmin, false, "", kycLocked)}, g.RequireHostelStaff, "KYC_REQUIRED")
	expect("kyc read", call{path: "/api/v1/hostel-admin/residents", bearer: tok(HostelAdmin, false, "", kycLocked)}, g.RequireHostelStaff, "")
	expect("trial over", call{method: "POST", path: "/api/v1/hostel-admin/notices", bearer: tok(HostelAdmin, false, "", trialOver)}, g.RequireHostelStaff, "TRIAL_ENDED_KYC")
	expect("trial over kyc", call{method: "POST", path: "/api/v1/hostel-admin/kyc", bearer: tok(HostelAdmin, false, "", trialOver)}, g.RequireHostelStaff, "")

	// Capabilities: the warden's hostels narrow to the granting ones.
	wt := tok(Warden, false, "", main)
	expect("alias grants view", call{bearer: wt}, func(c *gin.Context) (*Principal, error) { return g.RequireHostelCapability(c, "viewPayments") }, "", main)
	expect("alias not reverse", call{bearer: wt}, func(c *gin.Context) (*Principal, error) { return g.RequireHostelCapability(c, "reversePayments") }, "CAPABILITY_DENIED")
	expect("admin holds all", call{bearer: tok(HostelAdmin, false, "", main)}, func(c *gin.Context) (*Principal, error) { return g.RequireHostelCapability(c, "reversePayments") }, "", main)

	// Tenant scope: 404, never 403; superadmin reaches everything.
	scoped := func(h bson.ObjectID) func(*gin.Context) (*Principal, error) {
		return func(c *gin.Context) (*Principal, error) { return g.RequireHostelScoped(c, h.Hex()) }
	}
	expect("foreign hostel", call{bearer: tok(HostelAdmin, false, "", main)}, scoped(branch), "NOT_FOUND")
	expect("own hostel", call{bearer: tok(HostelAdmin, false, "", main)}, scoped(main), "")
	expect("superadmin", call{bearer: tok(Superadmin, false, "")}, scoped(branch), "")
	expect("cook scoped", call{bearer: tok(Cook, false, "", main)}, scoped(main), "FORBIDDEN")

	admin := &Principal{Role: HostelAdmin, HostelIDs: []string{main.Hex()}}
	if f, err := HostelScopedFilter(admin, branch.Hex()); f != nil || code(err) != "NOT_FOUND" {
		t.Error("filter refuses a foreign hostel with 404")
	}
	if f, _ := HostelScopedFilter(admin, ""); len(f) != 1 || f[0].Key != "hostelId" {
		t.Error("filter scopes to the principal's hostels")
	}
	if f, _ := HostelScopedFilter(&Principal{Role: Superadmin}, ""); len(f) != 0 {
		t.Error("superadmin lists unscoped")
	}
}

// Against the compose Redis; skipped when it is down. A superadmin carrying
// hostel ids skips the hostel read, so no Mongo is needed.
func TestAnnounceWriteBumps(t *testing.T) {
	ctx := context.Background()
	rdb := goredis.NewClient(&goredis.Options{Addr: "127.0.0.1:6380"})
	if rdb.Ping(ctx).Err() != nil {
		t.Skip("local Redis not running")
	}
	defer rdb.Close()
	gin.SetMode(gin.ReleaseMode)
	hostel := bson.NewObjectID().Hex()
	defer rdb.Del(ctx, "v:hostel:"+hostel)

	tokens := auth.NewTokens("s", "r", time.Hour, time.Hour)
	var bg background.Runner
	g := New(tokens, &auth.Cookies{Tokens: tokens}, nil, cache.New(rdb), &bg)
	tok, _ := tokens.SignAccess(auth.TokenInput{UserID: "u", Role: string(Superadmin), HostelIDs: []string{hostel}})

	e := gin.New()
	e.Use(bg.Middleware(), Use(g.Require))
	e.Any("/x", func(c *gin.Context) { c.Status(204) })
	for _, m := range []string{"GET", "POST"} {
		req := httptest.NewRequest(m, "/x", nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		e.ServeHTTP(httptest.NewRecorder(), req)
	}
	_ = bg.Wait(ctx)
	if v, _ := rdb.Get(ctx, "v:hostel:"+hostel).Int(); v != 2 {
		t.Fatalf("a write bumps now and after the response (a read never): version %d", v)
	}
}
