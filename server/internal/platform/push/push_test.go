package push

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	webpush "github.com/SherClockHolmes/webpush-go"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/config"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
)

func TestChannelsAndPriority(t *testing.T) {
	for _, c := range []struct{ category, priority, want string }{
		{"SOS", "", "urgent"}, {"GENERAL", "URGENT", "urgent"}, {"FOOD", "", "food_v2"},
		{"NOTICE", "", "notices_v1"}, {"PLATFORM", "HIGH", "notices_v1"}, {"PAYMENT", "", "default_v2"},
	} {
		if got := androidChannel(c.category, c.priority); got != c.want {
			t.Errorf("%s/%s: %s", c.category, c.priority, got)
		}
	}
	if !highPriority(Payload{Category: "URGENT"}) || highPriority(Payload{Priority: "NORMAL"}) {
		t.Error("priority")
	}
}

// Against the compose Mongo in a throwaway db; skipped when it is down.
func TestToUsers(t *testing.T) {
	ctx := context.Background()
	client, db, err := appmongo.Connect(ctx, "mongodb://127.0.0.1:27018/hostelpalika_pushtest?directConnection=true")
	if err != nil {
		t.Skip("local Mongo not running:", err)
	}
	defer func() { _ = db.Drop(ctx); _ = client.Disconnect(ctx) }()

	alice, bob := bson.NewObjectID(), bson.NewObjectID()
	_, _ = db.Collection("devicetokens").InsertMany(ctx, []any{
		bson.D{{Key: "userId", Value: alice}, {Key: "token", Value: "ExponentPushToken[a]"}, {Key: "platform", Value: "ANDROID"}, {Key: "status", Value: "ACTIVE"}},
		bson.D{{Key: "userId", Value: alice}, {Key: "token", Value: "ExponentPushToken[a]"}, {Key: "platform", Value: "ANDROID"}, {Key: "status", Value: "ACTIVE"}},
		bson.D{{Key: "userId", Value: bob}, {Key: "token", Value: "ExponentPushToken[dead]"}, {Key: "platform", Value: "IOS"}, {Key: "status", Value: "ACTIVE"}},
		bson.D{{Key: "userId", Value: bob}, {Key: "token", Value: "ExponentPushToken[draws]"}, {Key: "platform", Value: "ANDROID"}, {Key: "status", Value: "ACTIVE"},
			{Key: "capabilities", Value: bson.A{AppDrawsCategoryPushes}}},
		bson.D{{Key: "userId", Value: bob}, {Key: "token", Value: "ExponentPushToken[old]"}, {Key: "platform", Value: "IOS"}, {Key: "status", Value: "REVOKED"}},
	})

	var sent []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &sent)
		var tickets []map[string]any
		for _, m := range sent {
			if m["to"] == "ExponentPushToken[dead]" {
				tickets = append(tickets, map[string]any{"status": "error", "details": map[string]any{"error": "DeviceNotRegistered"}})
			} else {
				tickets = append(tickets, map[string]any{"status": "ok", "id": "ticket-" + m["to"].(string)})
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": tickets})
	}))
	defer srv.Close()

	s := New(db, config.Push{}, Hooks{DeepLink: func(Payload) string { return "/(resident)/notices" }})
	s.Endpoint = srv.URL
	res := s.ToUsers(ctx, []string{alice.Hex(), bob.Hex(), alice.Hex(), ""}, Payload{
		Title: "Notice", Body: "Water off at 2", Category: "NOTICE", CategoryID: "notice",
		HostelID: "h1", DataByUser: map[string]map[string]any{bob.Hex(): {"residentId": "r9"}},
	})
	if res.Sent != 2 || res.Revoked != 1 || res.Skipped || len(sent) != 3 {
		t.Fatalf("%+v, %d messages", res, len(sent))
	}
	for _, m := range sent {
		data := m["data"].(map[string]any)
		if data["path"] != "/(resident)/notices" || data["category"] != "NOTICE" || data["hostelId"] != "h1" {
			t.Errorf("data %v", data)
		}
		if _, has := data["notificationId"]; has {
			t.Error("an absent notificationId must be left out, as undefined is")
		}
		switch m["to"] {
		case "ExponentPushToken[draws]":
			if m["title"] != nil || data["draw"] == nil || data["residentId"] != "r9" {
				t.Errorf("drawn-by-app message %v", m)
			}
		case "ExponentPushToken[a]":
			if m["channelId"] != "notices_v1" || m["priority"] != "high" || m["sound"] != "water_drop.wav" {
				t.Errorf("message %v", m)
			}
		}
	}
	if n, _ := db.Collection("pushtickets").CountDocuments(ctx, bson.D{{Key: "status", Value: "PENDING"}}); n != 2 {
		t.Errorf("%d tickets stored", n)
	}
	var dead bson.M
	_ = db.Collection("devicetokens").FindOne(ctx, bson.D{{Key: "token", Value: "ExponentPushToken[dead]"}}).Decode(&dead)
	if dead["status"] != "REVOKED" {
		t.Error("DeviceNotRegistered must revoke the token")
	}
	s.Hooks.Filter = func(context.Context, []string, string, bool) []string { return nil }
	if r := s.ToUsers(ctx, []string{alice.Hex()}, Payload{Category: "FOOD"}); !r.Skipped {
		t.Error("filtered out everyone, still sent")
	}
}

// The browser leg: real VAPID + subscription keys, a fake push service answering 201 or 410.
func TestSendWeb(t *testing.T) {
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatal(err)
	}
	sub, _ := ecdh.P256().GenerateKey(rand.Reader)
	auth := make([]byte, 16)
	_, _ = rand.Read(auth)
	var mu sync.Mutex
	var urgency string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		urgency = r.Header.Get("Urgency")
		mu.Unlock()
		if r.URL.Path == "/gone" {
			w.WriteHeader(http.StatusGone)
			return
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	keys := &struct {
		Auth   string `bson:"auth"`
		P256dh string `bson:"p256dh"`
	}{base64.RawURLEncoding.EncodeToString(auth), base64.RawURLEncoding.EncodeToString(sub.PublicKey().Bytes())}
	s := New(nil, config.Push{VAPIDPrivateKey: priv, VAPIDPublicKey: pub, VAPIDSubject: "mailto:alerts@hostelpalika.com"}, Hooks{})
	n, dead := s.sendWeb([]device{{Token: srv.URL + "/ok", Keys: keys}, {Token: srv.URL + "/gone", Keys: keys}, {Token: srv.URL + "/nokeys"}}, []byte(`{"title":"x"}`), true)
	if n != 1 || len(dead) != 1 || dead[0] != srv.URL+"/gone" || urgency != "high" {
		t.Fatalf("sent %d, dead %v, urgency %q", n, dead, urgency)
	}
}
