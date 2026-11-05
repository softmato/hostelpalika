package finance

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	"github.com/softmato/hostelpalika/server/internal/platform/pdf"
	"github.com/softmato/hostelpalika/server/internal/platform/qr"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

const (
	offerProgramTitle = "Resident Offer Program"
	receiptMargin     = 56.0
	maxStatementRows  = 28
	receiptPageWidth  = 595.28
)

var (
	receiptBrandGreen = pdf.RGB{R: 0.04, G: 0.54, B: 0.29}
	receiptInk        = pdf.RGB{}
	receiptStampGreen = pdf.RGB{R: 0.01, G: 0.36, B: 0.18}
	longMonths        = []string{"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"}
	englishMonths     = []string{"January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"}
	periodShape       = regexp.MustCompile(`^(\d{4})-(\d{2})$`)
)

// pdfSanitize is sanitize: anything outside printable ASCII becomes "?" per UTF-16 unit.
func pdfSanitize(text string) string {
	var b strings.Builder
	for _, r := range text {
		switch {
		case r >= ' ' && r <= '~':
			b.WriteRune(r)
		case r > 0xFFFF:
			b.WriteString("??")
		default:
			b.WriteByte('?')
		}
	}
	return b.String()
}

func isoDay(t time.Time) string { return t.UTC().Format("2006-01-02") }

func longDate(t time.Time) string {
	t = t.UTC()
	return fmt.Sprintf("%02d %s %d", t.Day(), longMonths[t.Month()-1], t.Year())
}

// MonthLabel is lib/format-month's monthLabel.
func MonthLabel(period string) string {
	if period == "" {
		return "—"
	}
	if label := bs.FormatPeriod(period); label != "" {
		return label
	}
	m := periodShape.FindStringSubmatch(period)
	if m == nil {
		return period
	}
	month, _ := strconv.Atoi(m[2])
	if month < 1 || month > 12 {
		return period
	}
	return englishMonths[month-1] + " " + m[1]
}

// ReceiptInput is ReceiptPdfInput.
type ReceiptInput struct {
	Amount               int64
	CertificationCode    string
	CoversFrom, CoversTo *time.Time
	HostelName           string
	Lines                []ReceiptLine
	InvoicePeriod        string
	IssuedAt             time.Time
	Method               string
	ReceiptNumber        string
	ReferenceCode        string
	ResidentName         string
	Room                 string // RoomLabel
	VoidReason           string
	VoidedAt             *time.Time
}

// ReceiptLine is one line of the bill printed on a receipt.
type ReceiptLine struct {
	Amount      int64  `bson:"amount"`
	Description string `bson:"description"`
}

func drawStamp(d *pdf.Doc, in *ReceiptInput, y float64) float64 {
	certified := in.CertificationCode != ""
	accent := receiptInk
	height := 76.0
	if certified {
		accent, height = receiptStampGreen, 90
	}
	const width = 236.0
	x := receiptPageWidth - receiptMargin - width
	fill := pdf.RGB{R: 0.96, G: 0.98, B: 0.97}
	d.Rect(x, y-height, width, height, &accent, 2, &fill)
	word, tag := "PAID", "RECEIPTED BY "+strings.ToUpper(email.PlatformName)
	if certified {
		word, tag = "CERTIFIED", pdfSanitize(strings.ToUpper(offerProgramTitle))
	}
	d.Text(x+16, y-26, word, pdf.Bold, 17, accent)
	d.Text(x+16, y-44, tag, pdf.Bold, 11, receiptInk)
	line := y - 62
	if certified {
		d.Text(x+16, line, pdfSanitize(in.CertificationCode), pdf.Bold, 12, receiptInk)
		line -= 16
	}
	d.Text(x+16, line, pdfSanitize(in.ReceiptNumber), pdf.Regular, 10, receiptInk)
	return height
}

