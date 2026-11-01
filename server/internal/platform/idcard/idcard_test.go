package idcard

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"math"
	"os"
	"strings"
	"testing"
)

type goldenCase struct {
	Name, Face, CardType, FullName, Email, Signature string
	Photo, QR                                        bool
}

// maxMeanDiff is the mean per-channel difference (0-255) a card may have from
// the @napi-rs/canvas render: Skia and librsvg antialias differently. Blank text
// scored about 4; a wrapped line about 1.9. Tighten, never loosen.
const maxMeanDiff = 0.8

func TestMatchesCanvas(t *testing.T) {
	raw, err := os.ReadFile("../../../testdata/golden/idcard/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []goldenCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	asset := func(name string) []byte {
		b, err := os.ReadFile("../../../testdata/golden/idcard/" + name)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			d := Data{BloodGroup: "O+", BrandName: "HostelPalika", CardType: tc.CardType, DateOfBirth: "12 Mar 2001", Email: tc.Email, FullName: tc.FullName, IssuedOn: "01 Aug 2026",
				Phone: "+977-9800000000", ResidentID: "HH-4K7M-9XQ2", Role: "Resident", Signature: tc.Signature, SiteLabel: "hostelpalika.com"}
			if tc.Photo {
				d.Photo = asset("photo.png")
			}
			if tc.QR {
				d.QR = asset("qr.png")
			}
			got, err := Render(d, tc.Face)
			if err != nil {
				t.Fatal(err)
			}
			if os.Getenv("IDCARD_WRITE") != "" {
				_ = os.WriteFile(os.TempDir()+"/idcard-"+tc.Name+".png", got, 0o644)
			}
			if diff := meanDiff(t, got, asset(tc.Name+".png")); diff > maxMeanDiff {
				t.Errorf("mean difference %.2f, want <= %.1f", diff, maxMeanDiff)
			} else {
				t.Logf("mean difference %.2f", diff)
			}
		})
	}
}

func decode(t *testing.T, b []byte) image.Image {
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	return img
}

func meanDiff(t *testing.T, a, b []byte) float64 {
	ia, ib := decode(t, a), decode(t, b)
	if ia.Bounds() != ib.Bounds() {
		t.Fatalf("size %v, want %v", ia.Bounds(), ib.Bounds())
	}
	var sum float64
	r := ia.Bounds()
	for y := r.Min.Y; y < r.Max.Y; y++ {
		for x := r.Min.X; x < r.Max.X; x++ {
			r1, g1, b1, a1 := ia.At(x, y).RGBA()
			r2, g2, b2, a2 := ib.At(x, y).RGBA()
			sum += math.Abs(float64(r1)-float64(r2)) + math.Abs(float64(g1)-float64(g2)) + math.Abs(float64(b1)-float64(b2)) + math.Abs(float64(a1)-float64(a2))
		}
	}
	return sum / 257 / 4 / float64(r.Dx()*r.Dy())
}

func TestEverythingOutlined(t *testing.T) {
	got, err := Render(Data{BrandName: "H", FullName: "Asha Gurung", ResidentID: "X", Role: "Resident", IssuedOn: "x", SiteLabel: "x"}, "front")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(got, []byte("\x89PNG")) {
		t.Fatal("not a PNG")
	}
	if initials("  ") != "?" || initials("asha bahadur gurung") != "AG" || !strings.HasPrefix(dash(""), "—") {
		t.Error("initials or dash")
	}
}
