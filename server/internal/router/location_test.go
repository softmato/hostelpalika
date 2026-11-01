package router

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/contract/fixture"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
)

// A ping's coordinates are used for the distance and dropped (RULES.md §4): no
// document written by the request may hold them, whatever collection it lands in.
func TestLocationPingNeverPersistsCoordinates(t *testing.T) {
	ctx := context.Background()
	client, db, err := appmongo.Connect(ctx, fixture.URI)
	if err != nil {
		t.Skip("contract Mongo not running")
	}
	defer func() { _ = client.Disconnect(ctx) }()
	if err := db.Client().Ping(ctx, nil); err != nil {
		t.Skip("contract Mongo not running")
	}
	if err := fixture.Reset(ctx, db); err != nil {
		t.Fatal(err)
	}
	cfg, _, err := config.Parse(func(k string) (string, bool) { v, ok := contractEnv[k]; return v, ok })
	if err != nil {
		t.Fatal(err)
	}
	r, err := New(cfg, Deps{DB: db})
	if err != nil {
		t.Fatal(err)
	}
	token, _ := fixture.Mint("access:" + fixture.UserTracked.Hex() + ":RESIDENT:" + fixture.HostelTracked.Hex())
	send := func(path, body string) {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body)
		}
	}
	send("/api/v1/resident/consent", `{"granted":true}`)
	send("/api/v1/resident/location/ping", `{"lat":27.123456,"lng":85.654321,"accuracyMeters":5}`)
	names, err := db.ListCollectionNames(ctx, bson.D{})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		cur, err := db.Collection(name).Find(ctx, bson.D{})
		if err != nil {
			t.Fatal(err)
		}
		for cur.Next(ctx) {
			s := cur.Current.String()
			if strings.Contains(s, "27.123456") || strings.Contains(s, "85.654321") {
				t.Fatalf("%s holds the coordinates: %s", name, s)
			}
		}
		_ = cur.Close(ctx)
	}
}