// RenderReceiptPDF is renderReceiptPdf.
func RenderReceiptPDF(in ReceiptInput) ([]byte, error) {
	d := pdf.New()
	cursor := 785.0
	write := func(text string, font pdf.Font, size float64, color pdf.RGB, y float64) {
		d.Text(receiptMargin, y, pdfSanitize(text), font, size, color)
	}
	d.Text(receiptMargin, cursor, "Hostel", pdf.Bold, 20, receiptInk)
	d.Text(receiptMargin+d.Width("Hostel", pdf.Bold, 20), cursor, "Palika", pdf.Bold, 20, receiptBrandGreen)
	const title = "PAYMENT RECEIPT"
	d.Text(receiptPageWidth-receiptMargin-d.Width(title, pdf.Bold, 10), cursor+4, title, pdf.Bold, 10, receiptInk)
	cursor -= 20
	write("Issued on behalf of "+in.HostelName, pdf.Regular, 12, receiptInk, cursor)
	cursor -= 22
	d.Line(receiptMargin, cursor, receiptPageWidth-receiptMargin, cursor, 1.5, receiptInk)
	cursor -= 26

	// Laid out like the hostel's paper form: a shaded band per section, then
	// label-over-value fields on a ruled line, two to a row.
	contentWidth := receiptPageWidth - 2*receiptMargin
	column := contentWidth / 2
	band := pdf.RGB{R: 0.93, G: 0.95, B: 0.94}
	rule := pdf.RGB{R: 0.7, G: 0.7, B: 0.7}
	section := func(title string) {
		d.Rect(receiptMargin, cursor-6, contentWidth, 20, nil, 0, &band)
		d.Text(receiptMargin+8, cursor, title, pdf.Bold, 10, receiptInk)
		cursor -= 28
	}
	row := func(full bool, fields ...[2]string) {
		shown := fields[:0:0]
		for _, f := range fields {
			if f[1] != "" {
				shown = append(shown, f)
			}
		}
		if len(shown) == 0 {
			return
		}
		for i, f := range shown {
			x := receiptMargin + float64(i)*column
			width := column
			if full {
				width = contentWidth
			}
			size := 12.0
			if f[0] == "Amount" {
				size = 16
			}
			d.Text(x, cursor, f[0], pdf.Regular, 9, receiptInk)
			d.Text(x, cursor-16, pdfSanitize(f[1]), pdf.Bold, size, receiptInk)
			d.Line(x, cursor-22, x+width-16, cursor-22, 0.5, rule)
		}
		cursor -= 36
	}
	section("RECEIPT DETAILS")
	row(false, [2]string{"Receipt number", in.ReceiptNumber}, [2]string{"Issued on", longDate(in.IssuedAt)})
	section("RECEIVED FROM")
	row(false, [2]string{"Resident", in.ResidentName}, [2]string{"Room", in.Room})
	row(true, [2]string{"Paid to", in.HostelName})
	section("PAYMENT")
	row(false, [2]string{"Amount", money.FormatNPR(in.Amount)}, [2]string{"Period", in.InvoicePeriod})
	if in.CoversFrom != nil && in.CoversTo != nil {
		row(true, [2]string{"Covers", longDate(*in.CoversFrom) + " to " + longDate(*in.CoversTo)})
	}
	verification := in.CertificationCode
	if in.VoidedAt != nil {
		verification = ""
	}
	row(false, [2]string{"Reference", in.ReferenceCode}, [2]string{"Verification code", verification})
	row(true, [2]string{"Method", in.Method})
	if len(in.Lines) > 1 {
		section("BILL")
		right := func(text string, font pdf.Font) {
			text = pdfSanitize(text)
			d.Text(receiptPageWidth-receiptMargin-d.Width(text, font, 10), cursor, text, font, 10, receiptInk)
		}
		var total int64
		for _, l := range in.Lines {
			total += l.Amount
			desc := l.Description
			if valid.JSLen(desc) > 72 {
				desc = valid.JSPrefix(desc, 71) + "..."
			}
			write(desc, pdf.Regular, 10, receiptInk, cursor)
			right(money.FormatNPR(l.Amount), pdf.Regular)
			cursor -= 16
		}
		d.Line(receiptMargin, cursor+10, receiptPageWidth-receiptMargin, cursor+10, 0.5, receiptInk)
		cursor -= 4
		write("Bill total", pdf.Bold, 10, receiptInk, cursor)
		right(money.FormatNPR(total), pdf.Bold)
		cursor -= 16
	}

	if in.VoidedAt != nil {
		cursor -= 18
		write("VOID", pdf.Bold, 16, pdf.RGB{R: 0.7, G: 0.15, B: 0.15}, cursor)
		cursor -= 18
		text := "Voided " + isoDay(*in.VoidedAt)
		if in.VoidReason != "" {
			text += " — " + in.VoidReason
		}
		write(text, pdf.Regular, 11, receiptInk, cursor)
	} else {
		top := cursor - 24
		height := drawStamp(d, &in, top)
		if in.CertificationCode != "" {
			target := email.PlatformSiteURL + "/verify-receipt?code=" + strings.ReplaceAll(url.QueryEscape(in.CertificationCode), "+", "%20")
			png, err := qr.PNG(target, qr.Options{Width: 240, SetMargin: true})
			if err != nil {
				return nil, err
			}
			if err := d.PNG(png, receiptMargin, top-height, height, height); err != nil {
				return nil, err
			}
			cursor = top - height - 22
			write("Scan the code, or check this receipt at", pdf.Regular, 10, receiptInk, cursor)
			cursor -= 14
			write(strings.TrimPrefix(strings.TrimPrefix(email.PlatformSiteURL, "https://"), "http://")+"/verify-receipt", pdf.Bold, 10, receiptInk, cursor)
		}
	}
	write("Issued by "+email.PlatformName+" on behalf of "+in.HostelName+".", pdf.Regular, 10, receiptInk, 70)
	write("Computer-generated receipt. Not a proof-of-payment upload.", pdf.Regular, 10, receiptInk, 56)
	d.StampSystem(systemDocumentMarker + "-RECEIPT")
	return d.Bytes()
}

