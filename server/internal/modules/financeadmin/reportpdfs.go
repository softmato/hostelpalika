package financeadmin

// The account statement and the all-branches document: reports/statement-pdf.ts and
// reports/overall-pdf.ts, over the same ledger the money screen reads.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/modules/reports"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/export"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	"github.com/softmato/hostelpalika/server/internal/platform/pdf"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

func (h *Handler) registerReportPDFs(v1 *gin.RouterGroup) {
	v1.GET("/hostel-admin/reports/statement/pdf", h.statementPDF)
	v1.GET("/hostel-admin/reports/overall/pdf", h.overallPDF)
}

// ---- the statement ----

type stLine struct {
	amount      int64
	at          time.Time
	kind        string // credit | debit | transfer
	particulars string
}

type stMonth struct {
	credit, debit int64
	month         string
}

type stStaff struct {
	given, left, pending, spent int64
	name                        string
}

type hostelStatement struct {
	closing, opening int64
	from, to         string
	lines            []stLine
	months           []stMonth
	staff            []stStaff
	credit, debit    int64
}

type ledgerDoc struct {
	Entries []struct {
		CreatedAt    *string `json:"createdAt"`
		Month        *string `json:"month"`
		PaidAmount   float64 `json:"paidAmount"`
		PaidDate     *string `json:"paidDate"`
		ResidentName string  `json:"residentName"`
	} `json:"entries"`
	Expenses []struct {
		Amount        float64                         `json:"amount"`
		CashStatus    *string                         `json:"cashStatus"`
		CashTo        *struct{ Name, UserID string }  `json:"cashTo"`
		CategoryLabel string                          `json:"categoryLabel"`
		Payer         string                          `json:"payer"`
		RecordedBy    struct{ ID, Name, Role string } `json:"recordedBy"`
		SalaryFor     *struct{ Name string }          `json:"salaryFor"`
		SpentOn       string                          `json:"spentOn"`
		Status        string                          `json:"status"`
		What          string                          `json:"what"`
	} `json:"expenses"`
	OpeningBalance *struct {
		Amount float64 `json:"amount"`
		AsOf   string  `json:"asOf"`
	} `json:"openingBalance"`
}

func parseInstant(s *string) *time.Time {
	if s == nil || *s == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05-07:00"} {
		if t, err := time.Parse(layout, *s); err == nil {
			return &t
		}
	}
	return nil
}

// nepalNoon is the spending day at noon in Nepal.
func nepalNoon(day string) *time.Time {
	d := day + "T12:00:00+05:45"
	return parseInstant(&d)
}

func jsRound(v float64) int64 { return int64(math.Floor(v + 0.5)) }

func rupees(v int64) string {
	a := v
	if a < 0 {
		a = -a
	}
	if v < 0 {
		return "-Rs " + money.GroupIN(a)
	}
	return "Rs " + money.GroupIN(a)
}

func signedAmount(l stLine) int64 {
	switch l.kind {
	case "credit":
		return l.amount
	case "debit":
		return -l.amount
	}
	return 0
}

