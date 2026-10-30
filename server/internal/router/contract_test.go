package router

import (
	"bytes"
	"context"
	"io"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/softmato/hostelpalika/server/internal/contract"
	"github.com/softmato/hostelpalika/server/internal/contract/fixture"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
)

// contractEnv is the environment the TS server is recorded under
// (TESTING.md §3): contract secrets, no Resend/Upstash/Pusher keys.
var contractEnv = map[string]string{
	"APP_ENV":           "development",
	"APP_URL":           "http://localhost:3000",
	"MONGODB_URI":       fixture.URI,
	"JWT_ACCESS_SECRET": fixture.AccessSecret, "JWT_REFRESH_SECRET": fixture.RefreshSecret,
	"OTP_HASH_SECRET":              fixture.OTPSecret,
	"GOOGLE_CLIENT_ID":             fixture.GoogleClient,
	"PERSONAL_DATA_ENCRYPTION_KEY": "0000000000000000000000000000000000000000000000000000000000000001",
	"FINANCE_MASTER_KEY":           "0000000000000000000000000000000000000000000000000000000000000002",
}

// TestContract replays every recorded TS response against the Go router.
// health/ needs nothing; every other group runs on the fixture database,
// reset before each file, and is skipped when Mongo is down.
func TestContract(t *testing.T) {
	files, err := contract.Files("../../testdata/contract")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Fatal("no contract cases found")
	}
	cfg, _, err := config.Parse(func(k string) (string, bool) { v, ok := contractEnv[k]; return v, ok })
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	var deps Deps
	if client, db, err := appmongo.Connect(ctx, fixture.URI); err == nil {
		defer func() { _ = client.Disconnect(ctx) }()
		deps.DB = db
	}
	r, err := New(cfg, deps)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		needsDB := filepath.Base(filepath.Dir(f)) != "health"
		cases, err := contract.Load(f)
		if err != nil {
			t.Fatal(err)
		}
		t.Run(filepath.Base(filepath.Dir(f))+"/"+strings.TrimSuffix(filepath.Base(f), ".json"), func(t *testing.T) {
			if needsDB {
				if deps.DB == nil {
					t.Skip("contract Mongo not running")
				}
				if err := fixture.Reset(ctx, deps.DB); err != nil {
					t.Fatal(err)
				}
			}
			vars := map[string]string{}
			for _, c := range cases {
				if c.Response == nil {
					t.Fatal(c.Name + ": not recorded yet: go run ./cmd/dev record " + f)
				}
				method, path, headers, raw := c.Request.Prepare(vars)
				var body io.Reader
				if raw != nil {
					body = bytes.NewReader(raw)
				}
				req := httptest.NewRequest(method, path, body)
				for k, v := range headers {
					req.Header.Set(k, v)
				}
				w := httptest.NewRecorder()
				r.ServeHTTP(w, req)
				cookies := w.Header().Values("Set-Cookie")
				for _, d := range contract.Diff(c, w.Code, w.Header().Get("Content-Type"), cookies, w.Body.Bytes()) {
					t.Errorf("%s: %s", c.Name, d)
				}
				for _, d := range contract.DiffLocation(c, w.Header().Get("Location")) {
					t.Errorf("%s: %s", c.Name, d)
				}
				contract.Collect(c, cookies, w.Body.Bytes(), vars)
			}
		})
	}
}
