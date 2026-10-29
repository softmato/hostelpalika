package obs

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	applog "github.com/softmato/hostelpalika/server/internal/platform/log"
)

func TestMiddleware(t *testing.T) {
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(applog.NewTo(&logs, "info"))
	defer slog.SetDefault(prev)
	gin.SetMode(gin.ReleaseMode)

	// Mongo is optional: with the compose container up, db time is real.
	var coll *mongo.Collection
	if client, err := mongo.Connect(options.Client().ApplyURI("mongodb://127.0.0.1:27018/?directConnection=true").SetMonitor(MongoMonitor())); err == nil {
		defer client.Disconnect(context.Background())
		if client.Ping(context.Background(), nil) == nil {
			coll = client.Database("hostelpalika_obstest").Collection("x")
		}
	}

	r := gin.New()
	r.ContextWithFallback = true
	r.Use(httpx.Recover(), Middleware())
	r.GET("/x", func(c *gin.Context) {
		if coll != nil {
			_ = coll.FindOne(c, bson.D{}).Err()
		}
		slog.InfoContext(c, "inside", "password", "hunter2")
		httpx.OK(c, nil, "")
	})
	r.GET("/etag", httpx.ETag(), func(c *gin.Context) { httpx.OK(c, nil, "") })

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/x", nil)
	req.Header.Set("X-Request-Id", "caddy-uuid-1")
	r.ServeHTTP(w, req)

	timing := w.Header().Get("Server-Timing")
	if !regexp.MustCompile(`^app;dur=[\d.]+, db;dur=[\d.]+, redis;dur=[\d.]+$`).MatchString(timing) {
		t.Fatalf("Server-Timing %q", timing)
	}
	if coll != nil && strings.Contains(timing, "db;dur=0.0,") {
		t.Errorf("Mongo time not counted: %s", timing)
	}
	out := logs.String()
	if strings.Contains(out, "hunter2") {
		t.Fatal("a password reached the log")
	}
	var lines []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(out), "\n") {
		var m map[string]any
		_ = json.Unmarshal([]byte(l), &m)
		lines = append(lines, m)
	}
	if len(lines) != 2 || lines[0]["request_id"] != "caddy-uuid-1" || lines[1]["msg"] != "request" ||
		lines[1]["request_id"] != "caddy-uuid-1" || lines[1]["route"] != "/x" || lines[1]["status"] != float64(200) {
		t.Fatalf("log lines %s", out)
	}

	// A hostile id is replaced; a 304 still carries the timing.
	logs.Reset()
	req = httptest.NewRequest("GET", "/etag", nil)
	req.Header.Set("X-Request-Id", "bad id\n{json}")
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	req = httptest.NewRequest("GET", "/etag", nil)
	req.Header.Set("If-None-Match", w.Header().Get("ETag"))
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req)
	if w2.Code != 304 || w2.Header().Get("Server-Timing") == "" {
		t.Fatalf("304: %d %v", w2.Code, w2.Header())
	}
	if !regexp.MustCompile(`"request_id":"[0-9a-f]{32}"`).MatchString(logs.String()) {
		t.Fatalf("minted id: %s", logs.String())
	}
}