func ledgerLines(l *ledgerDoc) []stLine {
	var lines []stLine
	for _, e := range l.Entries {
		at := parseInstant(e.PaidDate)
		if at == nil {
			at = parseInstant(e.CreatedAt)
		}
		if e.PaidAmount > 0 && at != nil {
			what := "One-off charge"
			if e.Month != nil && *e.Month != "" {
				what = bs.FormatPeriod(*e.Month) + " rent"
			}
			who := strings.TrimSpace(e.ResidentName)
			if who == "" {
				who = "a resident"
			}
			lines = append(lines, stLine{jsRound(e.PaidAmount), *at, "credit", what + " - " + who})
		}
	}
	if b := l.OpeningBalance; b != nil && b.Amount != 0 {
		d := b.AsOf + "T00:00:00+05:45"
		if at := parseInstant(&d); at != nil {
			kind := "credit"
			if b.Amount < 0 {
				kind = "debit"
			}
			lines = append(lines, stLine{jsRound(math.Abs(b.Amount)), *at, kind, "Opening bank balance"})
		}
	}
	for _, x := range l.Expenses {
		at := nepalNoon(x.SpentOn)
		if x.Status != "RECORDED" || x.Amount <= 0 || at == nil || x.CashStatus != nil && *x.CashStatus == "DECLINED" {
			continue
		}
		amount := jsRound(x.Amount)
		if x.CashTo != nil {
			waiting := ""
			if x.CashStatus != nil && *x.CashStatus == "PENDING" {
				waiting = ", not confirmed yet"
			}
			lines = append(lines, stLine{amount, *at, "transfer", "Cash to " + x.CashTo.Name + " - " + rupees(amount) + " (staff cash" + waiting + ")"})
			continue
		}
		what := strings.TrimSpace(x.What)
		label := x.CategoryLabel
		if what != "" {
			label += " - " + what
		}
		salary := ""
		if x.SalaryFor != nil {
			salary = " (" + x.SalaryFor.Name + ")"
		}
		by := ""
		if x.Payer == "STAFF" {
			n := x.RecordedBy.Name
			if n == "" {
				n = "staff"
			}
			by = " - by " + n
		}
		lines = append(lines, stLine{amount, *at, "debit", label + salary + by})
	}
	sort.SliceStable(lines, func(i, j int) bool { return lines[i].at.Before(lines[j].at) })
	return lines
}

func staffCashLines(l *ledgerDoc, start, end time.Time) []stStaff {
	type box struct {
		stStaff
		total int64
	}
	boxes := map[string]*box{}
	var order []string
	get := func(id, name string) *box {
		if b, ok := boxes[id]; ok {
			return b
		}
		b := &box{stStaff: stStaff{name: name}}
		boxes[id] = b
		order = append(order, id)
		return b
	}
	for _, x := range l.Expenses {
		at := nepalNoon(x.SpentOn)
		if x.Status != "RECORDED" || at == nil || !at.Before(end) {
			continue
		}
		in := !at.Before(start)
		amount := jsRound(x.Amount)
		declined := x.CashStatus != nil && *x.CashStatus == "DECLINED"
		if x.CashTo != nil && !declined {
			b := get(x.CashTo.UserID, x.CashTo.Name)
			if x.CashStatus != nil && *x.CashStatus == "ACCEPTED" {
				b.total += amount
				if in {
					b.given += amount
				}
			} else if in {
				b.pending += amount
			}
		} else if x.Payer == "STAFF" && x.RecordedBy.Role == "WARDEN" {
			n := x.RecordedBy.Name
			if n == "" {
				n = "Warden"
			}
			b := get(x.RecordedBy.ID, n)
			b.total -= amount
			if in {
				b.spent += amount
			}
		}
	}
	out := make([]stStaff, 0, len(order))
	for _, id := range order {
		b := boxes[id]
		b.left = b.total
		out = append(out, b.stStaff)
	}
	sort.SliceStable(out, func(i, j int) bool { return strings.ToLower(out[i].name) < strings.ToLower(out[j].name) })
	return out
}

func buildStatement(l *ledgerDoc, from, to string) (*hostelStatement, error) {
	first, last := from, to
	if from > to {
		first, last = to, from
	}
	fb, err := bs.PeriodBounds(first)
	if err != nil {
		return nil, err
	}
	lb, err := bs.PeriodBounds(last)
	if err != nil {
		return nil, err
	}
	start, end := fb.Start, lb.End
	all := ledgerLines(l)
	st := &hostelStatement{from: first, to: last, lines: []stLine{}}
	byMonth := map[string]*stMonth{}
	for _, ln := range all {
		if ln.at.Before(start) {
			st.opening += signedAmount(ln)
			continue
		}
		if ln.at.Before(end) {
			st.lines = append(st.lines, ln)
		}
	}
	for _, ln := range st.lines {
		if ln.kind == "transfer" {
			continue
		}
		m, _ := bs.PeriodOf(ln.at)
		row := byMonth[m]
		if row == nil {
			row = &stMonth{month: m}
			byMonth[m] = row
		}
		if ln.kind == "credit" {
			st.credit += ln.amount
			row.credit += ln.amount
		} else {
			st.debit += ln.amount
			row.debit += ln.amount
		}
	}
	for _, r := range byMonth {
		st.months = append(st.months, *r)
	}
	sort.Slice(st.months, func(i, j int) bool { return st.months[i].month < st.months[j].month })
	st.closing = st.opening + st.credit - st.debit
	st.staff = staffCashLines(l, start, end)
	return st, nil
}

