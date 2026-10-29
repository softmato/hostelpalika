// Package images is libvips through govips — the engine sharp wraps — for
// lib/image-optimizer.ts, lib/uploads/image-integrity.ts and the greyscale
// pixels the evidence hash reads. Held to testdata/vectors/images.json, which
// sharp produced from the same inputs.
package images

import (
	"context"
	"errors"
	"math"
	"strings"
	"sync"

	"github.com/davidbyttow/govips/v2/vips"

	"github.com/softmato/hostelpalika/server/internal/platform/storage"
)

var startup sync.Once

// start boots libvips once per process, quietly.
func start() {
	startup.Do(func() {
		vips.LoggingSettings(nil, vips.LogLevelError)
		vips.Startup(&vips.Config{ConcurrencyLevel: 0, MaxCacheFiles: 0, MaxCacheMem: 50 << 20, MaxCacheSize: 100})
	})
}

func load(b []byte) (*vips.ImageRef, error) {
	start()
	return vips.NewImageFromBuffer(b)
}

// VariantName is THUMBNAIL | MEDIUM | LARGE.
type VariantName string

type spec struct {
	name          VariantName
	width, height int
	cover         bool
}

var variantSpecs = []spec{
	{"THUMBNAIL", 150, 150, true},
	{"MEDIUM", 640, 480, false},
	{"LARGE", 1920, 1080, false},
}

// Variant is one WebP rendition.
type Variant struct {
	Name          VariantName
	WebP          []byte
	Width, Height int
}

// Variants renders the three WebP sizes (quality 80, never enlarged): the
// thumbnail fills and centre-crops, the others fit inside.
func Variants(src []byte) ([]Variant, error) {
	out := make([]Variant, 0, len(variantSpecs))
	for _, s := range variantSpecs {
		img, err := load(src)
		if err != nil {
			return nil, err
		}
		w, h := img.Width(), img.Height()
		// sharp's withoutEnlargement: an image already inside the box is untouched.
		if w > s.width || h > s.height {
			if s.cover {
				err = img.ThumbnailWithSize(s.width, s.height, vips.InterestingCentre, vips.SizeDown)
			} else {
				scale := math.Min(float64(s.width)/float64(w), float64(s.height)/float64(h))
				err = img.ThumbnailWithSize(int(math.Round(float64(w)*scale)), int(math.Round(float64(h)*scale)), vips.InterestingNone, vips.SizeDown)
			}
		}
		if err != nil {
			img.Close()
			return nil, err
		}
		params := vips.NewWebpExportParams()
		params.Quality = 80
		webp, _, err := img.ExportWebp(params)
		width, height := img.Width(), img.Height()
		img.Close()
		if err != nil {
			return nil, err
		}
		out = append(out, Variant{s.name, webp, width, height})
	}
	return out, nil
}

// VariantRecord is ImageVariantRecord, as FileAsset stores it.
type VariantRecord struct {
	Height    int         `bson:"height" json:"height"`
	Key       string      `bson:"key" json:"key"`
	MimeType  string      `bson:"mimeType" json:"mimeType"`
	SizeBytes int         `bson:"sizeBytes" json:"sizeBytes"`
	Variant   VariantName `bson:"variant" json:"variant"`
	Width     int         `bson:"width" json:"width"`
}

// OptimizeStored is optimizeImage: renders the variants of a stored image and
// stores each beside it as <key-without-ext>-<variant>.webp, immutable.
func OptimizeStored(ctx context.Context, r2 *storage.R2, bucket, key, mimeType string) ([]VariantRecord, error) {
	if !strings.HasPrefix(mimeType, "image/") {
		return nil, nil
	}
	src := r2.ReadStoredObject(ctx, bucket, key)
	if src == nil {
		return nil, errors.New("Empty response from R2")
	}
	variants, err := Variants(src)
	if err != nil {
		return nil, err
	}
	base := key
	if i := strings.LastIndex(key, "."); i > strings.LastIndex(key, "/") {
		base = key[:i]
	}
	out := make([]VariantRecord, 0, len(variants))
	for _, v := range variants {
		vkey := base + "-" + strings.ToLower(string(v.Name)) + ".webp"
		if err := r2.Put(ctx, bucket, vkey, v.WebP, "image/webp", "public, max-age=31536000, immutable"); err != nil {
			return nil, err
		}
		out = append(out, VariantRecord{v.Height, vkey, "image/webp", len(v.WebP), v.Name, v.Width})
	}
	return out, nil
}

// Insight is ImageInsight.
type Insight struct {
	Contrast  float64 `json:"contrast"`
	Height    int     `json:"height"`
	NearBlank bool    `json:"nearBlank"`
	Width     int     `json:"width"`
}

const (
	minEdge     = 120
	minContrast = 2
)

// IsInspectable is isInspectableImage.
func IsInspectable(mimeType string) bool {
	switch strings.ToLower(mimeType) {
	case "image/jpeg", "image/png", "image/webp":
		return true
	}
	return false
}

// Inspect flags blank or tiny uploads; nil when the bytes are not a readable image.
func Inspect(b []byte) *Insight {
	img, err := load(b)
	if err != nil {
		return nil
	}
	defer img.Close()
	w, h := img.Width(), img.Height()
	if w == 0 || h == 0 {
		return nil
	}
	// sharp's stats() reads the input's own bands (alpha included) — the
	// greyscale() before it in image-integrity.ts does not reach it.
	px, err := img.ToBytes()
	if err != nil {
		return nil
	}
	bands := img.Bands()
	// Per-band sample standard deviation (vips_stats), averaged over bands.
	total := 0.0
	for band := 0; band < bands; band++ {
		var sum, sum2, n float64
		for i := band; i < len(px); i += bands {
			v := float64(px[i])
			sum += v
			sum2 += v * v
			n++
		}
		if n > 1 {
			total += math.Sqrt(math.Max(0, (sum2-sum*sum/n)/(n-1)))
		}
	}
	contrast := total / float64(max(1, bands))
	return &Insight{contrast, h, contrast < minContrast || w < minEdge || h < minEdge, w}
}

// GreyPixels is greyscale().resize(w, h, {fit: "fill"}).raw(): one byte per
// pixel. Identical to sharp on opaque images; where alpha is partial sharp
// lands within 8 of 255 levels, which a difference hash does not notice.
func GreyPixels(b []byte, w, h int) ([]byte, error) {
	img, err := load(b)
	if err != nil {
		return nil, err
	}
	defer img.Close()
	if err := img.ToColorSpace(vips.InterpretationBW); err != nil {
		return nil, err
	}
	if img.HasAlpha() {
		if err := img.ExtractBand(0, 1); err != nil {
			return nil, err
		}
	}
	if err := img.ResizeWithVScale(float64(w)/float64(img.Width()), float64(h)/float64(img.Height()), vips.KernelLanczos3); err != nil {
		return nil, err
	}
	if err := img.Cast(vips.BandFormatUchar); err != nil {
		return nil, err
	}
	px, err := img.ToBytes()
	if err != nil {
		return nil, err
	}
	if len(px) != w*h {
		return nil, errors.New("images: resize produced an unexpected size")
	}
	return px, nil
}
