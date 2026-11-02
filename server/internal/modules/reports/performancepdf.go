package reports

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/export"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pdf"
	"github.com/softmato/hostelpalika/server/internal/platform/plans"
)

const (
	pdfGutter = 14.0
	pdfRow    = 18.0
	pdfFloor  = 96.0 // MARGIN.bottom + 40
	pageRight = pdf.PageWidth - 52.0
	pageLeft  = 52.0
)

// perfReport reads the same payload the screen gets, so the two cannot disagree.
type perfReport struct {
	GeneratedAt time.Time `json:"generatedAt"`
	HostelName  string    `json:"hostelName"`
	Period      struct {
		End           time.Time `json:"end"`
		IsCurrent     bool      `json:"isCurrent"`
		Month         string    `json:"month"`
		PreviousMonth string    `json:"previousMonth"`
		Start         time.Time `json:"start"`
	} `json:"period"`
	Finance struct {
		Billed             float64  `json:"billed"`
		Collected          float64  `json:"collected"`
		CollectionRate     *float64 `json:"collectionRate"`
		Outstanding        float64  `json:"outstanding"`
		OutstandingAllTime float64  `json:"outstandingAllTime"`
		PendingProofs      float64  `json:"pendingProofs"`
		Previous           struct {
			Collected      float64  `json:"collected"`
			CollectionRate *float64 `json:"collectionRate"`
		} `json:"previous"`
		Methods []struct {
			Count  float64 `json:"count"`
			Method string  `json:"method"`
		} `json:"methods"`
		Trend []perfPoint `json:"trend"`
	} `json:"finance"`
	Residents struct {
		MovedIn  int64 `json:"movedIn"`
		MovedOut int64 `json:"movedOut"`
		Now      struct {
			Active    int64 `json:"active"`
			Pending   int64 `json:"pending"`
			Suspended int64 `json:"suspended"`
			Total     int64 `json:"total"`
		} `json:"now"`
		Tonight struct {
			Inside      float64 `json:"inside"`
			NotAnswered float64 `json:"notAnswered"`
			Outside     float64 `json:"outside"`
		} `json:"tonight"`
	} `json:"residents"`
	Beds struct {
		OccupancyRate *float64 `json:"occupancyRate"`
		Occupied      float64  `json:"occupied"`
		Total         float64  `json:"total"`
		Vacant        float64  `json:"vacant"`
	} `json:"beds"`
	Listing struct {
		Appearances        perfCompare `json:"appearances"`
		Inquiries          perfCompare `json:"inquiries"`
		InquiriesConverted float64     `json:"inquiriesConverted"`
		Rating             struct {
			Average      *float64 `json:"average"`
			NewThisMonth int64    `json:"newThisMonth"`
			Total        float64  `json:"total"`
		} `json:"rating"`
		Views    perfCompare `json:"views"`
		Visitors perfCompare `json:"visitors"`
	} `json:"listing"`
	Operations struct {
		Complaints struct {
			Open, PastSla, Raised, Resolved float64
		} `json:"complaints"`
		Repairs struct {
			Completed, Open, Raised float64
		} `json:"repairs"`
	} `json:"operations"`
	MoneyOut *perfMoneyOut `json:"moneyOut"`
}

type perfPoint struct {
	Billed         float64  `json:"billed"`
	Collected      float64  `json:"collected"`
	CollectionRate *float64 `json:"collectionRate"`
	Month          string   `json:"month"`
}

type perfCompare struct {
	Current  float64 `json:"current"`
	Previous float64 `json:"previous"`
}

type perfMoneyOut struct {
	ByCategory []struct {
		Amount float64 `json:"amount"`
		Label  string  `json:"label"`
	} `json:"byCategory"`
	Out  float64 `json:"out"`
	Rows []struct {
		Amount float64 `json:"amount"`
		CashTo *struct {
			Name string `json:"name"`
		} `json:"cashTo"`
		CashStatus    string  `json:"cashStatus"`
		CategoryLabel string  `json:"categoryLabel"`
		PaidBy        string  `json:"paidBy"`
		SpentOn       string  `json:"spentOn"`
		What          *string `json:"what"`
		RecordedBy    struct {
			Name string `json:"name"`
		} `json:"recordedBy"`
	} `json:"rows"`
	Staff []struct {
		Given   float64 `json:"given"`
		Left    float64 `json:"left"`
		Name    string  `json:"name"`
		Pending float64 `json:"pending"`
		Spent   float64 `json:"spent"`
	} `json:"staff"`
}

