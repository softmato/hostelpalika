// Package pdf is the drawing layer every generated document stands on: the
// pdf-lib calls the TS documents make (standard Helvetica/Courier, text at a
// baseline, lines, rectangles, PNG images), in pdf-lib's coordinates — points,
// origin bottom-left — plus the shared Cursor and theme from
// modules/billing/documents/{layout,theme}.ts.
//
// pdf-lib's StandardFonts and fpdf's core fonts are the same Adobe AFM metrics
// with WinAnsi encoding, so measured widths, and therefore every computed x,
// match. Each document type is ported with its module and golden-tested against
// the TS output with Ops (testdata/golden/pdf).
package pdf

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/go-pdf/fpdf"
)

// A4 in points, as pdf-lib's PageSizes.A4.
const (
	PageWidth  = 595.28
	PageHeight = 841.89
)

// Font is one of the four standard faces the documents use.
type Font int

const (
	Regular  Font = iota // Helvetica
	Bold                 // Helvetica-Bold
	Mono                 // Courier
	MonoBold             // Courier-Bold
)

func (f Font) family() (string, string) {
	switch f {
	case Bold:
		return "Helvetica", "B"
	case Mono:
		return "Courier", ""
	case MonoBold:
		return "Courier", "B"
	}
	return "Helvetica", ""
}

// RGB is pdf-lib's rgb(r, g, b), components 0-1.
type RGB struct{ R, G, B float64 }

func (c RGB) ints() (int, int, int) {
	return int(c.R*255 + 0.5), int(c.G*255 + 0.5), int(c.B*255 + 0.5)
}

// Doc is one PDF being drawn. Not safe for concurrent use.
type Doc struct {
	f      *fpdf.Fpdf
	encode func(string) string
	images int
}

// New starts a document with one A4 page.
func New() *Doc {
	f := fpdf.NewCustom(&fpdf.InitType{UnitStr: "pt", Size: fpdf.SizeType{Wd: PageWidth, Ht: PageHeight}})
	f.SetMargins(0, 0, 0)
	f.SetAutoPageBreak(false, 0)
	f.SetCompression(true)
	f.SetCreator("HostelPalika", true)
	d := &Doc{f: f, encode: f.UnicodeTranslatorFromDescriptor("cp1252")}
	f.AddPage()
	return d
}

// AddPage starts another A4 page; drawing continues on it.
func (d *Doc) AddPage() { d.f.AddPage() }

// Width is widthOfTextAtSize: AFM advance widths plus pdf-lib's kerning
// pairs (it kerns when measuring, not when drawing).
func (d *Doc) Width(s string, font Font, size float64) float64 {
	family, style := font.family()
	d.f.SetFont(family, style, size)
	w := d.f.GetStringWidth(d.encode(s))
	if pairs := kerning[font]; pairs != nil {
		runes := []rune(s)
		for i := 1; i < len(runes); i++ {
			w += float64(pairs[string(runes[i-1:i+1])]) * size / 1000
		}
	}
	return w
}

// kerning.json is pdf-lib's pair table for Helvetica and Helvetica-Bold
// (Courier has none), written by testdata/vectors/generate.ts.
//
//go:embed kerning.json
var kerningJSON []byte

var kerning = func() map[Font]map[string]int {
	var raw map[string]map[string]int
	if err := json.Unmarshal(kerningJSON, &raw); err != nil {
		panic(err) // generated file
	}
	return map[Font]map[string]int{Regular: raw["Helvetica"], Bold: raw["Helvetica-Bold"]}
}()

// Text draws s with its baseline at y (from the bottom), as page.drawText.
func (d *Doc) Text(x, y float64, s string, font Font, size float64, color RGB) {
	family, style := font.family()
	d.f.SetFont(family, style, size)
	d.f.SetTextColor(color.ints())
	d.f.Text(x, PageHeight-y, d.encode(s))
}

// Line is page.drawLine.
func (d *Doc) Line(x1, y1, x2, y2, thickness float64, color RGB) {
	d.f.SetLineWidth(thickness)
	d.f.SetDrawColor(color.ints())
	d.f.Line(x1, PageHeight-y1, x2, PageHeight-y2)
}

// Rect is page.drawRectangle with (x, y) its bottom-left corner. A nil fill
// draws the border only; a zero border width draws the fill only.
func (d *Doc) Rect(x, y, w, h float64, border *RGB, borderWidth float64, fill *RGB) {
	style := ""
	if fill != nil {
		d.f.SetFillColor(fill.ints())
		style += "F"
	}
	if border != nil && borderWidth > 0 {
		d.f.SetDrawColor(border.ints())
		d.f.SetLineWidth(borderWidth)
		style += "D"
	}
	if style == "" {
		return
	}
	d.f.Rect(x, PageHeight-y-h, w, h, style)
}

// PNG is page.drawImage of an embedded PNG, (x, y) its bottom-left corner.
func (d *Doc) PNG(png []byte, x, y, w, h float64) error {
	d.images++
	name := fmt.Sprintf("img%d", d.images)
	d.f.RegisterImageOptionsReader(name, fpdf.ImageOptions{ImageType: "PNG"}, bytes.NewReader(png))
	if err := d.f.Error(); err != nil {
		return err
	}
	d.f.ImageOptions(name, x, PageHeight-y-h, w, h, false, fpdf.ImageOptions{ImageType: "PNG"}, 0, "")
	return d.f.Error()
}

// Bytes finishes the document.
func (d *Doc) Bytes() ([]byte, error) {
	var buf bytes.Buffer
	if err := d.f.Output(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// Encodable reports whether every rune survives WinAnsi; pdf-lib throws on the
// rest, so callers sanitise names before drawing them.
func Encodable(s string) bool {
	for _, r := range s {
		if r > 0xff && !strings.ContainsRune("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ", r) {
			return false
		}
	}
	return true
}
