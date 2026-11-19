// Package guide is GET /api/v1/guide (apps/web/src/app/api/v1/guide/route.ts):
// the private user guide as one reader may see it.
//
// The guide is how a hostel is run on the platform, written down, and the
// repository is public, so its words live only in the private bucket
// (guide/content.json + guide/pictures/*, uploaded by scripts/guide-sync.ts).
// This keeps the chapters the reader's role may open, names the parts they may
// not, and signs each picture. The JSON is handled as ordered maps, never typed
// structs, so a field added to the content is passed on rather than dropped.
package guide

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/storage"
)

const (
	contentKey   = "guide/content.json"
	platformName = "HostelPalika" // PLATFORM_NAME
	// PictureTTL is long enough to read the whole guide in one sitting.
	PictureTTL = 6 * time.Hour
	// cacheFor: a pushed edit reaches readers within this long.
	cacheFor = 5 * time.Minute
)

var errUnavailable = httpx.NewError(http.StatusServiceUnavailable, "GUIDE_UNAVAILABLE",
	"The guide could not be loaded. Try again in a minute.", nil)

type Handler struct {
	R2     *storage.R2
	Config *platformconfig.Service
	Guards *authz.Guards
	Now    func() time.Time

	mu       sync.Mutex
	content  ordered.Map
	loadedAt time.Time
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.GET("/guide", h.get)
}

func (h *Handler) get(c *gin.Context) {
	p, err := h.Guards.Load(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	role := ""
	if p != nil {
		role = string(p.Role)
	}
	reader := ReaderForRole(role)
	content := h.load(c)
	if content == nil {
		httpx.Fail(c, errUnavailable)
		return
	}
	guide, err := h.sign(c, ForReader(content, reader))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	version, updatedAt, err := h.versionLine(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	c.Header("Cache-Control", "private, no-store")
	httpx.OK(c, ordered.Map{
		{Key: "guide", Value: guide},
		{Key: "locked", Value: Locked(content, reader)},
		{Key: "reader", Value: reader},
		{Key: "updatedAt", Value: updatedAt},
		{Key: "version", Value: version},
	}, "Guide loaded")
}

// load is loadGuideContent: the stored guide, cached; the last good copy when R2 fails.
func (h *Handler) load(ctx context.Context) ordered.Map {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.content != nil && h.Now().Sub(h.loadedAt) < cacheFor {
		return h.content
	}
	if fresh := h.read(ctx); fresh != nil {
		h.content, h.loadedAt = fresh, h.Now()
	}
	return h.content
}

func (h *Handler) read(ctx context.Context) ordered.Map {
	bucket, err := h.R2.PrivateBucket()
	if err != nil {
		slog.Error("guide: no private bucket", "err", err)
		return nil
	}
	raw := h.R2.ReadStoredObject(ctx, bucket, h.R2.WithKeyPrefix(contentKey))
	if raw == nil {
		slog.Error("guide: content could not be read from R2")
		return nil
	}
	m, err := Parse(raw)
	if err != nil {
		slog.Error("guide: content is not valid JSON", "err", err)
		return nil
	}
	return m
}

// Parse is parseGuideContent: `{platform}` becomes the product's name, then JSON.
func Parse(raw []byte) (ordered.Map, error) {
	v, err := ordered.FromJSON(bytes.ReplaceAll(raw, []byte("{platform}"), []byte(platformName)))
	if err != nil {
		return nil, err
	}
	m, ok := v.(ordered.Map)
	if !ok {
		return nil, errUnavailable
	}
	return m, nil
}

// sign is the TS map of signed URLs + withPictureUrls: each flow/shot gets
// `name` and a signed `src`, in that key order (`{...p, name, src}`).
func (h *Handler) sign(ctx context.Context, guide ordered.Map) (ordered.Map, error) {
	bucket, err := h.R2.PrivateBucket()
	if err != nil {
		return nil, err
	}
	signed := map[string]string{}
	var failure error
	url := func(src string) string {
		name := PictureName(src)
		if u, ok := signed[name]; ok {
			return u
		}
		u, err := h.R2.PresignReadFor(ctx, bucket, h.R2.WithKeyPrefix("guide/pictures/"+name), PictureTTL)
		if err != nil {
			failure = err
			return src
		}
		signed[name] = u
		return u
	}
	out := WithPictureURLs(guide, url)
	return out, failure
}

// versionLine is legal.guide from the website config (shipped defaults when unset).
func (h *Handler) versionLine(ctx context.Context) (string, string, error) {
	raw, err := h.Config.Section(ctx, "legal")
	if err != nil {
		return "", "", err
	}
	var legal struct {
		Guide struct {
			UpdatedAt string `json:"updatedAt"`
			Version   string `json:"version"`
		} `json:"guide"`
	}
	if err := platformconfig.Decode(raw, &legal); err != nil {
		return "", "", err
	}
	return legal.Guide.Version, legal.Guide.UpdatedAt, nil
}

// PictureName is guidePictureName: `/guide/food.webp` → `food.webp`.
func PictureName(src string) string {
	return src[strings.LastIndex(src, "/")+1:]
}