func pdfRupees(v float64) string { return "Rs " + pdfCount(v) }
func pdfCount(v float64) string  { return money.GroupIN(int64(plans.JSRound(v))) }

func pdfPlural(v float64, noun string) string {
	if v == 1 {
		return pdfCount(v) + " " + noun
	}
	return pdfCount(v) + " " + noun + "s"
}

func pdfPercent(v *float64) string {
	if v == nil {
		return "-"
	}
	return fmt.Sprintf("%d%%", int64(plans.JSRound(*v)))
}

// changeLabel is `+12%`, `-8%`, `New`, or a dash with nothing either side.
func changeLabel(current, previous float64) string {
	if previous == 0 {
		if current == 0 {
			return "-"
		}
		return "New"
	}
	delta := int64(plans.JSRound((current - previous) / previous * 100))
	switch {
	case delta == 0:
		return "No change"
	case delta > 0:
		return fmt.Sprintf("+%d%%", delta)
	}
	return fmt.Sprintf("%d%%", delta)
}

func periodName(month string) string {
	if name := strings.TrimSuffix(bs.FormatPeriod(month), " BS"); name != "" {
		return name
	}
	return month
}

func monthOnly(month string) string {
	if _, m, ok := bs.PeriodParts(month); ok {
		return bs.MonthName(m)
	}
	return month
}

func rangeLabel(start, end time.Time) string {
	from, ferr := bs.ToBs(start)
	to, terr := bs.ToBs(end)
	if ferr != nil || terr != nil {
		return ""
	}
	toName := fmt.Sprintf("%s %d BS", bs.MonthName(to.Month), to.Year)
	if from.Month == to.Month && from.Year == to.Year {
		return fmt.Sprintf("%d - %d %s", from.Day, to.Day, toName)
	}
	return fmt.Sprintf("%d %s - %d %s", from.Day, bs.MonthName(from.Month), to.Day, toName)
}

func methodLabel(method string) string {
	switch method {
	case "BANK_TRANSFER":
		return "Bank transfer"
	case "CASH":
		return "Cash"
	case "ESEWA":
		return "eSewa"
	case "FONEPAY":
		return "Fonepay"
	case "KHALTI":
		return "Khalti"
	}
	words := strings.Split(strings.ToLower(method), "_")
	if words[0] != "" {
		words[0] = strings.ToUpper(words[0][:1]) + words[0][1:]
	}
	return strings.Join(words, " ")
}

type perfPen struct{ *pdf.Cursor }

var (
	inkMuted, inkLabel, inkAccent, inkRule = pdf.ColorMuted, pdf.ColorLabel, pdf.ColorAccent, pdf.ColorRule
	inkRuleStrong, inkText                 = pdf.ColorRuleStrong, pdf.ColorText
	// The track's rule colour at 35% over white paper; the helper draws no opacity.
	inkTrack = pdf.RGB{R: 0.948, G: 0.944, B: 0.936}
)

func (p perfPen) fitted(font pdf.Font, text string, size, width float64) float64 {
	for size > 7 && p.Doc.Width(text, font, size) > width {
		size -= 0.5
	}
	return size
}

func (p perfPen) at(x float64, value string, s pdf.Style) float64 {
	return p.Text(pdf.AtX, x, value, s)
}

func (p perfPen) rightAt(edge float64, value string, s pdf.Style) {
	p.Text(pdf.AtX, edge-p.Width(value, s), value, s)
}

func (p perfPen) hair(y, from, to float64) { p.Doc.Line(from, y, to, y, 0.6, inkRule) }

func (p perfPen) section(eyebrow, title, note string) {
	p.Eyebrow(pdf.AtX, pageLeft, eyebrow)
	p.at(pageLeft, title, pdf.Style{Font: pdf.Bold, Size: pdf.SizePartyName})
	if note != "" {
		p.rightAt(pageRight, note, pdf.Style{Color: &inkMuted, Size: pdf.SizeFootnote})
	}
	p.Down(pdf.SpaceLine + 4)
}

type perfFigure struct{ label, sub, value string }

