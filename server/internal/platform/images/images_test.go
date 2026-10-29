package images

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"math"
	"os"
	"testing"

	"golang.org/x/image/webp"
)

// images.json is what sharp made of the same PNGs.
func TestMatchesSharp(t *testing.T) {
	raw, err := os.ReadFile("../../../testdata/vectors/images.json")
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]struct {
		PNG      string
		Variants []struct {
			Variant       VariantName
			Width, Height int
			WebP          string
		}
		Inspect    *Insight
		HashPixels []int
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	for name, c := range v {
		src, _ := base64.StdEncoding.DecodeString(c.PNG)
		got, err := Variants(src)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		for i, want := range c.Variants {
			g := got[i]
			if g.Name != want.Variant || g.Width != want.Width || g.Height != want.Height {
				t.Errorf("%s %s: %dx%d, want %dx%d", name, want.Variant, g.Width, g.Height, want.Width, want.Height)
				continue
			}
			sharpWebP, _ := base64.StdEncoding.DecodeString(want.WebP)
			if d := meanDiff(t, g.WebP, sharpWebP); d > 4 {
				t.Errorf("%s %s: mean pixel difference %.2f from sharp", name, want.Variant, d)
			}
		}
		in := Inspect(src)
		if in == nil || in.Width != c.Inspect.Width || in.Height != c.Inspect.Height || in.NearBlank != c.Inspect.NearBlank ||
			math.Abs(in.Contrast-c.Inspect.Contrast) > 1 {
			t.Errorf("%s inspect: %+v, want %+v", name, in, c.Inspect)
		}
		px, err := GreyPixels(src, 9, 8)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		tolerance := 0.0 // exact on opaque images
		if name == "alpha" {
			tolerance = 8
		}
		for i, want := range c.HashPixels {
			if math.Abs(float64(px[i])-float64(want)) > tolerance {
				t.Errorf("%s hash pixel %d: %d, want %d", name, i, px[i], want)
				break
			}
		}
	}
	if Inspect([]byte("not an image")) != nil {
		t.Error("garbage inspected")
	}
}

// meanDiff is the mean absolute RGB difference between two WebPs of one size.
func meanDiff(t *testing.T, a, b []byte) float64 {
	ia, err1 := webp.Decode(bytes.NewReader(a))
	ib, err2 := webp.Decode(bytes.NewReader(b))
	if err1 != nil || err2 != nil || ia.Bounds() != ib.Bounds() {
		t.Fatalf("decode: %v %v", err1, err2)
	}
	var sum float64
	r := ia.Bounds()
	for y := r.Min.Y; y < r.Max.Y; y++ {
		for x := r.Min.X; x < r.Max.X; x++ {
			sum += diff(ia, ib, x, y)
		}
	}
	return sum / float64(r.Dx()*r.Dy())
}

func diff(a, b image.Image, x, y int) float64 {
	r1, g1, b1, _ := a.At(x, y).RGBA()
	r2, g2, b2, _ := b.At(x, y).RGBA()
	return (math.Abs(float64(r1)-float64(r2)) + math.Abs(float64(g1)-float64(g2)) + math.Abs(float64(b1)-float64(b2))) / 3 / 257
}