var (
	debitInk = pdf.RGB{R: 0.72, G: 0.11, B: 0.11}
	zebra    = pdf.RGB{R: 0.957, G: 0.973, B: 0.965}
	white    = pdf.RGB{R: 1, G: 1, B: 1}
	stLeft   = 52.0
	stRight  = pdf.PageWidth - 52.0
)

const (
	stRow    = 17.0
	stBanner = 54.0
)

type stCols struct{ snX, dateX, partX, partW, debitR, creditR, balanceR float64 }

func statementCols() stCols {
	sn, date, mon := 28.0, 86.0, 72.0
	part := pdf.ContentWidth - sn - date - mon*3
	x0 := pdf.MarginLeft
	return stCols{x0 + 4, x0 + sn, x0 + sn + date, part - 8, x0 + sn + date + part + mon - 4, x0 + sn + date + part + mon*2 - 4, x0 + pdf.ContentWidth - 4}
}

type stPen struct{ *pdf.Cursor }

func (p stPen) at(x float64, v string, s pdf.Style) { p.Text(pdf.AtX, x, v, s) }
func (p stPen) right(edge float64, v string, s pdf.Style) {
	p.Text(pdf.AtX, edge-p.Width(v, s), v, s)
}
func (p stPen) hairline(strong bool) {
	if strong {
		p.Doc.Line(stLeft, p.Top(), stLeft+pdf.ContentWidth, p.Top(), 1.1, pdf.ColorRuleStrong)
		return
	}
	p.Doc.Line(stLeft, p.Top(), stLeft+pdf.ContentWidth, p.Top(), 0.6, pdf.ColorRule)
}

func (p stPen) clip(text string, width, size float64) string {
	if p.Doc.Width(text, pdf.Regular, size) <= width {
		return text
	}
	r := []rune(text)
	for len(r) > 1 && p.Doc.Width(string(r)+"...", pdf.Regular, size) > width {
		r = r[:len(r)-1]
	}
	return strings.TrimRight(string(r), " \t\n") + "..."
}

func rangeTitle(s *hostelStatement) string {
	from := bs.FormatPeriod(s.from)
	if s.from == s.to {
		return from
	}
	return from + " to " + bs.FormatPeriod(s.to)
}

func (p stPen) banner(hostel string, s *hostelStatement, generated time.Time) {
	p.Doc.Rect(0, pdf.PageHeight-stBanner, pdf.PageWidth, stBanner, nil, 0, &pdf.ColorAccent)
	p.To(pdf.PageHeight - stBanner/2 - 6)
	p.at(stLeft, "HostelPalika", pdf.Style{Color: &white, Font: pdf.Bold, Size: 17})
	p.right(stRight, "ACCOUNT STATEMENT", pdf.Style{Color: &white, Font: pdf.Bold, Size: 9, Tracking: 1.4})
	p.To(pdf.PageHeight - stBanner - 30)
	p.at(stLeft, hostel, pdf.Style{Font: pdf.Bold, Size: 15})
	p.Down(17)
	p.at(stLeft, "Statement period: "+rangeTitle(s), pdf.Style{Size: pdf.SizeBody})
	p.right(stRight, "Generated "+bs.DocumentBsDate(generated), pdf.Style{Color: &pdf.ColorMuted, Size: pdf.SizeLabel})
	p.Down(14)
	p.hairline(true)
	p.Down(26)
}