func (p perfPen) figures(figures []perfFigure) {
	n := float64(len(figures))
	width := (pdf.ContentWidth - pdfGutter*(n-1)) / n
	top := p.Top()
	for i, f := range figures {
		x := pageLeft + float64(i)*(width+pdfGutter)
		p.To(top)
		p.Eyebrow(pdf.AtX, x, f.label)
		p.Down(5)
		p.at(x, f.value, pdf.Style{Font: pdf.MonoBold, Size: p.fitted(pdf.MonoBold, f.value, 16, width-4)})
		p.Down(15)
		p.at(x, f.sub, pdf.Style{Color: &inkMuted, Size: p.fitted(pdf.Regular, f.sub, pdf.SizeFootnote, width-4)})
		if i > 0 {
			lineX := x - pdfGutter/2
			p.Doc.Line(lineX, top+8, lineX, top-44, 0.6, inkRule)
		}
	}
	p.To(top - 44 - pdf.SpaceTight)
}

type perfColumn struct {
	label string
	width float64
	right bool
}

type perfRow struct {
	cells  []string
	strong bool
}

func (p perfPen) table(columns []perfColumn, rows []perfRow) {
	total := 0.0
	for _, c := range columns {
		total += c.width
	}
	scale := pdf.ContentWidth / total
	lefts, rights := make([]float64, len(columns)), make([]float64, len(columns))
	x := pageLeft
	for i, c := range columns {
		lefts[i] = x
		x += c.width * scale
		rights[i] = x
	}
	head := pdf.Style{Color: &inkLabel, Size: pdf.SizeEyebrow}
	for i, c := range columns {
		label := strings.ToUpper(c.label)
		if c.right {
			p.rightAt(rights[i], label, head)
		} else {
			p.at(lefts[i], label, head)
		}
	}
	p.hair(p.Top()-6, pageLeft, pageRight)
	p.Down(pdfRow)
	for _, r := range rows {
		for i, cell := range r.cells {
			c := columns[i]
			font := pdf.Regular
			switch {
			case c.right && r.strong:
				font = pdf.MonoBold
			case c.right:
				font = pdf.Mono
			case r.strong:
				font = pdf.Bold
			}
			if c.right {
				p.rightAt(rights[i], cell, pdf.Style{Font: font})
			} else {
				p.at(lefts[i], cell, pdf.Style{Font: font})
			}
		}
		p.Down(pdfRow)
	}
}

func (p perfPen) pair(left, right float64, label, value string) {
	p.at(left, label, pdf.Style{Color: &inkLabel, Size: pdf.SizeLabel})
	p.rightAt(right, value, pdf.Style{Font: pdf.Mono})
}

type perfPart struct {
	color pdf.RGB
	label string
	value float64
}

func (p perfPen) splitBar(parts []perfPart, total float64) {
	const height = 9.0
	y := p.Top() - height
	p.Doc.Rect(pageLeft, y, pdf.ContentWidth, height, nil, 0, &inkTrack)
	if total > 0 {
		x := pageLeft
		for i := range parts {
			if width := math.Max(parts[i].value, 0) / total * pdf.ContentWidth; width > 0 {
				p.Doc.Rect(x, y, width, height, nil, 0, &parts[i].color)
				x += width
			}
		}
	}
	p.Down(height + 14)
	x := pageLeft
	for i := range parts {
		p.Doc.Rect(x, p.Top()-0.5, 7, 7, nil, 0, &parts[i].color)
		x += 11
		x += p.at(x, parts[i].label, pdf.Style{Color: &inkMuted, Size: pdf.SizeLabel}) + 6
		x += p.at(x, pdfCount(parts[i].value), pdf.Style{Font: pdf.MonoBold, Size: pdf.SizeLabel}) + 18
	}
	p.Down(pdf.SpaceLine)
}

