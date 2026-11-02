package hostels

import (
	"bytes"
	"image/png"
	"regexp"
	"strconv"
	"strings"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/pdf"
)

// Distances from the top of the page, where the letterhead's parts sit.
const (
	agreementBodyTop     = 198.0
	agreementSwooshEnd   = 292.0 // below this lines run the full width
	agreementBodyBottom  = 98.0  // clear of the letterhead's footer rule
	agreementPageNumberY = 80.0
	agreementBody        = 9.0
	agreementBullet      = 11.0
	agreementSignBlock   = 208.0
	agreementPreview     = "PREVIEW - not issued"
)

// agreementSwoosh is the swoosh's left edge, top-down from where the body starts.
var agreementSwoosh = [][2]float64{{0, 404}, {16, 424}, {40, 455}, {64, 492}, {88, 534}, {96, 545}}

// rightEdge is how far right a line whose glyph tops sit at fromTop may run.
func rightEdge(fromTop float64) float64 {
	full := pdf.PageWidth - pdf.MarginRight
	offset := fromTop - 184
	last := agreementSwoosh[len(agreementSwoosh)-1]
	if offset >= last[0] {
		return full
	}
	if offset <= 0 {
		return agreementSwoosh[0][1]
	}
	for i := 1; i < len(agreementSwoosh); i++ {
		if agreementSwoosh[i][0] >= offset {
			a, b := agreementSwoosh[i-1], agreementSwoosh[i]
			x := a[1] + (b[1]-a[1])*(offset-a[0])/(b[0]-a[0])
			if x < full {
				return x
			}
			return full
		}
	}
	return full
}

var nonPrintable = regexp.MustCompile(`[^\x20-\x7E]`)

// agreementASCII: WinAnsi cannot draw Devanagari; a name degrades to ? rather than failing.
func agreementASCII(s string) string {
	return nonPrintable.ReplaceAllString(strings.NewReplacer("‘", "'", "’", "'", "“", `"`, "”", `"`, "–", "-", "—", "-").Replace(s), "?")
}

type printedSigner struct {
	image       []byte
	name, title string
}

type agreementPrint struct {
	record  *signatureRecord
	issuer  agreementIssuer
	signers []printedSigner
	stamp   []byte
}

func fitted(img []byte, maxW, maxH float64) (w, h float64) {
	cfg, err := png.DecodeConfig(bytes.NewReader(img))
	if err != nil || cfg.Width == 0 || cfg.Height == 0 {
		return maxW, maxH
	}
	ratio := maxW / float64(cfg.Width)
	if r := maxH / float64(cfg.Height); r < ratio {
		ratio = r
	}
	return float64(cfg.Width) * ratio, float64(cfg.Height) * ratio
}

