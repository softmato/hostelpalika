package realtime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
)

// realtime.json comes from the `pusher` npm package and the TS bridge (generate.ts).

type member struct {
	UserID   string `json:"user_id"`
	UserInfo struct {
		Name string `json:"name"`
		Role string `json:"role"`
	} `json:"user_info"`
}

func vectors(t *testing.T) (v struct {
	Auths []struct {
		SocketID, Channel string
		Member            *member
		Auth              Auth
	}
	Signed struct {
		Now         int64
		Body, Query string
	}
	Writes []struct {
		Method, Path string
		Topics       []Topic
	}
	Endpoints []struct {
		Topics    []Topic
		Endpoints []string
	}
}) {
	raw, err := os.ReadFile("../../../testdata/vectors/realtime.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func client() *Client {
	return New(config.Pusher{AppID: "1234", Key: "vector-key", Secret: "vector-secret", Cluster: "ap2"})
}

func TestSigningMatchesPusherNPM(t *testing.T) {
	v := vectors(t)
	c := client()
	for _, a := range v.Auths {
		var m any
		if a.Member != nil {
			m = *a.Member
		}
		got, err := c.Authorize(a.SocketID, a.Channel, m)
		if err != nil || *got != a.Auth {
			t.Errorf("%s: %+v %v, want %+v", a.Channel, got, err, a.Auth)
		}
	}
	c.now = func() time.Time { return time.Unix(v.Signed.Now, 0) }
	if got := c.signedQuery("/apps/1234/batch_events", []byte(v.Signed.Body)); got != v.Signed.Query {
		t.Errorf("signed query:\n%s\n%s", got, v.Signed.Query)
	}
	if _, err := c.Authorize("abc", "private-x", nil); err == nil {
		t.Error("bad socket id accepted")
	}
	var off *Client
	if a, err := off.Authorize("1.2", "private-x", nil); a != nil || err != nil || off.Configured() {
		t.Error("unconfigured client must no-op")
	}
}

func TestBridge(t *testing.T) {
	v := vectors(t)
	for _, w := range v.Writes {
		if got := TopicsForWrite(w.Method, w.Path); !reflect.DeepEqual(got, w.Topics) {
			t.Errorf("%s %s: %v != %v", w.Method, w.Path, got, w.Topics)
		}
	}
	for _, e := range v.Endpoints {
		if got := EndpointsForTopics(e.Topics); !reflect.DeepEqual(got, e.Endpoints) {
			t.Errorf("%v: %v", e.Topics, got)
		}
	}
	if !reflect.DeepEqual(TopicsForCategory("SOS"), []Topic{Safety}) || len(TopicsForCategory("NOPE")) != 0 {
		t.Error("categories")
	}
}

func TestAccess(t *testing.T) {
	staff := &authz.Principal{UserID: "u", Role: authz.Role("HOSTEL_ADMIN"), HostelIDs: []string{"h1"}}
	if !CanSubscribe(staff, "private-hostel-h1") || CanSubscribe(staff, "private-hostel-h2") || CanSubscribe(staff, PlatformChannel) || CanSubscribe(staff, TrackSheetChannel) {
		t.Error("staff channels")
	}
	agent := &authz.Principal{UserID: "a", Role: authz.PlatformAgent}
	if !CanSubscribe(agent, TrackSheetChannel) {
		t.Error("team on the track sheet")
	}
	if !CanSubscribe(&authz.Principal{UserID: "s", Role: authz.Superadmin}, PlatformChannel) {
		t.Error("platform channel")
	}
}

type bumps []string

func (b *bumps) Bump(_ context.Context, ids ...string) { *b = append(*b, ids...) }

func TestPublishResourceChange(t *testing.T) {
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if r.URL.Path != "/apps/1234/batch_events" || !strings.Contains(r.URL.RawQuery, "auth_signature=") {
			t.Errorf("request %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		got = append(got, string(b))
	}))
	defer srv.Close()
	c := client()
	c.host = srv.URL
	var b bumps
	PublishResourceChange(context.Background(), c, &b, Change{Topics: []Topic{Residents}, HostelIDs: []string{"h1", "", "h1"}, UserIDs: []string{"u1"}, Platform: true})
	want := `{"batch":[{"channel":"private-hostel-h1","name":"resource:changed","data":"{\"topics\":[\"residents\"]}"},{"channel":"private-user-u1","name":"resource:changed","data":"{\"topics\":[\"residents\"]}"},{"channel":"private-platform","name":"resource:changed","data":"{\"topics\":[\"residents\"]}"}]}`
	if len(got) != 1 || got[0] != want || len(b) != 3 {
		t.Errorf("%v %v", got, b)
	}
	b = nil
	PublishResourceChange(context.Background(), nil, &b, Change{Topics: []Topic{Rooms}, HostelIDs: []string{"h2"}})
	if len(b) != 1 {
		t.Error("cache bump must run with Pusher off")
	}
}
