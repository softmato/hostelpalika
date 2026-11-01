// Package idcard is lib/platform-id-card.ts for the server: one face of the ID
// card as a 1280×2000 PNG, for approval and card-issued emails. The card is an
// SVG rendered by libvips; text goes in as glyph outlines from the embedded
// Inter faces, so no host font can change it and a missing one cannot blank it.
package idcard

import (
	"embed"
	"encoding/base64"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/image/font"
	"golang.org/x/image/font/sfnt"
	"golang.org/x/image/math/fixed"

	"github.com/softmato/hostelpalika/server/internal/platform/images"
)

const (
	cardWidth  = 640.0
	cardHeight = 1000.0
	scale      = 2

	ink      = "#04301c"
	brand    = "#0a8a4b"
	accent   = "#48c98a"
	paper    = "#ffffff"
	muted    = "#5d6f66"
	hairline = "#d9e5dd"
)

// Data is IdCardData; images are raw bytes (a bad one degrades the card, as TS).
type Data struct {
	BloodGroup, BrandName, CardType, DateOfBirth, Email, FullName string
	IssuedOn, Phone, ResidentID, Role, Signature, SiteLabel       string
	Photo, QR, SignatureImage                                     []byte
}

type variant struct {
	accent      string
	bulgeBack   float64
	bulgeFront  float64
	backBullets []string
	idLabel     string
	logo        string
	title       string
}

var variants = map[string]variant{
	"HOSTEL_OWNER": {"#2fae72", 30, 44, []string{
		"Show this card to confirm you are the registered owner of your hostel on the platform.",
		"No hostel or resident detail is stored in the code itself — it only carries your platform ID.",
		"Report a lost card from your account menu and the ID stops resolving straight away.",
	}, "OWNER ID", "building", "HOSTEL OWNER IDENTITY CARD"},
	"RESIDENT": {accent, 74, 105, []string{
		"Show the QR code to a hostel and they can fill your registration without asking you to write anything down.",
		"No personal detail is stored in the code itself — it only carries your resident ID.",
		"Turn sharing off from your account menu and the ID stops opening your details straight away.",
	}, "RESIDENT ID", "house", "RESIDENT IDENTITY CARD"},
	"SERVICE_PROVIDER": {"#6fdda6", 0, 0, []string{
		"Show this card when you arrive for a job so the hostel can confirm you are a verified provider.",
		"No job or resident detail is stored in the code itself — it only carries your platform ID.",
		"Hostels send you jobs in the provider mobile app you signed in to with this ID.",
	}, "PROVIDER ID", "tools", "SERVICE PROVIDER IDENTITY CARD"},
}

//go:embed fonts/*.ttf
var fontFiles embed.FS

var (
	loadFonts sync.Once
	faces     map[int]*sfnt.Font
	kerns     map[*sfnt.Font]*kerning
	loadErr   error
)

func fontsReady() error {
	loadFonts.Do(func() {
		faces = map[int]*sfnt.Font{}
		kerns = map[*sfnt.Font]*kerning{}
		for weight, name := range map[int]string{500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold"} {
			b, err := fontFiles.ReadFile("fonts/Inter-" + name + ".ttf")
			if err == nil {
				faces[weight], err = sfnt.Parse(b)
			}
			if err != nil {
				loadErr = err
				return
			}
			kerns[faces[weight]] = parseKerning(b)
		}
	})
	return loadErr
}

type canvas struct {
	b   strings.Builder
	buf sfnt.Buffer
	ids int
}

func num(v float64) string { return strconv.FormatFloat(v, 'f', 3, 64) }

func (c *canvas) raw(format string, a ...any) { fmt.Fprintf(&c.b, format, a...) }

const unitsPPEM = 2048

// advance is one rune's width in em units, with the kerning to the next rune.
func (c *canvas) advance(f *sfnt.Font, r, next rune) (sfnt.GlyphIndex, float64) {
	g, _ := f.GlyphIndex(&c.buf, r)
	adv, _ := f.GlyphAdvance(&c.buf, g, fixed.I(unitsPPEM), font.HintingNone)
	w := float64(adv) / 64 / unitsPPEM
	if next != 0 {
		n, _ := f.GlyphIndex(&c.buf, next)
		w += float64(kerns[f].pair(g, n)) / float64(f.UnitsPerEm())
	}
	return g, w
}

// measure is measureText: canvas letterSpacing adds after every character.
func (c *canvas) measure(text string, weight int, size, spacing float64) float64 {
	f := faces[weight]
	rs := []rune(text)
	w := 0.0
	for i, r := range rs {
		next := rune(0)
		if i+1 < len(rs) {
			next = rs[i+1]
		}
		_, a := c.advance(f, r, next)
		w += a*size + spacing
	}
	return w
}

