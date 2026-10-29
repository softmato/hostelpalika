// Package qr draws QR codes the way the `qrcode` npm package does (ECL M,
// black on white, its scale and margin arithmetic), held to testdata/vectors/qr.json.
package qr

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"math"

	goqr "github.com/skip2/go-qrcode"
)

// Options mirror the npm package's; zero Margin means 0 only when SetMargin is true.
type Options struct {
	Width int // 0 = scale 4
	// Margin in modules; the npm default is 4.
	Margin    int
	SetMargin bool
	Level     goqr.RecoveryLevel // default Medium
}

// Modules is the symbol without a quiet zone, row-major, true = dark.
func Modules(text string, level goqr.RecoveryLevel) ([][]bool, error) {
	if level == 0 {
		level = goqr.Medium
	}
	q, err := goqr.New(text, level)
	if err != nil {
		return nil, err
	}
	q.DisableBorder = true
	return q.Bitmap(), nil
}

// PNG is toBuffer: an RGBA PNG exactly as wide as the npm package draws it.
func PNG(text string, o Options) ([]byte, error) {
	m, err := Modules(text, o.Level)
	if err != nil {
		return nil, err
	}
	margin := 4.0
	if o.SetMargin || o.Margin != 0 {
		margin = float64(o.Margin)
	}
	size := float64(len(m))
	scale := 4.0
	if o.Width > 0 && float64(o.Width) >= size+margin*2 {
		scale = float64(o.Width) / (size + margin*2)
	}
	side := int(math.Floor((size + margin*2) * scale))
	inset := margin * scale
	img := image.NewNRGBA(image.Rect(0, 0, side, side))
	white, black := color.NRGBA{255, 255, 255, 255}, color.NRGBA{0, 0, 0, 255}
	for i := 0; i < side; i++ {
		for j := 0; j < side; j++ {
			c := white
			fi, fj := float64(i), float64(j)
			if fi >= inset && fj >= inset && fi < float64(side)-inset && fj < float64(side)-inset &&
				m[int((fi-inset)/scale)][int((fj-inset)/scale)] {
				c = black
			}
			img.SetNRGBA(j, i, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// DataURL is toDataURL.
func DataURL(text string, o Options) (string, error) {
	b, err := PNG(text, o)
	if err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(b), nil
}
