package pdf

import (
	"strings"
	"unicode/utf8"
)

// The document theme (modules/billing/documents/theme.ts).
var (
	MarginTop, MarginBottom, MarginLeft, MarginRight = 56.0, 56.0, 52.0, 52.0
	ContentWidth                                     = PageWidth - MarginLeft - MarginRight

	ColorAccent     = RGB{0.039, 0.541, 0.294}
	ColorLabel      = RGB{0, 0, 0}
	ColorRule       = RGB{0.851, 0.839, 0.816}
	ColorRuleStrong = RGB{0.11, 0.11, 0.11}
	ColorMuted      = RGB{0, 0, 0}
	ColorText       = RGB{0.106, 0.106, 0.106}
)

const (
	SizeAmount    = 26.0
	SizeBody      = 9.5
	SizeEyebrow   = 7.0
	SizeFootnote  = 7.5
	SizeIssuer    = 12.5
	SizeLabel     = 8.5
	SizeTitle     = 13.0
	SizePartyName = 11.0

	SpaceBlock = 34.0
	SpaceLine  = 18.0
	SpaceRule  = 26.0
	SpaceTight = 15.0

	TrackingEyebrow = 1.4
	TrackingTitle   = 3.4
)

// Anchor places text against the margins instead of at an x.
type Anchor int

const (
	AtX Anchor = iota
	Right
	Center
)

// Style is TextOptions; zero values take the defaults (Regular, SizeBody, ColorText).
type Style struct {
	Font     Font
	Size     float64
	Color    *RGB
	Tracking float64
}

func (s Style) size() float64 {
	if s.Size == 0 {
		return SizeBody
	}
	return s.Size
}

func (s Style) color() RGB {
	if s.Color == nil {
		return ColorText
	}
	return *s.Color
}

// Cursor is layout.ts's Cursor: a y that walks down the page.
type Cursor struct {
	Doc *Doc
	y   float64
}

func NewCursor(d *Doc) *Cursor { return &Cursor{Doc: d, y: PageHeight - MarginTop} }

func (c *Cursor) Top() float64       { return c.y }
func (c *Cursor) Remaining() float64 { return c.y - MarginBottom }

func (c *Cursor) Down(points float64) *Cursor { c.y -= points; return c }
func (c *Cursor) To(y float64) *Cursor        { c.y = y; return c }

// Width measures, counting tracking between glyphs.
func (c *Cursor) Width(text string, s Style) float64 {
	base := c.Doc.Width(text, s.Font, s.size())
	if s.Tracking != 0 {
		return base + s.Tracking*float64(max(0, utf8.RuneCountInString(text)-1))
	}
	return base
}

// Text draws at x (or an anchor) on the current line and returns the width drawn.
func (c *Cursor) Text(anchor Anchor, x float64, value string, s Style) float64 {
	left := x
	switch anchor {
	case Right:
		left = PageWidth - MarginRight - c.Width(value, s)
	case Center:
		left = (PageWidth - c.Width(value, s)) / 2
	}
	if s.Tracking == 0 {
		c.Doc.Text(left, c.y, value, s.Font, s.size(), s.color())
		return c.Width(value, s)
	}
	pen := left
	for _, glyph := range value {
		g := string(glyph)
		c.Doc.Text(pen, c.y, g, s.Font, s.size(), s.color())
		pen += c.Doc.Width(g, s.Font, s.size()) + s.Tracking
	}
	return pen - left - s.Tracking
}

// Line draws and moves down one line of its size.
func (c *Cursor) Line(anchor Anchor, x float64, value string, s Style) *Cursor {
	c.Text(anchor, x, value, s)
	return c.Down(s.size() + 4.5)
}

// FieldOptions are field()'s options; LabelX 0 means the left margin.
type FieldOptions struct {
	LabelX     float64
	Suffix     string
	ValueColor *RGB
	ValueFont  *Font
}

// Field is a label on the left and a value (mono) flush right.
func (c *Cursor) Field(label, value string, o FieldOptions) *Cursor {
	labelX := o.LabelX
	if labelX == 0 {
		labelX = MarginLeft
	}
	c.Text(AtX, labelX, label, Style{Color: &ColorLabel, Size: SizeLabel})
	font := Mono
	if o.ValueFont != nil {
		font = *o.ValueFont
	}
	valueWidth := c.Width(value, Style{Font: font, Size: SizeBody})
	suffixWidth := 0.0
	if o.Suffix != "" {
		suffixWidth = c.Width(" "+o.Suffix, Style{Size: SizeFootnote})
	}
	start := PageWidth - MarginRight - valueWidth - suffixWidth
	c.Text(AtX, start, value, Style{Font: font, Size: SizeBody, Color: o.ValueColor})
	if o.Suffix != "" {
		c.Text(AtX, start+valueWidth, " "+o.Suffix, Style{Color: &ColorMuted, Size: SizeFootnote})
	}
	return c.Down(SpaceLine)
}

func (c *Cursor) Eyebrow(anchor Anchor, x float64, value string) *Cursor {
	c.Text(anchor, x, strings.ToUpper(value), Style{Color: &ColorLabel, Size: SizeEyebrow, Tracking: TrackingEyebrow})
	return c.Down(SpaceTight)
}

func (c *Cursor) Title(anchor Anchor, x float64, value string) *Cursor {
	c.Text(anchor, x, strings.ToUpper(value), Style{Size: SizeTitle, Tracking: TrackingTitle})
	return c.Down(SizeTitle + 6)
}

// RuleOptions are rule()'s; zero values take the defaults.
type RuleOptions struct {
	Color     *RGB
	Thickness float64
	Width     float64
}

func (c *Cursor) Rule(o RuleOptions) *Cursor {
	width, thickness, color := o.Width, o.Thickness, ColorRule
	if width == 0 {
		width = PageWidth - MarginLeft - MarginRight
	}
	if thickness == 0 {
		thickness = 0.6
	}
	if o.Color != nil {
		color = *o.Color
	}
	c.Doc.Line(MarginLeft, c.y, MarginLeft+width, c.y, thickness, color)
	return c.Down(SpaceRule)
}

func (c *Cursor) RuleStrong() *Cursor {
	return c.Rule(RuleOptions{Color: &ColorRuleStrong, Thickness: 1.1})
}

// StampOptions are stamp()'s; zero values take the defaults.
type StampOptions struct {
	Color             *RGB
	Right, Top, Width float64
}

// Stamp is a bordered, tracked mono label (PAID, VOID); the cursor does not move.
func (c *Cursor) Stamp(value string, o StampOptions) (width, height float64) {
	color := ColorAccent
	if o.Color != nil {
		color = *o.Color
	}
	label := strings.ToUpper(value)
	style := Style{Font: Mono, Size: SizeLabel, Tracking: TrackingEyebrow, Color: &color}
	textWidth := c.Width(label, style)
	width, height = o.Width, 30
	if width == 0 {
		width = textWidth + 34
	}
	top, right := o.Top, o.Right
	if top == 0 {
		top = c.y
	}
	if right == 0 {
		right = PageWidth - MarginRight
	}
	c.Doc.Rect(right-width, top-height, width, height, &color, 0.9, nil)
	saved := c.y
	c.To(top - height + (height-SizeLabel)/2 + 1.5)
	c.Text(AtX, right-width+(width-textWidth)/2, label, style)
	c.To(saved)
	return width, height
}
