package router

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/softmato/hostelpalika/server/internal/contract/fixture"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
	applog "github.com/softmato/hostelpalika/server/internal/platform/log"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
)

// TestFailedRequestFoundByID is Phase 7's gate in small: a refused request's
// lines are stored and a superadmin finds them by the request id; a
// moderator cannot read the logs at all.
func TestFailedRequestFoundByID(t *testing.T) {
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
	if err := fixture.ResetGroup(ctx, db, "platform"); err != nil {
		t.Fatal(err)
	}
	r, err := New(cfg, Deps{DB: db})
	if err != nil {
		t.Fatal(err)
	}
	prev := slog.Default()
	slog.SetDefault(applog.NewTo(io.Discard, "info"))
	defer slog.SetDefault(prev)
	stop, err := applog.Attach(ctx, db)
	if err != nil {
		t.Fatal(err)
	}

	do := func(method, path, token, requestID, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if requestID != "" {
			req.Header.Set("X-Request-Id", requestID)
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w
	}
	resident, _ := fixture.Mint("access:" + fixture.UserResident.Hex() + ":RESIDENT:" + fixture.HostelKyc.Hex())
	if w := do("POST", "/api/v1/usage/events", resident, "gate-req-1", `{"events":"nope"}`); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("setup request: %d %s", w.Code, w.Body)
	}
	stop()

	super, _ := fixture.Mint("access:" + fixture.UserSuperadmin.Hex() + ":SUPERADMIN")
	w := do("GET", "/api/v1/platform/logs?requestId=gate-req-1", super, "", "")
	var got struct {
		Data struct{ Entries []applog.Entry }
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != http.StatusOK {
		t.Fatalf("list: %d %s", w.Code, w.Body)
	}
	if len(got.Data.Entries) == 0 || got.Data.Entries[0].RequestID != "gate-req-1" || got.Data.Entries[0].Level != "warn" {
		t.Fatalf("request not found by id: %s", w.Body)
	}
	if w := do("GET", "/api/v1/platform/logs/summary", super, "", ""); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"level":"warn"`) {
		t.Fatalf("summary: %d %s", w.Code, w.Body)
	}
	if w := do("GET", "/api/v1/platform/logs?level=loud", super, "", ""); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad level accepted: %d", w.Code)
	}
	mod, _ := fixture.Mint("access:" + fixture.UserModerator.Hex() + ":PLATFORM_MODERATOR")
	if w := do("GET", "/api/v1/platform/logs", mod, "", ""); w.Code != http.StatusForbidden {
		t.Fatalf("moderator read the logs: %d", w.Code)
	}
}