func (p perfPen) trendChart(trend []perfPoint) {
	const height = 150.0
	top := p.Top()
	base := top - height
	peak := 0.0
	for _, t := range trend {
		peak = math.Max(peak, math.Max(t.Billed, t.Collected))
	}
	if peak <= 0 {
		p.at(pageLeft, "Nothing was billed in these six months.", pdf.Style{Color: &inkMuted})
		p.Down(pdf.SpaceBlock)
		return
	}
	p.hair(top, pageLeft, pageRight)
	p.To(top + 4)
	p.rightAt(pageRight, pdfRupees(peak), pdf.Style{Color: &inkMuted, Font: pdf.Mono, Size: pdf.SizeFootnote})
	group := pdf.ContentWidth / float64(len(trend))
	bar := math.Min(22, group*0.26)
	for i, t := range trend {
		centre := pageLeft + group*float64(i) + group/2
		if h := t.Billed / peak * (height - 8); h > 0 {
			p.Doc.Rect(centre-bar-1.5, base, bar, h, nil, 0, &inkRule)
		}
		if h := math.Min(t.Collected, peak) / peak * (height - 8); h > 0 {
			p.Doc.Rect(centre+1.5, base, bar, h, nil, 0, &inkAccent)
		}
		p.To(base - 13)
		label := monthOnly(t.Month)
		font, color := pdf.Regular, &inkMuted
		if i == len(trend)-1 {
			font, color = pdf.Bold, &inkText
		}
		p.at(centre-p.Doc.Width(label, font, pdf.SizeLabel)/2, label, pdf.Style{Color: color, Font: font, Size: pdf.SizeLabel})
	}
	p.Doc.Line(pageLeft, base, pageRight, base, 0.8, inkRuleStrong)
	p.To(base - 13 - pdf.SpaceLine)
	x := pageLeft
	for _, key := range []perfPart{{color: inkRule, label: "Billed"}, {color: inkAccent, label: "Collected"}} {
		p.Doc.Rect(x, p.Top()-0.5, 7, 7, nil, 0, &key.color)
		x += 11 + p.at(x+11, key.label, pdf.Style{Color: &inkMuted, Size: pdf.SizeLabel}) + 18
	}
	p.Down(pdf.SpaceLine + 6)
}

func (p perfPen) masthead(r *perfReport, hostel string) {
	top := p.Top()
	title := periodName(r.Period.Month)
	span := rangeLabel(r.Period.Start, r.Period.End)
	if r.Period.IsCurrent {
		span += " (so far)"
	}
	p.at(pageLeft, hostel, pdf.Style{Font: pdf.Bold, Size: p.fitted(pdf.Bold, hostel, pdf.SizeIssuer+3, pdf.ContentWidth*0.55)})
	p.rightAt(pageRight, title, pdf.Style{Font: pdf.Bold, Size: pdf.SizeIssuer + 3})
	p.To(top - 17)
	p.at(pageLeft, "Monthly performance report", pdf.Style{Color: &inkLabel, Size: pdf.SizeLabel})
	p.rightAt(pageRight, span, pdf.Style{Color: &inkMuted, Size: pdf.SizeLabel})
	p.Down(pdf.SpaceTight)
	p.RuleStrong()
}

func (p perfPen) runningHeader(r *perfReport, hostel string) {
	s := pdf.Style{Color: &inkLabel, Size: pdf.SizeLabel}
	p.at(pageLeft, hostel, s)
	p.rightAt(pageRight, periodName(r.Period.Month), s)
	p.Down(pdf.SpaceTight)
	p.RuleStrong()
}