// StatementRow is one bill on a statement.
type StatementRow struct {
	DueAmount, PaidAmount int64
	Period, Status        string
}

// RenderStatementPDF is renderStatementPdf.
func RenderStatementPDF(generated time.Time, hostelName, residentName string, rows []StatementRow) ([]byte, error) {
	d := pdf.New()
	ink := pdf.RGB{R: 0.1, G: 0.12, B: 0.11}
	muted := pdf.RGB{}
	columns := []float64{receiptMargin, receiptMargin + 150, receiptMargin + 270, receiptMargin + 390}
	cursor := 785.0
	row := func(cells []string, font pdf.Font, size float64, color pdf.RGB) {
		for i, cell := range cells {
			d.Text(columns[i], cursor, pdfSanitize(cell), font, size, color)
		}
		cursor -= 20
	}
	d.Text(receiptMargin, cursor, pdfSanitize(hostelName), pdf.Bold, 18, ink)
	cursor -= 22
	d.Text(receiptMargin, cursor, pdfSanitize("Statement for "+residentName), pdf.Regular, 12, muted)
	cursor -= 16
	d.Text(receiptMargin, cursor, "Generated "+isoDay(generated), pdf.Regular, 10, muted)
	cursor -= 30
	row([]string{"Period", "Billed", "Paid", "Status"}, pdf.Bold, 10, muted)
	rule := pdf.RGB{R: 0.85, G: 0.87, B: 0.86}
	d.Line(receiptMargin, cursor+12, receiptPageWidth-receiptMargin, cursor+12, 1, rule)
	cursor -= 6
	var billed, paid int64
	for i, e := range rows {
		billed += e.DueAmount
		paid += e.PaidAmount
		if i < maxStatementRows {
			row([]string{e.Period, money.FormatNPR(e.DueAmount), money.FormatNPR(e.PaidAmount), e.Status}, pdf.Regular, 11, ink)
		}
	}
	if len(rows) > maxStatementRows {
		row([]string{"… " + strconv.Itoa(len(rows)-maxStatementRows) + " earlier periods not shown"}, pdf.Regular, 9, muted)
	}
	cursor -= 10
	d.Line(receiptMargin, cursor+12, receiptPageWidth-receiptMargin, cursor+12, 1, rule)
	cursor -= 8
	row([]string{"Total", money.FormatNPR(billed), money.FormatNPR(paid), ""}, pdf.Bold, 11, ink)
	row([]string{"Outstanding: " + money.FormatNPR(max(billed-paid, 0))}, pdf.Bold, 11, ink)
	d.Text(receiptMargin, 56, "Computer-generated statement issued by the hostel. Not a proof-of-payment upload.", pdf.Regular, 9, muted)
	d.StampSystem(systemDocumentMarker + "-STATEMENT")
	return d.Bytes()
}

// periodCoverage is periodCoverage.
func periodCoverage(period string) (from, to *time.Time) {
	m := periodShape.FindStringSubmatch(period)
	if m == nil {
		return nil, nil
	}
	month, _ := strconv.Atoi(m[2])
	if month < 1 || month > 12 {
		return nil, nil
	}
	if bs.IsBsPeriod(period) {
		b, err := bs.PeriodBounds(period)
		if err != nil {
			return nil, nil
		}
		return &b.Start, &b.LastDay
	}
	year, _ := strconv.Atoi(m[1])
	start := time.Date(year, time.Month(month), 1, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 1, -1)
	return &start, &end
}

// RenderReceiptByID is renderReceiptById for one resident: another resident's receipt
// reads as missing, never forbidden.
func RenderReceiptByID(ctx context.Context, db *mongo.Database, id string, resident bson.ObjectID) ([]byte, string, error) {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return nil, "", fmt.Errorf("receipt id %q: %w", id, err) // TS answers 500 here: mongoose's CastError
	}
	return renderReceipt(ctx, db, bson.D{{Key: "_id", Value: oid}, {Key: "residentId", Value: resident}})
}

// RenderReceiptForHostels is renderReceiptById for staff: outside their hostels reads as missing.
func RenderReceiptForHostels(ctx context.Context, db *mongo.Database, id bson.ObjectID, hostels bson.A) ([]byte, string, error) {
	return renderReceipt(ctx, db, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: bson.D{{Key: "$in", Value: hostels}}}})
}

// RenderReceiptForMail renders a receipt the server itself is sending.
func RenderReceiptForMail(ctx context.Context, db *mongo.Database, id bson.ObjectID) ([]byte, string, error) {
	return renderReceipt(ctx, db, bson.D{{Key: "_id", Value: id}})
}