// text is fillText. align: "left" or "center".
func (c *canvas) text(s string, x, y float64, weight int, size, spacing float64, align, color string) {
	f := faces[weight]
	if align == "center" {
		x -= c.measure(s, weight, size, spacing) / 2
	}
	k := size / unitsPPEM
	rs := []rune(s)
	c.raw(`<g fill="%s">`, color)
	for i, r := range rs {
		next := rune(0)
		if i+1 < len(rs) {
			next = rs[i+1]
		}
		g, a := c.advance(f, r, next)
		if segs, err := f.LoadGlyph(&c.buf, g, fixed.I(unitsPPEM), nil); err == nil && len(segs) > 0 {
			c.raw(`<path transform="translate(%s %s) scale(%s)" d="`, num(x), num(y), strconv.FormatFloat(k, 'f', 6, 64))
			pt := func(p fixed.Point26_6) string { return num(float64(p.X)/64) + " " + num(float64(p.Y)/64) }
			for _, seg := range segs {
				switch seg.Op {
				case sfnt.SegmentOpMoveTo:
					c.raw("Z M%s", pt(seg.Args[0]))
				case sfnt.SegmentOpLineTo:
					c.raw("L%s", pt(seg.Args[0]))
				case sfnt.SegmentOpQuadTo:
					c.raw("Q%s %s", pt(seg.Args[0]), pt(seg.Args[1]))
				case sfnt.SegmentOpCubeTo:
					c.raw("C%s %s %s", pt(seg.Args[0]), pt(seg.Args[1]), pt(seg.Args[2]))
				}
			}
			c.raw(`Z"/>`)
		}
		x += a*size + spacing
	}
	c.raw(`</g>`)
}

// ellipsize truncates with an ellipsis so a long email can never run off the card.
func (c *canvas) ellipsize(s string, weight int, size, spacing, maxWidth float64) string {
	if c.measure(s, weight, size, spacing) <= maxWidth {
		return s
	}
	rs := []rune(s)
	for len(rs) > 1 && c.measure(string(rs)+"…", weight, size, spacing) > maxWidth {
		rs = rs[:len(rs)-1]
	}
	return string(rs) + "…"
}

func (c *canvas) wrap(s string, weight int, size, maxWidth float64) []string {
	var lines []string
	line := ""
	for _, word := range strings.Fields(s) {
		candidate := word
		if line != "" {
			candidate = line + " " + word
		}
		if c.measure(candidate, weight, size, 0) > maxWidth && line != "" {
			lines = append(lines, line)
			line = word
		} else {
			line = candidate
		}
	}
	if line != "" {
		lines = append(lines, line)
	}
	return lines
}

func (c *canvas) line(x1, y1, x2, y2, width float64, color, extra string) {
	c.raw(`<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="%s" stroke-width="%s" %s/>`, num(x1), num(y1), num(x2), num(y2), color, num(width), extra)
}

func (c *canvas) circle(x, y, r float64, attrs string) {
	c.raw(`<circle cx="%s" cy="%s" r="%s" %s/>`, num(x), num(y), num(r), attrs)
}

func (c *canvas) headerSweep(edge, bulge float64, color string) {
	w := cardWidth
	c.raw(`<path fill="%s" d="M0 0L%s 0L%s %sC%s %s %s %s 0 %sZ"/>`, ink, num(w), num(w), num(edge), num(w*0.72), num(edge+bulge), num(w*0.28), num(edge+bulge), num(edge))
	c.raw(`<path fill="none" stroke="%s" stroke-width="6" d="M0 %sC%s %s %s %s %s %s"/>`, color, num(edge+20), num(w*0.28), num(edge+bulge+20), num(w*0.72), num(edge+bulge+20), num(w), num(edge+20))
}

func (c *canvas) footerSweep(edge float64) {
	w := cardWidth
	c.raw(`<path fill="%s" d="M0 %sL0 %sC%s %s %s %s %s %sL%s %sZ"/>`, ink, num(cardHeight), num(edge+40), num(w*0.28), num(edge-30), num(w*0.72), num(edge-30), num(w), num(edge+40), num(w), num(cardHeight))
}

func (c *canvas) logo(cx, cy, size float64, v variant) {
	c.raw(`<g transform="translate(%s %s) scale(%s)">`, num(cx-size/2), num(cy-size/2), num(size/24))
	switch v.logo {
	case "building":
		c.raw(`<path fill="%s" d="M4 4h7v17h-7zM13 9h7v12h-7z"/><rect x="6" y="14" width="3" height="7" fill="%s"/>`, v.accent, ink)
	case "tools":
		c.raw(`<path fill="%s" d="M4 18L14 8L17 11L7 21Z"/>`, v.accent)
		c.circle(18, 7, 4.5, `fill="`+v.accent+`"`)
		c.circle(19.5, 5.5, 2, `fill="`+ink+`"`)
	default:
		c.raw(`<path fill="%s" d="M3 9.5L12 3L21 9.5L21 20Q21 21 20 21L14 21L14 14L10 14L10 21L4 21Q3 21 3 20Z"/>`, v.accent)
	}
	c.raw(`</g>`)
}