func (p stPen) tableHead(c stCols) {
	top := p.Top() + 11
	p.Doc.Rect(stLeft, top-stRow-2, pdf.ContentWidth, stRow+2, nil, 0, &pdf.ColorRuleStrong)
	head := pdf.Style{Color: &white, Font: pdf.Bold, Size: pdf.SizeLabel}
	p.at(c.snX, "S.N.", head)
	p.at(c.dateX, "Date (BS)", head)
	p.at(c.partX, "Particulars", head)
	p.right(c.debitR, "Debit", head)
	p.right(c.creditR, "Credit", head)
	p.right(c.balanceR, "Balance", head)
	p.Down(stRow + 2)
}

type stCells struct {
	balance, credit, debit int64
	date, particulars, sn  string
}

func (p stPen) row(c stCols, cells stCells, shade, bold bool) {
	font := pdf.Regular
	if bold {
		font = pdf.Bold
	}
	size := pdf.SizeLabel
	if shade {
		p.Doc.Rect(stLeft, p.Top()-5, pdf.ContentWidth, stRow, nil, 0, &zebra)
	}
	p.at(c.snX, cells.sn, pdf.Style{Color: &pdf.ColorMuted, Font: font, Size: size})
	p.at(c.dateX, cells.date, pdf.Style{Font: font, Size: size})
	p.at(c.partX, p.clip(cells.particulars, c.partW, size), pdf.Style{Font: font, Size: size})
	if cells.debit != 0 {
		p.right(c.debitR, rupees(cells.debit), pdf.Style{Color: &debitInk, Font: font, Size: size})
	}
	if cells.credit != 0 {
		p.right(c.creditR, rupees(cells.credit), pdf.Style{Color: &pdf.ColorAccent, Font: font, Size: size})
	}
	p.right(c.balanceR, rupees(cells.balance), pdf.Style{Font: pdf.Bold, Size: size})
	p.Down(stRow)
}

func (p stPen) summary(s *hostelStatement) {
	type pair struct {
		label, value string
		strong       bool
	}
	pairs := []pair{{"Opening balance", rupees(s.opening), false}, {"Total credit (money in)", rupees(s.credit), false}, {"Total debit (money out)", rupees(s.debit), false},
		{"Net for the period", rupees(s.credit - s.debit), false}, {"Closing balance", rupees(s.closing), true}}
	box := 250.0
	x := pdf.PageWidth - 52.0 - box
	height := float64(len(pairs))*stRow + 12
	p.Doc.Rect(x, p.Top()-height+12, box, height, &pdf.ColorRuleStrong, 0.8, nil)
	p.Down(4)
	for _, pr := range pairs {
		font := pdf.Regular
		if pr.strong {
			font = pdf.Bold
		}
		p.at(x+10, pr.label, pdf.Style{Font: font, Size: pdf.SizeBody})
		p.right(x+box-10, pr.value, pdf.Style{Font: pdf.Bold, Size: pdf.SizeBody})
		p.Down(stRow)
	}
	p.Down(10)
}

func (p stPen) eyebrow(v string) {
	p.at(stLeft, v, pdf.Style{Color: &pdf.ColorMuted, Font: pdf.Bold, Size: pdf.SizeEyebrow, Tracking: 1.4})
	p.Down(14)
}

func (p stPen) monthTable(months []stMonth) {
	debitX, creditX, netX, monthX := stLeft+200, stLeft+300, stLeft+400, stLeft+4
	p.eyebrow("MONTH BY MONTH")
	head := pdf.Style{Font: pdf.Bold, Size: pdf.SizeLabel}
	p.at(monthX, "Month", head)
	p.right(debitX, "Debit", head)
	p.right(creditX, "Credit", head)
	p.right(netX, "Net", head)
	p.Down(6)
	p.hairline(false)
	p.Down(14)
	for _, m := range months {
		s := pdf.Style{Size: pdf.SizeLabel}
		p.at(monthX, bs.FormatPeriod(m.month), s)
		p.right(debitX, rupees(m.debit), pdf.Style{Color: &debitInk, Size: pdf.SizeLabel})
		p.right(creditX, rupees(m.credit), pdf.Style{Color: &pdf.ColorAccent, Size: pdf.SizeLabel})
		p.right(netX, rupees(m.credit-m.debit), pdf.Style{Font: pdf.Bold, Size: pdf.SizeLabel})
		p.Down(stRow - 2)
	}
	p.Down(8)
}