func renderReceipt(ctx context.Context, db *mongo.Database, filter bson.D) ([]byte, string, error) {
	missing := Err("RECEIPT_NOT_FOUND", "Receipt was not found.")
	var rc struct {
		Amount     int64          `bson:"amount"`
		Cert       *string        `bson:"certificationCode"`
		EventID    *bson.ObjectID `bson:"eventId"`
		HostelID   bson.ObjectID  `bson:"hostelId"`
		InvoiceID  *bson.ObjectID `bson:"invoiceId"`
		IssuedAt   time.Time      `bson:"issuedAt"`
		Number     string         `bson:"receiptNumber"`
		ResidentID bson.ObjectID  `bson:"residentId"`
		VoidReason *string        `bson:"voidReason"`
		VoidedAt   *time.Time     `bson:"voidedAt"`
	}
	err := db.Collection("receipts").FindOne(ctx, filter).Decode(&rc)
	if err == mongo.ErrNoDocuments {
		return nil, "", missing
	}
	if err != nil {
		return nil, "", err
	}
	var hostel struct {
		Name string `bson:"name"`
	}
	if err := db.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: rc.HostelID}}).Decode(&hostel); err != nil && err != mongo.ErrNoDocuments {
		return nil, "", err
	}
	var person struct {
		First    string  `bson:"firstName"`
		Full     *string `bson:"fullName"`
		Last     string  `bson:"lastName"`
		RoomNo   *string `bson:"roomNumber"`
		RoomType string  `bson:"roomType"`
	}
	if err := db.Collection("residents").FindOne(ctx, bson.D{{Key: "_id", Value: rc.ResidentID}}).Decode(&person); err != nil && err != mongo.ErrNoDocuments {
		return nil, "", err
	}
	in := ReceiptInput{Amount: rc.Amount, CertificationCode: deref(rc.Cert), HostelName: hostel.Name, IssuedAt: rc.IssuedAt, ReceiptNumber: rc.Number, VoidReason: deref(rc.VoidReason), VoidedAt: rc.VoidedAt}
	if in.HostelName == "" {
		in.HostelName = "Hostel"
	}
	if person.Full != nil {
		in.ResidentName = *person.Full
	} else {
		names := []string{}
		for _, n := range []string{person.First, person.Last} {
			if n != "" {
				names = append(names, n)
			}
		}
		in.ResidentName = strings.Join(names, " ")
	}
	in.Room = RoomLabel(deref(person.RoomNo), person.RoomType)
	period := ""
	if rc.InvoiceID != nil {
		var inv struct {
			From      *time.Time    `bson:"coversFrom"`
			To        *time.Time    `bson:"coversTo"`
			Lines     []ReceiptLine `bson:"lines"`
			Period    *string       `bson:"period"`
			Reference *string       `bson:"referenceCode"`
		}
		if err := db.Collection("invoices").FindOne(ctx, bson.D{{Key: "_id", Value: *rc.InvoiceID}}).Decode(&inv); err != nil && err != mongo.ErrNoDocuments {
			return nil, "", err
		}
		period = deref(inv.Period)
		in.Lines, in.ReferenceCode = inv.Lines, deref(inv.Reference)
		in.CoversFrom, in.CoversTo = inv.From, inv.To
	}
	if in.CoversFrom == nil || in.CoversTo == nil {
		in.CoversFrom, in.CoversTo = periodCoverage(period)
	}
	if period != "" {
		in.InvoicePeriod = MonthLabel(period)
	}
	if rc.EventID != nil {
		var ev struct {
			Source string `bson:"source"`
		}
		if err := db.Collection("paymentevents").FindOne(ctx, bson.D{{Key: "_id", Value: *rc.EventID}}).Decode(&ev); err != nil && err != mongo.ErrNoDocuments {
			return nil, "", err
		}
		if ev.Source == "OFFER_PROGRAM" {
			in.Method = "Paid by " + email.PlatformName + " - " + offerProgramTitle
		}
	}
	out, err := RenderReceiptPDF(in)
	return out, rc.Number, err
}

// RoomLabel is roomLabel: the room as written on the paper form, number first
// (`Room 204, Double Sharing`); an all-caps type such as `SINGLE` reads `Single`.
func RoomLabel(number, roomType string) string {
	t := strings.TrimSpace(strings.ReplaceAll(roomType, "_", " "))
	if t != "" && t == strings.ToUpper(t) {
		words := strings.Fields(strings.ToLower(t))
		for i, w := range words {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
		t = strings.Join(words, " ")
	}
	number = strings.TrimSpace(number)
	switch {
	case number != "" && t != "":
		return "Room " + number + ", " + t
	case number != "":
		return "Room " + number
	}
	return t
}