func (in agreementPrint) render() ([]byte, error) {
	r := in.record
	d := pdf.New()
	tpl := d.ImportPage(agreementLetterhead, 1)
	d.DrawImported(tpl)
	c := pdf.NewCursor(d)
	c.To(pdf.PageHeight - agreementBodyTop)
	room := func(points float64) {
		if c.Top()-points < agreementBodyBottom {
			d.AddPage()
			d.DrawImported(tpl)
			c.To(pdf.PageHeight - agreementBodyTop)
		}
	}
	clearSwoosh := func() {
		if limit := pdf.PageHeight - agreementSwooshEnd; c.Top() > limit {
			c.To(limit)
		}
	}
	hairline := func() {
		c.Down(4)
		d.Line(pdf.MarginLeft, c.Top(), rightEdge(pdf.PageHeight-c.Top()), c.Top(), 0.6, pdf.ColorRule)
		c.Down(14)
	}
	type flowOpts struct {
		bullet bool
		color  *pdf.RGB
		font   pdf.Font
		indent float64
		size   float64
	}
	flow := func(text string, o flowOpts) {
		size := o.size
		if size == 0 {
			size = agreementBody
		}
		left := pdf.MarginLeft + o.indent
		leading := size * 1.4
		words := strings.Fields(agreementASCII(text))
		first := true
		for len(words) > 0 {
			room(leading)
			width := rightEdge(pdf.PageHeight-c.Top()-size) - left
			line := words[0]
			words = words[1:]
			for len(words) > 0 && d.Width(line+" "+words[0], o.font, size) <= width {
				line += " " + words[0]
				words = words[1:]
			}
			if first && o.bullet {
				c.Text(pdf.AtX, pdf.MarginLeft+2, "-", pdf.Style{Size: size})
			}
			c.Text(pdf.AtX, left, line, pdf.Style{Color: o.color, Font: o.font, Size: size})
			c.Down(leading)
			first = false
		}
	}
	parties := r.Parties
	ref := agreementPreview
	if r.RefCode != nil {
		ref = *r.RefCode
	}
	creator := in.issuer.ProductName
	if creator == "" {
		creator = in.issuer.LegalName
	}
	d.SetMeta(agreementTitle+" "+ref, in.issuer.LegalName, creator)

	// The heading sits left of the swoosh, like the printed agreement's.
	accent, muted := pdf.ColorAccent, pdf.ColorMuted
	c.Eyebrow(pdf.AtX, pdf.MarginLeft, "Agreement")
	c.Down(4)
	c.Line(pdf.AtX, pdf.MarginLeft, agreementTitle, pdf.Style{Color: &accent, Font: pdf.Bold, Size: 16})
	c.Line(pdf.AtX, pdf.MarginLeft, "Hostel management software and online listing", pdf.Style{Size: pdf.SizeLabel})
	c.Down(4)
	for _, row := range [][2]string{{"Agreement No.", ref}, {"Signed on", bs.DocumentBsDate(r.SignedAt) + " (" + bs.DocumentAdDate(r.SignedAt) + ")"}} {
		w := c.Text(pdf.AtX, pdf.MarginLeft, row[0]+"  ", pdf.Style{Font: pdf.Bold, Size: pdf.SizeLabel})
		c.Text(pdf.AtX, pdf.MarginLeft+w, row[1], pdf.Style{Size: pdf.SizeLabel})
		c.Down(pdf.SizeLabel + 7)
	}
	clearSwoosh()
	hairline()

	// The two parties side by side.
	top := c.Top()
	column := func(x float64, eyebrow, name string, lines []string) float64 {
		c.To(top)
		c.Eyebrow(pdf.AtX, x, eyebrow)
		c.Line(pdf.AtX, x, agreementASCII(name), pdf.Style{Font: pdf.Bold, Size: pdf.SizePartyName})
		for _, v := range lines {
			if v != "" {
				c.Line(pdf.AtX, x, agreementASCII(v), pdf.Style{Size: pdf.SizeLabel})
			}
		}
		return c.Top()
	}
	company := parties.Company
	pan := ""
	if company.Pan != "" {
		pan = "PAN: " + company.Pan
	}
	support := company.SupportPhone
	if support == "" {
		support = company.Phone
	}
	left := column(pdf.MarginLeft, "HostelPalika", company.LegalName, []string{company.Address, pan, company.Email, support})
	ownerX := pdf.MarginLeft + pdf.ContentWidth/2 + 8
	right := column(ownerX, "Hostel owner", parties.Owner.Name, []string{parties.Hostel.Name, parties.Hostel.Address, parties.Owner.Email, parties.Owner.Phone})
	if right < left {
		left = right
	}
	c.To(left)
	hairline()
	flow(agreementIntro(parties), flowOpts{})
	c.Down(6)
	for _, s := range r.Terms {
		room(agreementBody * 1.4 * 3)
		c.Down(5)
		flow(s.Heading, flowOpts{color: &accent, font: pdf.Bold, size: 9.5})
		c.Down(1)
		for _, point := range s.Points {
			flow(point, flowOpts{bullet: true, indent: agreementBullet})
		}
	}

	// Signatures: the owner's drawn one on the left, the company's approval on the right.
	room(agreementSignBlock)
	c.Down(8)
	clearSwoosh()
	boxW := pdf.ContentWidth/2 - 20
	boxH := boxW / 3 // the pad is 600 by 200
	signTop := c.Top()
	rightX := pdf.MarginLeft + pdf.ContentWidth/2 + 8
	scale := boxW / 600
	for _, stroke := range signatureStrokes(r.Signature) {
		points := make([][2]float64, len(stroke))
		for i, p := range stroke {
			points[i] = [2]float64{pdf.MarginLeft + p[0]*scale, signTop - p[1]*scale}
		}
		d.Polyline(points, 5*scale, pdf.ColorText)
	}
	line := signTop - boxH - 4
	switch {
	case r.RefCode == nil:
		c.To(signTop - boxH*0.55)
		c.Text(pdf.AtX, rightX, "Awaiting KYC approval", pdf.Style{Color: &muted, Font: pdf.Bold, Size: 10})
	case len(in.signers) == 0:
		c.To(signTop - boxH*0.55)
		c.Text(pdf.AtX, rightX, "Approved electronically", pdf.Style{Color: &accent, Font: pdf.Bold, Size: 10})
	default:
		// The founders' signatures side by side on the line, the stamp over the end of it.
		x := rightX
		for _, s := range in.signers {
			w, h := fitted(s.image, 92, 38)
			if err := d.PNG(s.image, x, line+3, w, h); err != nil {
				return nil, err
			}
			x += w + 8
		}
	}
	if r.RefCode != nil && in.stamp != nil {
		w, h := fitted(in.stamp, 74, 74)
		if err := d.PNGOpacity(in.stamp, rightX+boxW-w+4, line-12, w, h, 0.9); err != nil {
			return nil, err
		}
	}
	c.To(line)
	for _, x := range []float64{pdf.MarginLeft, rightX} {
		d.Line(x, c.Top(), x+boxW, c.Top(), 0.8, pdf.ColorRuleStrong)
	}
	c.Down(12)
	rows := c.Top()
	c.Line(pdf.AtX, pdf.MarginLeft, agreementASCII(r.SignerName), pdf.Style{Font: pdf.Bold, Size: pdf.SizeLabel})
	c.Line(pdf.AtX, pdf.MarginLeft, "Owner, "+agreementASCII(parties.Hostel.Name), pdf.Style{Size: pdf.SizeLabel})
	c.Line(pdf.AtX, pdf.MarginLeft, bs.DocumentInstant(r.SignedAt), pdf.Style{Size: pdf.SizeLabel})
	c.To(rows)
	c.Line(pdf.AtX, rightX, "For "+agreementASCII(company.LegalName), pdf.Style{Font: pdf.Bold, Size: pdf.SizeLabel})
	if len(in.signers) > 0 {
		names := make([]string, len(in.signers))
		for i, s := range in.signers {
			names[i] = s.name
		}
		c.Line(pdf.AtX, rightX, strings.Join(names, " & ")+", "+in.signers[0].title+"s", pdf.Style{Size: pdf.SizeLabel})
	}
	if r.IssuedAt != nil {
		approved := "KYC approved"
		if r.ApprovedByName != "" {
			approved = "KYC approved by " + agreementASCII(r.ApprovedByName)
		}
		c.Line(pdf.AtX, rightX, approved, pdf.Style{Size: pdf.SizeLabel})
		c.Line(pdf.AtX, rightX, bs.DocumentInstant(*r.IssuedAt), pdf.Style{Size: pdf.SizeLabel})
	} else {
		c.Line(pdf.AtX, rightX, "Not issued yet", pdf.Style{Color: &muted, Size: pdf.SizeLabel})
	}
	if limit := rows - 3*(pdf.SizeLabel+4.5); c.Top() > limit {
		c.To(limit)
	}
	c.Down(8)

	// The signing trail: what a dispute would ask for first.
	c.Eyebrow(pdf.AtX, pdf.MarginLeft, "Signing record")
	account := parties.Owner.Email
	if account == "" {
		account = "of the owner"
	}
	device := r.UserAgent
	if device == "" {
		device = "not recorded"
	}
	if r.IP != "" {
		device += " - IP " + r.IP
	}
	for _, l := range []string{"Signed in the HostelPalika account " + account + " on " + bs.DocumentInstant(r.SignedAt) + ".", "Device: " + device, "Agreement fingerprint (SHA-256): " + r.TextHash} {
		flow(l, flowOpts{color: &muted, size: pdf.SizeFootnote})
	}

	// Above the letterhead's own footer, which carries the address.
	total := d.Pages()
	for n := 1; n <= total; n++ {
		d.GoToPage(n)
		c.To(agreementPageNumberY)
		c.Text(pdf.AtX, pdf.MarginLeft, "Signed electronically - Page "+strconv.Itoa(n)+" of "+strconv.Itoa(total), pdf.Style{Color: &muted, Size: pdf.SizeFootnote})
		c.Text(pdf.Right, 0, ref, pdf.Style{Color: &muted, Font: pdf.Mono, Size: pdf.SizeFootnote})
	}
	return d.Bytes()
}