func (p stPen) staffTable(staff []stStaff) {
	givenX, leftX, nameX, spentX := stLeft+290, stLeft+pdf.ContentWidth-4, stLeft+4, stLeft+390
	size := pdf.SizeLabel
	p.eyebrow("STAFF CASH")
	head := pdf.Style{Font: pdf.Bold, Size: size}
	p.at(nameX, "Warden", head)
	p.right(givenX, "Given", head)
	p.right(spentX, "Spent", head)
	p.right(leftX, "Left with them", head)
	p.Down(6)
	p.hairline(false)
	p.Down(14)
	for _, l := range staff {
		waiting := ""
		if l.pending > 0 {
			waiting = " (" + rupees(l.pending) + " not confirmed)"
		}
		p.at(nameX, p.clip(export.Sanitize(l.name+waiting), 260, size), pdf.Style{Size: size})
		p.right(givenX, rupees(l.given), pdf.Style{Color: &pdf.ColorAccent, Size: size})
		p.right(spentX, rupees(l.spent), pdf.Style{Color: &debitInk, Size: size})
		left := rupees(l.left)
		if l.left < 0 {
			left = "Hostel owes " + rupees(-l.left)
		}
		p.right(leftX, left, pdf.Style{Font: pdf.Bold, Size: size})
		p.Down(stRow - 2)
	}
	p.Down(8)
}

// drawStatement paints the statement onto d, its first page being the page d is on.
func drawStatement(d *pdf.Doc, s *hostelStatement, hostelName string, generated time.Time) {
	name := strings.TrimSpace(export.Sanitize(hostelName))
	if name == "" {
		name = "Your hostel"
	}
	cols := statementCols()
	var pages []stPen
	newPage := func(first bool) stPen {
		if len(pages) > 0 {
			d.AddPage()
		}
		p := stPen{pdf.NewCursor(d)}
		if first {
			p.banner(name, s, generated)
		} else {
			s1 := pdf.Style{Color: &pdf.ColorMuted, Size: pdf.SizeLabel}
			p.at(stLeft, "HostelPalika - "+name, s1)
			p.right(stRight, rangeTitle(s), s1)
			p.Down(10)
			p.hairline(false)
			p.Down(26)
		}
		pages = append(pages, p)
		return p
	}
	floor := pdf.MarginBottom + 40
	p := newPage(true)
	p.tableHead(cols)
	p.row(cols, stCells{balance: s.opening, particulars: "Balance brought forward"}, false, true)
	balance := s.opening
	for i, ln := range s.lines {
		if p.Top() < floor {
			p = newPage(false)
			p.tableHead(cols)
		}
		balance += signedAmount(ln)
		c := stCells{balance: balance, date: bs.DocumentBsDate(ln.at), particulars: export.Sanitize(ln.particulars), sn: fmt.Sprint(i + 1)}
		switch ln.kind {
		case "credit":
			c.credit = ln.amount
		case "debit":
			c.debit = ln.amount
		}
		p.row(cols, c, i%2 == 0, false)
	}
	if len(s.lines) == 0 {
		p.at(cols.partX, "No money moved in this period.", pdf.Style{Color: &pdf.ColorMuted, Size: pdf.SizeLabel})
		p.Down(stRow)
	}
	p.Down(stRow - 12)
	p.hairline(true)
	p.Down(14)
	b := pdf.Style{Font: pdf.Bold, Size: pdf.SizeLabel}
	p.at(cols.partX, "Total", b)
	p.right(cols.debitR, rupees(s.debit), pdf.Style{Color: &debitInk, Font: pdf.Bold, Size: pdf.SizeLabel})
	p.right(cols.creditR, rupees(s.credit), pdf.Style{Color: &pdf.ColorAccent, Font: pdf.Bold, Size: pdf.SizeLabel})
	p.right(cols.balanceR, rupees(s.closing), b)
	p.Down(28)
	if p.Top()-(5*stRow+12) < floor {
		p = newPage(false)
	}
	p.summary(s)
	if len(s.months) > 1 {
		if p.Top()-(34+float64(len(s.months))*(stRow-2)) < floor {
			p = newPage(false)
		}
		p.monthTable(s.months)
	}
	if len(s.staff) > 0 {
		if p.Top()-(34+float64(len(s.staff))*(stRow-2)) < floor {
			p = newPage(false)
		}
		p.staffTable(s.staff)
	}
	note := export.Sanitize("HostelPalika - generated " + bs.DocumentInstant(generated) + " from live records. Debit = money out, Credit = money in.")
	first := d.Pages() - len(pages) + 1
	for i, pg := range pages {
		d.GoToPage(first + i)
		footer(pg.Cursor, note, fmt.Sprintf("Page %d of %d", i+1, len(pages)))
	}
	d.GoToPage(d.Pages())
}

