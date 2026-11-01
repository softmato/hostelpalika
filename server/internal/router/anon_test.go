package router

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/softmato/hostelpalika/server/internal/contract/fixture"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
)

// openToAnyone lists the routes outside /public and /auth that a stranger may
// reach, each read against its TS route. Everything else must answer 401, so a
// new hostel-admin route that forgets its guard fails here.
var openToAnyone = map[string]bool{
	"GET /api/v1/health":                               true,
	"GET /api/v1/bookings/availability":                true,
	"GET /api/v1/bookings/guide":                       true,
	"GET /api/v1/bookings/policy":                      true,
	"GET /api/v1/bookings/quote":                       true,
	"GET /api/v1/community":                            true,
	"GET /api/v1/community/sidebar":                    true,
	"GET /api/v1/community/spaces":                     true,
	"GET /api/v1/community/:postId":                    true,
	"GET /api/v1/community/:postId/comments":           true,
	"POST /api/v1/community/sponsors/:sponsorId/click": true,
	"POST /api/v1/email-preferences":                   true, // signed link in the body
	"POST /api/v1/email-preferences/unsubscribe":       true, // signed link in the body
	"GET /api/v1/files/:assetId/url":                   true, // public assets; private ones check inside
	"POST /api/v1/cook/accept-invitation":              true, // invitation token in the body
	"POST /api/v1/guardian/accept-invitation":          true, // invitation token in the body
}

func TestAnonymousIsRefused(t *testing.T) {
	cfg, _, err := config.Parse(func(k string) (string, bool) { v, ok := contractEnv[k]; return v, ok })
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	client, db, err := appmongo.Connect(ctx, fixture.URI)
	if err != nil {
		t.Skip("contract Mongo not running")
	}
	defer func() { _ = client.Disconnect(ctx) }()
	r, err := New(cfg, Deps{DB: db})
	if err != nil {
		t.Fatal(err)
	}
	for _, rt := range r.Routes() {
		if strings.HasPrefix(rt.Path, "/api/v1/public/") || strings.HasPrefix(rt.Path, "/api/v1/auth/") || openToAnyone[rt.Method+" "+rt.Path] {
			continue
		}
		req := httptest.NewRequest(rt.Method, ginParam.ReplaceAllString(rt.Path, "aaaaaaaaaaaaaaaaaaaaaaaa"), strings.NewReader("{}"))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("%s %s answered %d to an anonymous request", rt.Method, rt.Path, w.Code)
		}
	}
}