func (p perfPen) moneyPage(r *perfReport) {
	f := &r.Finance
	month, previous := monthOnly(r.Period.Month), monthOnly(r.Period.PreviousMonth)
	collectedSub := "Nothing billed yet"
	if f.Billed > 0 {
		collectedSub = "of " + pdfRupees(f.Billed) + " billed"
	}
	rateSub := previous + ": nothing billed"
	if f.Previous.CollectionRate != nil {
		rateSub = previous + ": " + pdfPercent(f.Previous.CollectionRate)
	}
	p.figures([]perfFigure{
		{"Collected", collectedSub, pdfRupees(f.Collected)},
		{"Collection rate", rateSub, pdfPercent(f.CollectionRate)},
		{"Residents", fmt.Sprintf("%d in, %d out in %s", r.Residents.MovedIn, r.Residents.MovedOut, month), pdfCount(float64(r.Residents.Now.Total))},
		{"Occupancy", pdfCount(r.Beds.Occupied) + " of " + pdfCount(r.Beds.Total) + " beds", pdfPercent(r.Beds.OccupancyRate)},
	})
	p.Rule(pdf.RuleOptions{})
	p.section("Money", "Rent for "+month, "")
	half := (pdf.ContentWidth - pdfGutter*2) / 2
	leftEnd := pageLeft + half
	rightStart := leftEnd + pdfGutter*2
	for _, row := range [][4]string{
		{"Billed", pdfRupees(f.Billed), "Owed across all months", pdfRupees(f.OutstandingAllTime)},
		{"Collected", pdfRupees(f.Collected), "Payment proofs to check", pdfCount(f.PendingProofs)},
		{"Still owed", pdfRupees(f.Outstanding), "Collected for " + previous, pdfRupees(f.Previous.Collected)},
	} {
		p.pair(pageLeft, leftEnd, row[0], row[1])
		p.pair(rightStart, pageRight, row[2], row[3])
		p.Down(pdfRow)
	}
	p.Down(pdf.SpaceTight + 6)
	p.Eyebrow(pdf.AtX, pageLeft, "Last six months")
	p.Down(10)
	p.trendChart(f.Trend)
	rows := make([]perfRow, len(f.Trend))
	for i, t := range f.Trend {
		rows[i] = perfRow{[]string{periodName(t.Month), pdfRupees(t.Billed), pdfRupees(t.Collected), pdfRupees(math.Max(t.Billed-t.Collected, 0)), pdfPercent(t.CollectionRate)}, i == len(f.Trend)-1}
	}
	p.table([]perfColumn{{"Month", 3, false}, {"Billed", 2.5, true}, {"Collected", 2.5, true}, {"Still owed", 2.5, true}, {"Rate", 1.5, true}}, rows)
	if len(f.Methods) > 0 {
		p.Down(6)
		p.at(pageLeft, "Paid in "+month+" by", pdf.Style{Color: &inkLabel, Size: pdf.SizeLabel})
		used := make([]string, len(f.Methods))
		for i, m := range f.Methods {
			used[i] = methodLabel(m.Method) + " (" + pdfPlural(m.Count, "invoice") + ")"
		}
		p.at(pageLeft+120, strings.Join(used, ",   "), pdf.Style{Size: pdf.SizeLabel})
	}
}

func (p perfPen) peoplePage(r *perfReport) {
	res, listing, ops := &r.Residents, &r.Listing, &r.Operations
	month, previous := monthOnly(r.Period.Month), monthOnly(r.Period.PreviousMonth)
	p.section("People", "Residents", "Living here and tonight: as of when this was generated")
	net := res.MovedIn - res.MovedOut
	sign := ""
	if net >= 0 {
		sign = "+"
	}
	p.figures([]perfFigure{
		{"Living here", fmt.Sprintf("%d active, %d pending, %d suspended", res.Now.Active, res.Now.Pending, res.Now.Suspended), pdfCount(float64(res.Now.Total))},
		{"Moved in (" + month + ")", "New residents this month", pdfCount(float64(res.MovedIn))},
		{"Moved out (" + month + ")", fmt.Sprintf("Net %s%d", sign, net), pdfCount(float64(res.MovedOut))},
	})
	p.Down(pdf.SpaceTight)
	p.Eyebrow(pdf.AtX, pageLeft, "Tonight")
	p.Down(2)
	p.splitBar([]perfPart{{inkAccent, "Inside", res.Tonight.Inside}, {inkLabel, "Outside", res.Tonight.Outside}, {inkRule, "Not answered", res.Tonight.NotAnswered}}, float64(res.Now.Total))
	p.Down(10)
	p.Eyebrow(pdf.AtX, pageLeft, "Beds")
	p.Down(2)
	p.splitBar([]perfPart{{inkAccent, "Occupied", r.Beds.Occupied}, {inkRule, "Free", r.Beds.Vacant}}, r.Beds.Total)
	p.Down(4)
	p.Rule(pdf.RuleOptions{})
	p.section("Reach", "Public listing", "")
	reach := []struct {
		label string
		c     perfCompare
	}{{"Appeared in search results", listing.Appearances}, {"Page views", listing.Views}, {"Unique visitors", listing.Visitors}, {"Inquiries", listing.Inquiries}}
	rows := make([]perfRow, len(reach))
	for i, x := range reach {
		rows[i] = perfRow{cells: []string{x.label, pdfCount(x.c.Current), pdfCount(x.c.Previous), changeLabel(x.c.Current, x.c.Previous)}}
	}
	p.table([]perfColumn{{"", 4, false}, {month, 2, true}, {previous, 2, true}, {"Change", 2, true}}, rows)
	p.Down(4)
	p.pair(pageLeft, pageRight, "Inquiries from "+month+" that became residents", pdfCount(listing.InquiriesConverted))
	p.Down(pdfRow)
	label, value := "Rating", "No reviews yet"
	if listing.Rating.Total > 0 {
		label = fmt.Sprintf("Rating, from %s (%d new in %s)", pdfPlural(listing.Rating.Total, "review"), listing.Rating.NewThisMonth, month)
	}
	if listing.Rating.Average != nil {
		value = toFixedText(*listing.Rating.Average, 1) + " / 5"
	}
	p.pair(pageLeft, pageRight, label, value)
	p.Down(pdfRow + pdf.SpaceTight)
	p.Rule(pdf.RuleOptions{})
	p.section("Operations", "Complaints and repairs", "")
	p.table([]perfColumn{{"", 3, false}, {"Raised in " + month, 2.4, true}, {"Closed", 1.8, true}, {"Open now", 1.8, true}, {"Past due", 1.8, true}}, []perfRow{
		{cells: []string{"Complaints", pdfCount(ops.Complaints.Raised), pdfCount(ops.Complaints.Resolved), pdfCount(ops.Complaints.Open), pdfCount(ops.Complaints.PastSla)}},
		{cells: []string{"Repairs", pdfCount(ops.Repairs.Raised), pdfCount(ops.Repairs.Completed), pdfCount(ops.Repairs.Open), "-"}},
	})
}