func (c *canvas) lockup(centerY float64, name string, v variant) {
	c.logo(cardWidth/2, centerY, 44, v)
	c.text(c.ellipsize(strings.ToUpper(name), 800, 30, 3, cardWidth-80), cardWidth/2, centerY+60, 800, 30, 3, "center", paper)
	c.text(c.ellipsize(v.title, 600, 14, 2, cardWidth-80), cardWidth/2, centerY+88, 600, 14, 2, "center", v.accent)
}

func initials(name string) string {
	parts := strings.Fields(name)
	first, last := "", ""
	if len(parts) > 0 {
		first = string([]rune(parts[0])[:1])
	}
	if len(parts) > 1 {
		last = string([]rune(parts[len(parts)-1])[:1])
	}
	if out := strings.ToUpper(first + last); out != "" {
		return out
	}
	return "?"
}

func dataURI(png []byte) string {
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
}

func (c *canvas) portrait(d Data, v variant, cx, cy, r float64) {
	c.circle(cx, cy, r+11, `fill="`+paper+`"`)
	c.ids++
	id := "p" + strconv.Itoa(c.ids)
	c.raw(`<clipPath id="%s"><circle cx="%s" cy="%s" r="%s"/></clipPath><g clip-path="url(#%s)">`, id, num(cx), num(cy), num(r), id)
	if png, w, h, err := images.Rasterize(d.Photo); err == nil && w > 0 {
		// Cover-crop: fill the circle without ever squashing a face.
		side := math.Min(float64(w), float64(h))
		k := r * 2 / side
		c.raw(`<image x="%s" y="%s" width="%s" height="%s" preserveAspectRatio="none" href="%s"/>`, num(cx-float64(w)*k/2), num(cy-float64(h)*k/2), num(float64(w)*k), num(float64(h)*k), dataURI(png))
	} else {
		c.raw(`<rect x="%s" y="%s" width="%s" height="%s" fill="#e4f2ea"/>`, num(cx-r), num(cy-r), num(r*2), num(r*2))
		size := r * 0.8
		// textBaseline "middle": halfway between the face's ascent and descent.
		c.text(initials(d.FullName), cx, cy+2+size*middleShift, 800, size, 0, "center", brand)
	}
	c.raw(`</g>`)
	c.circle(cx, cy, r+9, `fill="none" stroke="`+v.accent+`" stroke-width="4"`)
}

// middleShift is Inter's (ascent - descent) / 2 in em, Skia's middle baseline.
const middleShift = 0.3636

func dash(s string) string {
	if s == "" {
		return "—"
	}
	return s
}

func (c *canvas) front(d Data, v variant) {
	c.headerSweep(262, v.bulgeFront, v.accent)
	c.lockup(96, d.BrandName, v)
	c.portrait(d, v, cardWidth/2, 322, 94)
	c.text(c.ellipsize(d.FullName, 800, 38, 0, cardWidth-80), cardWidth/2, 478, 800, 38, 0, "center", ink)
	c.text(c.ellipsize(strings.ToUpper(d.Role), 700, 19, 2, cardWidth-96), cardWidth/2, 510, 700, 19, 2, "center", brand)
	c.line(120, 538, cardWidth-120, 538, 2, hairline, "")
	const labelX, valueX = 78.0, 232.0
	y := 578.0
	for _, row := range [][2]string{{"ID NO", d.ResidentID}, {"DOB", dash(d.DateOfBirth)}, {"BLOOD", dash(d.BloodGroup)}, {"PHONE", dash(d.Phone)}, {"E-MAIL", dash(d.Email)}} {
		c.text(row[0], labelX, y, 800, 17, 0, "left", brand)
		c.text(":", valueX-16, y, 600, 17, 0, "left", muted)
		c.text(c.ellipsize(row[1], 600, 17, 0, cardWidth-valueX-70), valueX, y, 600, 17, 0, "left", ink)
		y += 38
	}
	const qrSize, qrY = 158.0, 752.0
	qrX := (cardWidth - qrSize) / 2
	c.raw(`<rect x="%s" y="%s" width="%s" height="%s" rx="16" ry="16" fill="%s" stroke="%s" stroke-width="2"/>`, num(qrX-12), num(qrY-12), num(qrSize+24), num(qrSize+24), paper, hairline)
	if png, _, _, err := images.Rasterize(d.QR); err == nil {
		c.raw(`<image x="%s" y="%s" width="%s" height="%s" preserveAspectRatio="none" href="%s"/>`, num(qrX), num(qrY), num(qrSize), num(qrSize), dataURI(png))
	}
	c.footerSweep(946)
	c.text("SCAN TO SHARE MY DETAILS", cardWidth/2, qrY+qrSize+42, 600, 14, 1, "center", paper)
}