func footer(c *pdf.Cursor, note, reference string) {
	c.To(pdf.MarginBottom + pdf.SpaceRule)
	c.Rule(pdf.RuleOptions{})
	c.To(pdf.MarginBottom)
	c.Text(pdf.AtX, stLeft, note, pdf.Style{Color: &pdf.ColorMuted, Size: pdf.SizeFootnote})
	c.Text(pdf.AtX, stRight-c.Width(reference, pdf.Style{Font: pdf.Mono, Size: pdf.SizeFootnote}), reference, pdf.Style{Color: &pdf.ColorMuted, Font: pdf.Mono, Size: pdf.SizeFootnote})
}

func statementFilename(from, to string) string {
	if from == to {
		return "statement-" + from + ".pdf"
	}
	return "statement-" + from + "-to-" + to + ".pdf"
}

func (h *Handler) loadLedger(ctx context.Context, hostel bson.ObjectID, asker string, mineOnly bool) (*ledgerDoc, error) {
	m, err := h.ledger(ctx, hostel, asker, mineOnly)
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	var l ledgerDoc
	return &l, json.Unmarshal(raw, &l)
}

func sendPDF(c *gin.Context, body []byte, name string) {
	c.Header("cache-control", "no-store")
	c.Header("content-disposition", `attachment; filename="`+name+`"`)
	c.Data(200, "application/pdf", body)
}

func (h *Handler) statementPDF(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "viewPayments")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	for _, k := range []string{"from", "to"} {
		if v, ok := q[k]; ok {
			if _, _, good := bs.PeriodParts(v); !good {
				is.Add(k, "Use a BS month, YYYY-MM.")
			}
		}
	}
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, q["hostelId"])
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now()
	thisMonth, _ := bs.PeriodOf(now)
	from, to := q["from"], q["to"]
	if from == "" {
		from = thisMonth
	}
	if to == "" {
		to = from
	}
	ledger, err := h.loadLedger(c, hostel, p.UserID, p.Role != authz.HostelAdmin)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var row struct {
		Name string `bson:"name"`
	}
	_ = h.DB.Collection("hostels").FindOne(c, bson.D{{Key: "_id", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}})).Decode(&row)
	st, err := buildStatement(ledger, from, to)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	d := pdf.New()
	name := strings.TrimSpace(export.Sanitize(row.Name))
	if name == "" {
		name = "Your hostel"
	}
	d.SetMeta(name+" - statement "+rangeTitle(st), "HostelPalika", "HostelPalika")
	drawStatement(d, st, row.Name, now)
	body, err := d.Bytes()
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	sendPDF(c, body, statementFilename(st.from, st.to))
}

// ---- all branches ----

type overallFigures struct {
	closing, collected, due, moneyIn, moneyOut, residents, staffCash int64
	isBranch                                                         bool
	name                                                             string
}

type overallColumn struct {
	head  string
	money bool
	value func(overallFigures) int64
}

