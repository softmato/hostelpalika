// Package pdftest compares generated PDFs with the TS goldens by what they
// draw: every glyph's character, font, size and position, and every rectangle.
// Byte equality is impossible across PDF writers; this is what a reader sees.
package pdftest

import (
	"bytes"
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/ledongthuc/pdf"
)

// Glyph is one drawn character.
type Glyph struct {
	Page       int
	Font       string
	Size, X, Y float64
	S          string
}

// Glyphs reads every drawn character, page by page, in reading order.
func Glyphs(b []byte) ([]Glyph, error) {
	r, err := pdf.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		return nil, err
	}
	var out []Glyph
	for p := 1; p <= r.NumPage(); p++ {
		page := r.Page(p)
		if page.V.IsNull() {
			continue
		}
		for _, t := range page.Content().Text {
			if strings.TrimSpace(t.S) == "" {
				continue // writers differ on whether a space is its own run
			}
			// Subset/alias prefixes aside, the base font is what must match.
			font := t.Font
			if i := strings.Index(font, "+"); i >= 0 {
				font = font[i+1:]
			}
			out = append(out, Glyph{p, font, round(t.FontSize), round(t.X), round(t.Y), t.S})
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Page != b.Page {
			return a.Page < b.Page
		}
		if a.Y != b.Y {
			return a.Y > b.Y
		}
		return a.X < b.X
	})
	return out, nil
}

func round(v float64) float64 { return math.Round(v*100) / 100 }

// Diff is "" when both PDFs draw the same glyphs within tolerance points.
func Diff(got, want []byte, tolerance float64) string {
	g, err := Glyphs(got)
	if err != nil {
		return "got: " + err.Error()
	}
	w, err := Glyphs(want)
	if err != nil {
		return "want: " + err.Error()
	}
	var report []string
	for i := 0; i < max(len(g), len(w)); i++ {
		switch {
		case i >= len(g):
			report = append(report, fmt.Sprintf("missing %+v", w[i]))
		case i >= len(w):
			report = append(report, fmt.Sprintf("extra %+v", g[i]))
		case g[i].S != w[i].S || g[i].Font != w[i].Font || g[i].Size != w[i].Size || g[i].Page != w[i].Page ||
			math.Abs(g[i].X-w[i].X) > tolerance || math.Abs(g[i].Y-w[i].Y) > tolerance:
			report = append(report, fmt.Sprintf("got %+v\nwant %+v", g[i], w[i]))
		}
		if len(report) >= 8 {
			break
		}
	}
	return strings.Join(report, "\n")
}
