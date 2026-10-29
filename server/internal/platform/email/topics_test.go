package email

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
)

func TestPreferenceVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../testdata/vectors/email.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Secret string
		Topics []TopicInfo
		Tokens []struct {
			Address, Token string
			Back           string
			Tampered       *string
		}
		Unsubscribe []struct{ HTML, PageURL, Out string }
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(v.Topics, Topics) {
		t.Errorf("topics drifted from TS: %+v", v.Topics)
	}
	s := &Sender{PrefSecret: v.Secret, Outbound: "https://hostelpalika.com"}
	for _, c := range v.Tokens {
		if got := s.PreferenceToken(c.Address); got != c.Token {
			t.Errorf("token %q: %s != %s", c.Address, got, c.Token)
		}
		if got := s.AddressFromPreferenceToken(c.Token); got != c.Back {
			t.Errorf("back %q: %q", c.Address, got)
		}
		if s.AddressFromPreferenceToken(c.Token+"x") != "" || c.Tampered != nil {
			t.Error("tampered token accepted")
		}
	}
	for _, c := range v.Unsubscribe {
		if got := WithUnsubscribeLine(c.HTML, c.PageURL); got != c.Out {
			t.Errorf("unsubscribe line:\n%s\n%s", got, c.Out)
		}
	}
}

// Notify with a topic carries the one-click headers; SendBatch goes to /batch.
func TestNotifyAndBatch(t *testing.T) {
	var bodies []string
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		bodies, paths = append(bodies, string(b)), append(paths, r.URL.Path)
		if strings.HasSuffix(r.URL.Path, "/batch") {
			_, _ = w.Write([]byte(`{"data":[{"id":"a"},{"id":"b"}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"one"}`))
	}))
	defer srv.Close()
	s := NewSender("key", "hostelpalika.com", "", nil)
	s.URL, s.PrefSecret, s.Outbound = srv.URL+"/emails", "x", "https://hostelpalika.com"
	ctx := context.Background()

	if !s.Notify(ctx, Notification{Action: "notice", To: "a@b.co", Subject: "s", HTML: "<p>x</p>", Topic: "NOTICES"}) {
		t.Fatal("not sent")
	}
	if !strings.Contains(bodies[0], `"List-Unsubscribe-Post":"List-Unsubscribe=One-Click"`) || !strings.Contains(bodies[0], "/api/v1/email-preferences/unsubscribe?token=") {
		t.Errorf("headers missing: %s", bodies[0])
	}
	got := s.NotifyBatch(ctx, []Notification{{To: "a@b.co", Subject: "1", HTML: "x"}, {To: "c@d.co", Subject: "2", HTML: "y", Topic: "RENT_REMINDERS"}})
	if !reflect.DeepEqual(got, []bool{true, true}) || paths[1] != "/emails/batch" {
		t.Errorf("batch %v %v", got, paths)
	}
	var batch []map[string]any
	_ = json.Unmarshal([]byte(bodies[1]), &batch)
	if _, has := batch[0]["headers"]; has || batch[1]["headers"] == nil {
		t.Error("only the topic mail carries unsubscribe headers")
	}
	s.APIKey = ""
	if r := s.SendBatch(ctx, []Message{{To: []string{"x@y.z"}}}); r[0].Reason != "not_configured" {
		t.Error(r)
	}
}
