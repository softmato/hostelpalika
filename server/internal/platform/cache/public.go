package cache

import (
	"context"
	"log/slog"
	"net/http"
	"time"
)

// PublicScope is the version every signed-out read is cached under
// (Respond with []string{PublicScope}), so one PublicChanged drops them all.
const PublicScope = "public"

// PublicTTL: how long a public entry lives without a PublicChanged. It is the
// window TS already promised (PUBLIC_CACHE stale-while-revalidate=600), so a
// change whose write path misses the call still shows within it.
const PublicTTL = 10 * time.Minute

// Web is the Next.js site: its server-rendered public pages keep a 6 h copy of
// these reads until POST {URL}/api/revalidate clears them.
type Web struct {
	URL    string // APP_URL, no trailing slash
	Secret string // REVALIDATE_SECRET; empty = the web is never called
}

// PublicChangedOn is PublicChanged on a field typed as realtime.Bumper: the
// cache passes, a test fake or nil is skipped.
func PublicChangedOn(ctx context.Context, b any) {
	if c, ok := b.(*Cache); ok {
		c.PublicChanged(ctx)
	}
}

var webClient = &http.Client{Timeout: 5 * time.Second}

// PublicChanged is revalidatePublicPages: something a listing shows changed, so
// the cached public reads here and the web's cached pages are both dropped.
// Never fails and never holds up the write that called it.
func (c *Cache) PublicChanged(ctx context.Context) {
	if c == nil {
		return
	}
	c.Bump(ctx, PublicScope)
	if c.Web.URL == "" || c.Web.Secret == "" {
		return
	}
	// ponytail: one POST per call; a burst of writes sends a few, which the
	// web absorbs (revalidatePath only marks the pages stale). Coalesce if it shows up.
	go func() {
		req, err := http.NewRequest(http.MethodPost, c.Web.URL+"/api/revalidate", nil)
		if err != nil {
			return
		}
		req.Header.Set("Authorization", "Bearer "+c.Web.Secret)
		res, err := webClient.Do(req)
		if err == nil {
			_ = res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return
			}
			slog.Warn("web revalidate refused", "category", "cache", "status", res.StatusCode)
			return
		}
		slog.Warn("web revalidate failed", "category", "cache", "error", err.Error())
	}()
}
