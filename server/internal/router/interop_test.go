package router

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/softmato/hostelpalika/server/internal/contract/fixture"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
)

// TestInterop is the Phase 1 gate's cross-server half: a TS server on the
// contract database (started as TESTING.md §3 says) and the Go router share
// sessions both ways. Runs only with CONTRACT_TS_BASE=http://localhost:3100.
func TestInterop(t *testing.T) {
	base := os.Getenv("CONTRACT_TS_BASE")
	if base == "" {
		t.Skip("set CONTRACT_TS_BASE to a TS server running on the contract database")
	}
	ctx := context.Background()
	client, db, err := appmongo.Connect(ctx, fixture.URI)
	if err != nil {
		t.Skip("contract Mongo not running:", err)
	}
	defer func() { _ = client.Disconnect(ctx) }()
	if err := fixture.Reset(ctx, db); err != nil {
		t.Fatal(err)
	}
	cfg, _, err := config.Parse(func(k string) (string, bool) { v, ok := contractEnv[k]; return v, ok })
	if err != nil {
		t.Fatal(err)
	}
	goRouter, err := New(cfg, Deps{DB: db})
	if err != nil {
		t.Fatal(err)
	}

	type answer struct {
		status int
		data   map[string]any
		code   string
	}
	call := func(onTS bool, method, path, bearer string, body any) answer {
		t.Helper()
		var raw []byte
		if body != nil {
			raw, _ = json.Marshal(body)
		}
		req := httptest.NewRequest(method, path, bytes.NewReader(raw))
		if onTS {
			req, _ = http.NewRequest(method, base+path, bytes.NewReader(raw))
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("x-hostelhub-client", "mobile")
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		var status int
		var out []byte
		if onTS {
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			out, _ = io.ReadAll(res.Body)
			_ = res.Body.Close()
			status = res.StatusCode
		} else {
			w := httptest.NewRecorder()
			goRouter.ServeHTTP(w, req)
			status, out = w.Code, w.Body.Bytes()
		}
		var env struct {
			Data      map[string]any `json:"data"`
			ErrorCode string         `json:"errorCode"`
		}
		_ = json.Unmarshal(out, &env)
		return answer{status, env.Data, env.ErrorCode}
	}
	login := func(onTS bool, email string) (string, string) {
		a := call(onTS, "POST", "/api/v1/auth/login", "", map[string]string{"identifier": email, "password": fixture.Password})
		if a.status != 200 {
			t.Fatalf("login %s on TS=%v: %d %s", email, onTS, a.status, a.code)
		}
		return a.data["accessToken"].(string), a.data["refreshToken"].(string)
	}
	refresh := func(onTS bool, token string) answer {
		return call(onTS, "POST", "/api/v1/auth/refresh", "", map[string]string{"refreshToken": token})
	}

	// A token minted by TS works on Go, and the reverse.
	tsAccess, tokenA := login(true, "public@contract.test")
	if a := call(false, "GET", "/api/v1/auth/me", tsAccess, nil); a.status != 200 {
		t.Fatalf("TS access token on Go /me: %d %s", a.status, a.code)
	}
	goAccess, _ := login(false, "resident@contract.test")
	if a := call(true, "GET", "/api/v1/auth/me", goAccess, nil); a.status != 200 {
		t.Fatalf("Go access token on TS /me: %d %s", a.status, a.code)
	}

	// Two rotations through Go: A → B → C, each a second after the last — a
	// token signed in the same second with the same claims is byte-identical.
	time.Sleep(1100 * time.Millisecond)
	b := refresh(false, tokenA)
	if b.status != 200 {
		t.Fatalf("Go refresh of a TS token: %d %s", b.status, b.code)
	}
	time.Sleep(1100 * time.Millisecond)
	c := refresh(false, b.data["refreshToken"].(string))
	if c.status != 200 {
		t.Fatalf("second Go refresh: %d %s", c.status, c.code)
	}
	// A is now two rotations old: TS refuses it and, as reuse, ends the session…
	if a := refresh(true, tokenA); a.status != 401 || a.code != "INVALID_SESSION" {
		t.Fatalf("TS accepted a token Go rotated away: %d %s", a.status, a.code)
	}
	// …so the current one is dead on both servers.
	if a := refresh(false, c.data["refreshToken"].(string)); a.status != 401 {
		t.Fatalf("the session survived reuse detection: %d %s", a.status, a.code)
	}
}
