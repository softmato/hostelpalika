package log_test

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/contract/fixture"
	applog "github.com/softmato/hostelpalika/server/internal/platform/log"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
)

func TestCategoryAndLevels(t *testing.T) {
	var out bytes.Buffer
	l := applog.NewTo(&out, "info")
	l.Info("plain")                               // logged from a test package: http
	l.Info("tagged", "category", "payments")      // explicit wins
	l.Info("bogus", "category", "not-a-category") // not in the list: inferred
	applog.SetCategoryLevels(map[string]slog.Level{"payments": slog.LevelError, "email": slog.LevelDebug})
	l.Warn("quiet", "category", "payments") // below payments' error level
	l.Debug("loud", "category", "email")    // email opened to debug
	l.Debug("still quiet")                  // http follows LOG_LEVEL=info
	applog.SetCategoryLevels(nil)

	got := out.String()
	for _, want := range []string{`"msg":"plain","category":"http"`, `"msg":"tagged","category":"payments"`,
		`"msg":"bogus","category":"http"`, `"msg":"loud","category":"email"`} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %s in\n%s", want, got)
		}
	}
	for _, not := range []string{"quiet", "not-a-category"} {
		if strings.Contains(got, not) {
			t.Errorf("%q should not be logged:\n%s", not, got)
		}
	}
}

// TestStoreRedacts: every kind of secret RULES.md names, logged at warn,
// reaches neither stdout nor the stored row.
func TestStoreRedacts(t *testing.T) {
	ctx := context.Background()
	client, db, err := appmongo.Connect(ctx, fixture.URI)
	if err != nil {
		t.Skip("contract Mongo not running")
	}
	defer func() { _ = client.Disconnect(ctx) }()
	db = client.Database("log_store_test")
	defer func() { _ = db.Drop(ctx) }()

	var out bytes.Buffer
	l := applog.NewTo(&out, "info")
	stop, err := applog.Attach(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	secrets := []any{"token", "tok-1", "cookie", "ck-1", "password", "pw-1", "pin", "1234", "otp", "999111",
		"email", "a@b.c", "phone", "9800000000", "lat", 27.7, "lng", 85.3}
	l.With("user", "u1").WarnContext(applog.WithRequestID(ctx, "req-1"), "login refused",
		append(secrets, "route", "/api/v1/auth/login", "status", 401, "nested", slog.GroupValue(slog.String("refreshToken", "rt-1")))...)
	l.Info("not stored")
	l.Info("stored info", "operational", true)
	stop()

	var rows []applog.Entry
	cur, err := db.Collection(applog.Collection).Find(ctx, bson.D{})
	if err != nil {
		t.Fatal(err)
	}
	if err := cur.All(ctx, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("stored %d rows, want 2 (warn + operational info)", len(rows))
	}
	r := rows[0]
	if r.RequestID != "req-1" || r.UserID != "u1" || r.Route != "/api/v1/auth/login" || r.Status != 401 || r.Level != "warn" || r.Category != "http" {
		t.Errorf("row fields wrong: %+v", r)
	}
	stored, _ := bson.MarshalExtJSON(r, false, false)
	for i := 1; i < len(secrets); i += 2 {
		v := strings.TrimSpace(strings.Trim(bytesOf(secrets[i]), `"`))
		if strings.Contains(string(stored), v) || strings.Contains(out.String(), v) {
			t.Errorf("secret %v leaked", secrets[i-1])
		}
	}
	if strings.Contains(string(stored), "rt-1") || strings.Contains(out.String(), "rt-1") {
		t.Error("nested refreshToken leaked")
	}
}

func bytesOf(v any) string {
	b, _ := bson.MarshalExtJSON(bson.D{{Key: "v", Value: v}}, false, false)
	s := string(b)
	return s[strings.Index(s, ":")+1 : len(s)-1]
}