var overallColumns = map[string][]overallColumn{
	"report": {
		{"Residents", false, func(r overallFigures) int64 { return r.residents }},
		{"Collected", true, func(r overallFigures) int64 { return r.collected }},
		{"Due", true, func(r overallFigures) int64 { return r.due }},
		{"Spent", true, func(r overallFigures) int64 { return r.moneyOut }},
		{"Staff cash", true, func(r overallFigures) int64 { return r.staffCash }},
	},
	"statement": {
		{"Money in", true, func(r overallFigures) int64 { return r.moneyIn }},
		{"Money out", true, func(r overallFigures) int64 { return r.moneyOut }},
		{"Net", true, func(r overallFigures) int64 { return r.moneyIn - r.moneyOut }},
		{"Staff cash", true, func(r overallFigures) int64 { return r.staffCash }},
		{"Balance", true, func(r overallFigures) int64 { return r.closing }},
	},
}

func overallTable(kind string, rows []overallFigures) (headers []string, body [][]string, total []string) {
	cols := overallColumns[kind]
	show := func(m bool, v int64) string {
		if m {
			return rupees(v)
		}
		return money.GroupIN(v)
	}
	headers = []string{"Branch"}
	total = []string{fmt.Sprintf("All %d branches", len(rows))}
	for _, c := range cols {
		headers = append(headers, c.head)
		var sum int64
		for _, r := range rows {
			sum += c.value(r)
		}
		total = append(total, show(c.money, sum))
	}
	for _, r := range rows {
		name := r.name
		if !r.isBranch {
			name += " (main)"
		}
		line := []string{name}
		for _, c := range cols {
			line = append(line, show(c.money, c.value(r)))
		}
		body = append(body, line)
	}
	return
}

