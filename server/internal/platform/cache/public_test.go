package cache

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// PublicChanged reaches the web with its secret; no secret, no call; nil is safe.
func TestPublicChangedPingsWeb(t *testing.T) {
	got := make(chan string, 2)
	web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got <- r.Method + " " + r.URL.Path + " " + r.Header.Get("Authorization")
	}))
	defer web.Close()

	(&Cache{Web: Web{URL: web.URL}}).PublicChanged(context.Background()) // no secret
	(*Cache)(nil).PublicChanged(context.Background())
	PublicChangedOn(context.Background(), nil)
	(&Cache{Web: Web{URL: web.URL, Secret: "s3"}}).PublicChanged(context.Background())

	select {
	case call := <-got:
		if call != "POST /api/revalidate Bearer s3" {
			t.Fatalf("web got %q", call)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("web never called")
	}
	select {
	case call := <-got:
		t.Fatalf("unexpected second call %q", call)
	case <-time.After(200 * time.Millisecond):
	}
}
