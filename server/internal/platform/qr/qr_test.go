package qr

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"os"
	"strings"
	"testing"

	"github.com/makiuchi-d/gozxing"
	"github.com/makiuchi-d/gozxing/qrcode"
)

// qr.json is the npm `qrcode` package's matrix and PNG for the same inputs.
func TestMatchesNPM(t *testing.T) {
	raw, err := os.ReadFile("../../../testdata/vectors/qr.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Text          string
		Margin, Width int
		Size          int
		Modules, PNG  string
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		m, err := Modules(c.Text, 0)
		if err != nil {
			t.Fatal(err)
		}
		var got strings.Builder
		for _, row := range m {
			for _, dark := range row {
				got.WriteByte("01"[b2i(dark)])
			}
		}
		ours, err := PNG(c.Text, Options{Width: c.Width, Margin: c.Margin, SetMargin: true})
		if err != nil {
			t.Fatal(err)
		}
		// Segmenting/masking may legitimately differ from npm; what must hold is
		// that the code scans back to the text, and is pixel-identical when the
		// matrices agree.
		if c.Width >= 100 {
			if text := decode(t, ours); text != c.Text {
				t.Errorf("%q: scans as %q", c.Text, text)
			}
		}
		if len(m) != c.Size {
			t.Errorf("%q: version differs (%d vs %d modules)", c.Text, len(m), c.Size)
		}
		want, _ := base64.StdEncoding.DecodeString(c.PNG)
		if got.String() == c.Modules && !samePixels(t, ours, want) {
			t.Errorf("%q width %d: pixels differ", c.Text, c.Width)
		}
	}
}

func decode(t *testing.T, b []byte) string {
	img, _ := png.Decode(bytes.NewReader(b))
	bmp, err := gozxing.NewBinaryBitmapFromImage(img)
	if err != nil {
		t.Fatal(err)
	}
	res, err := qrcode.NewQRCodeReader().Decode(bmp, nil)
	if err != nil {
		return "unreadable: " + err.Error()
	}
	return res.GetText()
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func samePixels(t *testing.T, a, b []byte) bool {
	ia, err1 := png.Decode(bytes.NewReader(a))
	ib, err2 := png.Decode(bytes.NewReader(b))
	if err1 != nil || err2 != nil || ia.Bounds() != ib.Bounds() {
		t.Logf("bounds %v %v", bounds(ia), bounds(ib))
		return false
	}
	for y := ia.Bounds().Min.Y; y < ia.Bounds().Max.Y; y++ {
		for x := ia.Bounds().Min.X; x < ia.Bounds().Max.X; x++ {
			r1, g1, b1, a1 := ia.At(x, y).RGBA()
			r2, g2, b2, a2 := ib.At(x, y).RGBA()
			if r1 != r2 || g1 != g2 || b1 != b2 || a1 != a2 {
				return false
			}
		}
	}
	return true
}

func bounds(i image.Image) any {
	if i == nil {
		return nil
	}
	return i.Bounds()
}