func (h *Handler) overallPDF(c *gin.Context) {
	p, err := h.Guards.RequireHostelAdmin(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	raw := map[string]any{}
	for k, v := range q {
		raw[k] = v
	}
	f := valid.NewForm(raw)
	def := "report"
	kind, _ := f.Enum("kind", true, &def, "report", "statement")
	f.Str("month", valid.S{Opt: true, Trim: true})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now()
	current, _ := bs.PeriodOf(now)
	month := valid.Trim(q["month"])
	if !(bs.IsBsPeriod(month) && month <= current) {
		month = current
	}
	branches, err := h.Branches.BranchFigures(c, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var figures []overallFigures
	var parts [][]byte
	for _, b := range branches {
		id, err := bson.ObjectIDFromHex(b.ID)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		ledger, err := h.loadLedger(c, id, p.UserID, false)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		st, err := buildStatement(ledger, month, month)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var staffCash int64
		for _, l := range st.staff {
			staffCash += l.left
		}
		collected, due := b.Collected, b.Due
		if kind == "report" {
			scoped := *p
			scoped.HostelIDs = []string{b.ID}
			report, err := h.Reports.PerformanceFor(c, &scoped, month)
			if err != nil {
				httpx.Fail(c, err)
				return
			}
			fin, _ := report.Get("finance")
			if fm, ok := fin.(interface{ Get(string) (any, bool) }); ok {
				if v, ok := fm.Get("collected"); ok {
					collected = jsRound(toFloat(v))
				}
				if v, ok := fm.Get("outstanding"); ok {
					due = jsRound(toFloat(v))
				}
			}
			body, _, err := reports.RenderPerformancePDF(report)
			if err != nil {
				httpx.Fail(c, err)
				return
			}
			parts = append(parts, body)
		} else {
			d := pdf.New()
			drawStatement(d, st, b.Name, now)
			body, err := d.Bytes()
			if err != nil {
				httpx.Fail(c, err)
				return
			}
			parts = append(parts, body)
		}
		figures = append(figures, overallFigures{closing: st.closing, collected: collected, due: due, isBranch: b.IsBranch, moneyIn: st.credit, moneyOut: st.debit, name: b.Name, residents: b.Residents, staffCash: staffCash})
	}
	headers, rows, total := overallTable(kind, figures)
	d := pdf.New()
	drawOverallCover(d, kind, month, headers, rows, total, now)
	for _, part := range parts {
		d.AppendPDF(part)
	}
	body, err := d.Bytes()
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	sendPDF(c, body, "all-branches-"+kind+"-"+month+".pdf")
}

func toFloat(v any) float64 {
	switch n := v.(type) {
	case int:
		return float64(n)
	case int32:
		return float64(n)
	case int64:
		return float64(n)
	case float64:
		return n
	}
	return 0
}

func drawOverallCover(d *pdf.Doc, kind, month string, headers []string, rows [][]string, total []string, generated time.Time) {
	const rowH, nameW = 18.0, 170.0
	cur := stPen{pdf.NewCursor(d)}
	title := "ALL BRANCHES REPORT"
	if kind != "report" {
		title = "ALL BRANCHES STATEMENT"
	}
	period := bs.FormatPeriod(month)
	d.SetMeta("HostelPalika - all branches "+kind+" "+period, "HostelPalika", "HostelPalika")
	d.Rect(0, pdf.PageHeight-stBanner, pdf.PageWidth, stBanner, nil, 0, &pdf.ColorAccent)
	cur.To(pdf.PageHeight - stBanner/2 - 6)
	cur.at(stLeft, "HostelPalika", pdf.Style{Color: &white, Font: pdf.Bold, Size: 17})
	cur.right(stRight, title, pdf.Style{Color: &white, Font: pdf.Bold, Size: 9, Tracking: 1.4})
	cur.To(pdf.PageHeight - stBanner - 30)
	cur.at(stLeft, fmt.Sprintf("%d branches", len(rows)), pdf.Style{Font: pdf.Bold, Size: 15})
	cur.Down(17)
	cur.at(stLeft, "Period: "+period, pdf.Style{Size: pdf.SizeBody})
	cur.right(stRight, "Generated "+bs.DocumentBsDate(generated), pdf.Style{Color: &pdf.ColorMuted, Size: pdf.SizeLabel})
	cur.Down(36)

	size := pdf.SizeLabel
	money := len(headers) - 1
	step := (pdf.ContentWidth - nameW) / float64(money)
	edge := func(i int) float64 { return stLeft + nameW + step*float64(i+1) - 6 }
	clip := func(text string, bold bool) string {
		font := pdf.Regular
		if bold {
			font = pdf.Bold
		}
		r := []rune(text)
		cut := r
		for len(cut) > 1 && d.Width(string(cut), font, size) > nameW-12 {
			cut = cut[:len(cut)-1]
		}
		if len(cut) == len(r) {
			return text
		}
		return strings.TrimRight(string(cut), " \t\n") + "..."
	}
	line := func(cells []string, bold bool) {
		font := pdf.Regular
		if bold {
			font = pdf.Bold
		}
		cur.at(stLeft+6, clip(export.Sanitize(cells[0]), bold), pdf.Style{Font: font, Size: size})
		for i, cell := range cells[1:] {
			cur.right(edge(i), cell, pdf.Style{Font: font, Size: size})
		}
	}
	d.Rect(stLeft, cur.Top()-6, pdf.ContentWidth, rowH+2, nil, 0, &pdf.ColorRuleStrong)
	cur.at(stLeft+6, headers[0], pdf.Style{Color: &white, Font: pdf.Bold, Size: size})
	for i, hd := range headers[1:] {
		cur.right(edge(i), hd, pdf.Style{Color: &white, Font: pdf.Bold, Size: size})
	}
	cur.Down(rowH + 4)
	for i, cells := range rows {
		if i%2 == 0 {
			d.Rect(stLeft, cur.Top()-5, pdf.ContentWidth, rowH, nil, 0, &zebra)
		}
		line(cells, false)
		cur.Down(rowH)
	}
	d.Line(stLeft, cur.Top()+12, stLeft+pdf.ContentWidth, cur.Top()+12, 1.1, pdf.ColorRuleStrong)
	line(total, true)
	cur.Down(rowH)
	cur.Down(10)
	cur.at(stLeft, "Each branch's own pages follow, in this order.", pdf.Style{Color: &pdf.ColorMuted, Size: pdf.SizeLabel})
	footer(cur.Cursor, export.Sanitize("HostelPalika - generated "+bs.DocumentInstant(generated)+" from live records."), "Cover")
}