func clipText(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// moneyOutPages is the owner's copy only: spending by category, each warden's cash
// box, then every line. Returns the pages it drew.
func moneyOutPages(d *pdf.Doc, r *perfReport, hostel string) []perfPen {
	out := r.MoneyOut
	if out == nil {
		return nil
	}
	pages := []perfPen{}
	page := func() perfPen {
		d.AddPage()
		p := perfPen{pdf.NewCursor(d)}
		p.runningHeader(r, hostel)
		p.Down(pdf.SpaceLine)
		pages = append(pages, p)
		return p
	}
	p := page()
	var withStaff, owed float64
	for _, box := range out.Staff {
		withStaff += math.Max(0, box.Left)
		owed += math.Max(0, -box.Left)
	}
	spent := 0
	for _, row := range out.Rows {
		if row.CashTo == nil {
			spent++
		}
	}
	p.section("MONEY OUT", "Where the money went", monthOnly(r.Period.Month))
	p.figures([]perfFigure{
		{"Spent", fmt.Sprintf("%d expenses", spent), pdfRupees(out.Out)},
		{"With wardens", "Cash they still hold", pdfRupees(withStaff)},
		{"Owed to wardens", "Paid from their pocket", pdfRupees(owed)},
	})
	p.Down(pdf.SpaceLine)
	if len(out.ByCategory) > 0 {
		rows := make([]perfRow, len(out.ByCategory))
		for i, c := range out.ByCategory {
			share := "-"
			if out.Out > 0 {
				share = fmt.Sprintf("%d%%", int64(plans.JSRound(c.Amount/out.Out*100)))
			}
			rows[i] = perfRow{cells: []string{export.Sanitize(c.Label), pdfRupees(c.Amount), share}}
		}
		p.table([]perfColumn{{"Spent on", 3, false}, {"Amount", 1.2, true}, {"Share", 0.8, true}}, rows)
		p.Down(pdf.SpaceLine)
	}
	if len(out.Staff) > 0 {
		if p.Top()-float64(len(out.Staff)+3)*pdfRow < pdfFloor {
			p = page()
		}
		p.section("STAFF CASH", "Each warden's cash box", "")
		rows := make([]perfRow, len(out.Staff))
		for i, box := range out.Staff {
			name := box.Name
			if box.Pending > 0 {
				name += " (" + pdfRupees(box.Pending) + " waiting)"
			}
			left := pdfRupees(box.Left)
			if box.Left < 0 {
				left = "owes " + pdfRupees(-box.Left)
			}
			rows[i] = perfRow{cells: []string{export.Sanitize(name), pdfRupees(box.Given), pdfRupees(box.Spent), left}}
		}
		p.table([]perfColumn{{"Warden", 2.4, false}, {"Given", 1.2, true}, {"Spent", 1.2, true}, {"Left", 1.4, true}}, rows)
		p.Down(pdf.SpaceLine)
	}
	lines := make([]perfRow, len(out.Rows))
	for i, row := range out.Rows {
		var what string
		switch {
		case row.CashTo != nil:
			what = "Cash to " + row.CashTo.Name
			if row.CashStatus == "PENDING" {
				what += " (waiting)"
			}
		case row.What != nil && *row.What != "":
			what = row.CategoryLabel + " - " + *row.What
		default:
			what = row.CategoryLabel
		}
		by := row.RecordedBy.Name
		if by == "" {
			by = "Staff"
		}
		paid := "Cash"
		switch row.PaidBy {
		case "ESEWA":
			paid = "eSewa"
		case "KHALTI":
			paid = "Khalti"
		case "BANK":
			paid = "Bank"
		}
		date := ""
		if day, err := time.ParseInLocation("2006-01-02T15:04", row.SpentOn+"T12:00", time.FixedZone("NPT", 345*60)); err == nil {
			date = bs.DocumentBsDate(day)
		}
		lines[i] = perfRow{cells: []string{date, clipText(export.Sanitize(what), 48), clipText(export.Sanitize(by), 22), paid, pdfRupees(row.Amount)}}
	}
	columns := []perfColumn{{"Date (BS)", 1.1, false}, {"What", 2.6, false}, {"By", 1.3, false}, {"Paid by", 0.9, false}, {"Amount", 1.1, true}}
	title := true
	for start := 0; start < len(lines); {
		if p.Top()-5*pdfRow < pdfFloor {
			p = page()
		}
		if title {
			p.section("EVERY EXPENSE", "Line by line", "Cash to a warden is not counted as spent")
			title = false
		}
		fits := max(1, int(math.Floor((p.Top()-pdfFloor)/pdfRow))-1)
		end := min(start+fits, len(lines))
		p.table(columns, lines[start:end])
		start = end
	}
	return pages
}

// RenderPerformancePDF is renderPerformanceReportPdf.
func RenderPerformancePDF(payload ordered.Map) ([]byte, string, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, "", err
	}
	var r perfReport
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, "", err
	}
	hostel := strings.TrimSpace(export.Sanitize(r.HostelName))
	if hostel == "" {
		hostel = "Your hostel"
	}
	note := export.Sanitize("HostelPalika - generated " + bs.DocumentInstant(r.GeneratedAt) + " from live records")
	d := pdf.New()
	d.SetMeta(hostel+" - "+periodName(r.Period.Month)+" performance report", "HostelPalika", "HostelPalika")
	first := perfPen{pdf.NewCursor(d)}
	first.masthead(&r, hostel)
	first.moneyPage(&r)
	d.AddPage()
	second := perfPen{pdf.NewCursor(d)}
	second.runningHeader(&r, hostel)
	second.peoplePage(&r)
	pages := append([]perfPen{first, second}, moneyOutPages(d, &r, hostel)...)
	for i, p := range pages {
		d.GoToPage(i + 1)
		p.To(pdf.MarginBottom + pdf.SpaceRule)
		p.Rule(pdf.RuleOptions{})
		p.To(pdf.MarginBottom)
		p.at(pageLeft, note, pdf.Style{Color: &inkMuted, Size: pdf.SizeFootnote})
		p.rightAt(pageRight, fmt.Sprintf("Page %d of %d", i+1, len(pages)), pdf.Style{Color: &inkMuted, Font: pdf.Mono, Size: pdf.SizeFootnote})
	}
	out, err := d.Bytes()
	return out, "performance-" + r.Period.Month + ".pdf", err
}

func (a *Admin) performancePDF(c *gin.Context) {
	p, s, month, ok := a.staffQuery(c)
	if !ok {
		return
	}
	report, err := a.Performance(c, p, s, month)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, name, err := RenderPerformancePDF(report)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	// Live figures scoped to one hostel: never cached, never in a shared proxy.
	c.Header("cache-control", "no-store")
	c.Header("content-disposition", `attachment; filename="`+name+`"`)
	c.Data(200, "application/pdf", body)
}