var signaturePoint = regexp.MustCompile(`([ML])(\d+) (\d+)`)

const sigX, sigY, sigW, sigH = 338.0, 726.0, 240.0, 80.0

func (c *canvas) signature(value string) {
	const padW, padH = 600.0, 200.0
	k := math.Min(sigW/padW, sigH/padH)
	ox, oy := sigX+(sigW-padW*k)/2, sigY+(sigH-padH*k)/2
	var strokes [][][2]float64
	for _, m := range signaturePoint.FindAllStringSubmatch(value, -1) {
		x, _ := strconv.ParseFloat(m[2], 64)
		y, _ := strconv.ParseFloat(m[3], 64)
		if m[1] == "M" || len(strokes) == 0 {
			strokes = append(strokes, [][2]float64{{x, y}})
		} else {
			strokes[len(strokes)-1] = append(strokes[len(strokes)-1], [2]float64{x, y})
		}
	}
	if len(strokes) == 0 {
		return
	}
	var path strings.Builder
	for _, st := range strokes {
		fmt.Fprintf(&path, "M%s %s", num(ox+st[0][0]*k), num(oy+st[0][1]*k))
		if len(st) == 1 { // a tap is a dot, not nothing
			fmt.Fprintf(&path, "L%s %s", num(ox+(st[0][0]+0.5)*k), num(oy+st[0][1]*k))
		}
		for _, p := range st[1:] {
			fmt.Fprintf(&path, "L%s %s", num(ox+p[0]*k), num(oy+p[1]*k))
		}
	}
	c.raw(`<path fill="none" stroke="%s" stroke-width="%s" stroke-linecap="round" stroke-linejoin="round" d="%s"/>`, ink, num(math.Max(1.5, 5*k)), path.String())
}

func (c *canvas) back(d Data, v variant) {
	c.headerSweep(168, v.bulgeBack, v.accent)
	c.lockup(62, d.BrandName, v)
	c.text("HOW THIS CARD WORKS", 62, 336, 800, 20, 1, "left", brand)
	y := 380.0
	for _, bullet := range v.backBullets {
		c.circle(70, y-6, 6, `fill="`+v.accent+`"`)
		for _, line := range c.wrap(bullet, 500, 16, cardWidth-160) {
			c.text(line, 92, y, 500, 16, 0, "left", muted)
			y += 24
		}
		y += 18
	}
	c.line(62, y+6, cardWidth-62, y+6, 2, hairline, "")
	c.text(v.idLabel, 62, y+58, 800, 14, 2, "left", brand)
	c.text(d.ResidentID, 62, y+96, 800, 30, 2, "left", ink)
	c.text("Issued "+d.IssuedOn, 62, y+126, 500, 15, 0, "left", muted)
	if png, w, h, err := images.Rasterize(d.SignatureImage); err == nil && w > 0 {
		k := math.Min(sigW/float64(w), sigH/float64(h))
		dw, dh := float64(w)*k, float64(h)*k
		c.raw(`<image x="%s" y="%s" width="%s" height="%s" preserveAspectRatio="none" href="%s"/>`, num(sigX+(sigW-dw)/2), num(sigY+(sigH-dh)/2), num(dw), num(dh), dataURI(png))
	} else {
		c.signature(d.Signature)
	}
	c.line(sigX, 812, sigX+sigW, 812, 2, hairline, `stroke-dasharray="10 8"`)
	c.text("Cardholder signature", sigX, 838, 600, 14, 0, "left", muted)
	c.text(d.SiteLabel, 62, 892, 700, 15, 0, "left", ink)
	c.footerSweep(946)
}

// Render is renderIdCardPng for face "front" or "back". The caller decides what a
// failure costs; a card is an attachment, so TS callers send the mail without it.
func Render(d Data, face string) ([]byte, error) {
	if err := fontsReady(); err != nil {
		return nil, err
	}
	v, ok := variants[d.CardType]
	if !ok {
		v = variants["RESIDENT"]
	}
	c := &canvas{}
	c.raw(`<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 640 1000"><clipPath id="card"><rect width="640" height="1000" rx="30" ry="30"/></clipPath><g clip-path="url(#card)"><rect width="640" height="1000" fill="%s"/>`, int(cardWidth)*scale, int(cardHeight)*scale, paper)
	if face == "back" {
		c.back(d, v)
	} else {
		c.front(d, v)
	}
	c.raw(`</g></svg>`)
	return images.SVGToPNG([]byte(strings.ReplaceAll(c.b.String(), `d="Z M`, `d="M`)))
}
