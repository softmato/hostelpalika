package bookings

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	"github.com/softmato/hostelpalika/server/internal/platform/pdf"
)

// booking-document.ts + document-parts.ts + amount-in-words.ts. The payout advice
// lands with the hostel's route in Phase 6: nobody on this surface may read one.

// Issuer is who the paper is from (the `issuer` site-config section).
type Issuer struct {
	Address       string `json:"address"`
	Email         string `json:"email"`
	LegalName     string `json:"legalName"`
	Pan           string `json:"pan"`
	Phone         string `json:"phone"`
	ProductName   string `json:"productName"`
	VatRegistered bool   `json:"vatRegistered"`
}

func (s *Service) loadIssuer(ctx context.Context) (Issuer, error) {
	var i Issuer
	v, err := s.cfg.Section(ctx, "issuer")
	if err != nil {
		return i, err
	}
	return i, platformconfig.Decode(v, &i)
}

func amountInWords(rupees int64) string { return money.AmountInWords(rupees) }

func documentBsDate(t time.Time) string { return bs.DocumentBsDate(t) }

func documentInstant(t time.Time) string { return bs.DocumentInstant(t) }

type docField struct{ Label, Value string }

// docLayout is BookingDocumentInput.
type docLayout struct {
	Against                *docField
	Amount                 int64
	AmountLabel, Currency  string
	Date                   time.Time
	DateLabel              string
	Fields                 []docField
	FooterNote             string
	Issuer                 Issuer
	Notes                  []string
	Number, NumberLabel    string
	PartyDetail, PartyName string
	PartyEyebrow, Title    string
}

func refundPolicyNotes(b *Booking, moneyText func(int64) string) []string {
	t := b.Terms
	notes := []string{"Refund policy for this booking:",
		"- Full refund (" + moneyText(b.Fee) + ") if cancelled before the hostel confirms, or if the hostel",
		"  declines, does not answer within " + jsNum(t.HostelAnswerHours) + " hours, or cancels."}
	for _, r := range policyRows(t, b.Fee) {
		span := "s " + jsNum(r.FromDay) + "-" + jsNum(r.ThroughDay)
		if r.FromDay == r.ThroughDay {
			span = " " + jsNum(r.FromDay)
		}
		notes = append(notes, "- Cancelled on day"+span+" after confirmation: "+jsNum(r.RefundPercent)+"% ("+moneyText(r.Refund)+").")
	}
	return append(notes, "- Not moved in within "+jsNum(t.HoldDays)+" days of confirmation: "+jsNum(t.NoShowRefundPercent)+"% ("+moneyText(settlementFor(b.Fee, t.NoShowRefundPercent, t.HostelSharePercent).Refund)+").",
		"The booking fee does not count towards rent, admission fee or deposit.")
}

// documentLayout is bookingDocumentLayout for the three papers a guest may read.
func documentLayout(kind string, b *Booking, transfer *Transfer, issuer Issuer) docLayout {
	currency := b.Currency
	if currency == "" {
		currency = "NPR"
	}
	moneyText := func(a int64) string { return currency + " " + money.DocumentAmount(a) }
	forLine := "Booking fee - " + email.RoomTypeLabel(b.RoomType) + ", " + b.HostelSnapshot.Name
	l := docLayout{Currency: currency, Issuer: issuer, PartyName: b.Guest.Name, PartyDetail: b.Guest.Email}
	stayField := func() []docField {
		if b.Stay == nil {
			return nil
		}
		return []docField{{"Stay", fmt.Sprintf("%d nights, %s (%s)", b.Stay.Nights, stayDatesText(b.Stay), moneyText(b.Stay.Amount))}}
	}
	paid := b.PaymentVerifiedAt != nil
	due := "Unpaid - pay by " + documentInstant(b.PaymentDueBy)
	receipt := ""
	if b.ReceiptNumber != nil {
		receipt = *b.ReceiptNumber
	}
	switch {
	case kind == "invoice" && b.SoftmatoInvoiceNo != nil && *b.SoftmatoInvoiceNo != "":
		status := due
		l.AmountLabel = "Booking fee due"
		if paid {
			status, l.AmountLabel = strings.TrimSpace("Paid - Softmato receipt "+receipt), "Booking fee paid"
		}
		l.Against = &docField{"Invoice (Softmato)", *b.SoftmatoInvoiceNo}
		l.Amount, l.Date, l.DateLabel = b.Total(), b.CreatedAt, "Booked on"
		l.Fields = append(append([]docField{{"Hostel", b.HostelSnapshot.Name}, {"Room", b.RoomType}, {"Monthly rent", moneyText(b.MonthlyRent)}}, stayField()...), docField{"Status", status})
		l.FooterNote = "Booking confirmation. The invoice and receipt for the fee are issued by Softmato."
		l.Notes, l.Number, l.NumberLabel, l.PartyEyebrow, l.Title = refundPolicyNotes(b, moneyText), b.Code, "Booking", "Booked by", "Booking Confirmation"
	case kind == "invoice":
		status := due
		l.AmountLabel = "Amount due"
		if paid {
			status, l.AmountLabel = strings.TrimSpace("Paid - receipt "+receipt), "Amount paid"
		}
		l.Amount, l.Date, l.DateLabel = b.Total(), b.CreatedAt, "Invoice Date"
		l.Fields = append(append([]docField{{"For", forLine}, {"Booking code", b.Code}, {"Monthly rent", moneyText(b.MonthlyRent)}}, stayField()...),
			docField{"Fee rate", jsNum(b.Terms.FeePercent) + "% of one month's rent"}, docField{"Status", status})
		l.FooterNote = "Computer-generated invoice. No signature required."
		l.Notes, l.Number, l.NumberLabel, l.PartyEyebrow, l.Title = refundPolicyNotes(b, moneyText), b.InvoiceNumber, "Invoice No.", "Billed to", "Booking Invoice"
	case kind == "receipt":
		checked := ""
		l.Date = b.CreatedAt
		if paid {
			checked, l.Date = documentInstant(*b.PaymentVerifiedAt), *b.PaymentVerifiedAt
		}
		l.Against = &docField{"Against Invoice", b.InvoiceNumber}
		l.Amount, l.AmountLabel, l.DateLabel = b.Total(), "Amount received", "Receipt Date"
		l.Fields = []docField{{"For", forLine}, {"Booking code", b.Code}, {"Checked at", checked}}
		l.FooterNote = "Computer-generated receipt. No signature required."
		l.Notes = []string{issuer.LegalName + " holds this fee until the booking ends, then refunds it or pays the", "hostel its share, under the refund policy printed on the invoice."}
		l.Number, l.NumberLabel, l.PartyEyebrow, l.Title = receipt, "Receipt No.", "Received from", "Booking Fee Receipt"
	case kind == "payout":
		sent := time.Now()
		at, tx, number := "", "", ""
		if transfer.SentAt != nil {
			sent, at = *transfer.SentAt, documentInstant(*transfer.SentAt)
		}
		if transfer.TransactionID != nil {
			tx = *transfer.TransactionID
		}
		if transfer.DocumentNumber != nil {
			number = *transfer.DocumentNumber
		}
		var refund, kept int64
		if b.Settlement != nil {
			if b.Settlement.Refund != nil {
				refund = *b.Settlement.Refund
			}
			if b.Settlement.Kept != nil {
				kept = *b.Settlement.Kept
			}
		}
		share := jsNum(b.Terms.HostelSharePercent) + "% of kept"
		if b.Stay != nil {
			share = jsNum(b.Terms.HostelSharePercent) + "% of the fee kept, " + jsNum(b.Stay.HostelSharePercent) + "% of the nights kept"
		}
		l.Against = &docField{"Booking", b.Code}
		l.Amount, l.AmountLabel, l.Date, l.DateLabel = transfer.Amount, "Amount paid out", sent, "Advice Date"
		l.Fields = []docField{{"Guest", b.Guest.Name}, {"Room type", b.RoomType}, {"Booking fee", moneyText(b.Fee)}, {"Refunded to guest", moneyText(refund)}, {"Kept", moneyText(kept)},
			{"Hostel share", share}, {"Transaction ID", tx}, {"Sent at", at}}
		l.FooterNote = "Computer-generated payout advice. No signature required."
		l.Number, l.NumberLabel, l.PartyName, l.PartyEyebrow, l.PartyDetail, l.Title = number, "Advice No.", b.HostelSnapshot.Name, "Paid to", destinationText(transfer.Destination), "Payout Advice"
	default: // refund
		sent := time.Now()
		at := ""
		if transfer.SentAt != nil {
			sent, at = *transfer.SentAt, documentInstant(*transfer.SentAt)
		}
		rate := ""
		if b.Settlement != nil && b.Settlement.RefundPercent != nil {
			rate = jsNum(*b.Settlement.RefundPercent) + "%"
		}
		if receipt != "" {
			l.Against = &docField{"Against Receipt", receipt}
		}
		tx := ""
		if transfer.TransactionID != nil {
			tx = *transfer.TransactionID
		}
		number := ""
		if transfer.DocumentNumber != nil {
			number = *transfer.DocumentNumber
		}
		l.Amount, l.AmountLabel, l.Date, l.DateLabel = transfer.Amount, "Amount refunded", sent, "Refund Date"
		l.Fields = []docField{{"Booking code", b.Code}, {"Paid", moneyText(b.Total())}, {"Refund rate", rate}, {"Reason", statusLabels[b.Status]}, {"Transaction ID", tx}, {"Sent at", at}}
		l.FooterNote = "Computer-generated refund note. No signature required."
		l.Number, l.NumberLabel, l.PartyEyebrow, l.PartyDetail, l.Title = number, "Refund Note No.", "Refunded to", destinationText(transfer.Destination), "Refund Note"
	}
	return l
}

func (l docLayout) encodable() bool {
	parts := []string{l.AmountLabel, l.Number, l.PartyName, l.PartyDetail, l.Issuer.LegalName, l.Issuer.Email, l.Issuer.Pan, l.Issuer.ProductName, l.FooterNote}
	for _, f := range l.Fields {
		parts = append(parts, f.Label, f.Value)
	}
	parts = append(parts, l.Notes...)
	for _, s := range parts {
		if !pdf.Encodable(s) {
			return false
		}
	}
	return true
}

// renderDocument is renderBookingDocument. A guest name WinAnsi cannot hold is an
// error, as pdf-lib's throw: the download answers 500, the mail loses its paper.
func renderDocument(l docLayout) ([]byte, error) {
	if !l.encodable() {
		return nil, errors.New("booking document: text outside WinAnsi")
	}
	d := pdf.New()
	creator := l.Issuer.ProductName
	if creator == "" {
		creator = l.Issuer.LegalName
	}
	d.SetMeta(l.Title+" "+l.Number, l.Issuer.LegalName, creator)
	c := pdf.NewCursor(d)
	accent, label := &pdf.ColorAccent, &pdf.ColorLabel
	regular, mono := pdf.Regular, pdf.Mono

	c.Line(pdf.AtX, pdf.MarginLeft, l.Issuer.LegalName, pdf.Style{Font: pdf.Bold, Size: pdf.SizeIssuer})
	if l.Issuer.Pan != "" {
		c.Line(pdf.AtX, pdf.MarginLeft, "PAN:  "+l.Issuer.Pan, pdf.Style{Color: label, Size: pdf.SizeLabel})
	}
	if l.Issuer.Email != "" {
		c.Line(pdf.AtX, pdf.MarginLeft, l.Issuer.Email, pdf.Style{Color: accent, Size: pdf.SizeLabel})
	}
	c.Down(pdf.SpaceTight)
	c.RuleStrong()
	c.Down(pdf.SpaceTight)
	c.Title(pdf.Center, 0, l.Title)
	c.Down(pdf.SpaceTight)

	c.Field(l.NumberLabel, l.Number, pdf.FieldOptions{ValueColor: accent})
	c.Field(l.DateLabel, documentBsDate(l.Date), pdf.FieldOptions{Suffix: "(" + bs.DocumentAdDate(l.Date) + ")"})
	if l.Against != nil {
		c.Field(l.Against.Label, l.Against.Value, pdf.FieldOptions{})
	}
	c.Down(pdf.SpaceTight)
	c.Rule(pdf.RuleOptions{})

	c.Eyebrow(pdf.AtX, pdf.MarginLeft, l.PartyEyebrow)
	c.Line(pdf.AtX, pdf.MarginLeft, l.PartyName, pdf.Style{Font: pdf.Bold, Size: pdf.SizePartyName})
	if l.PartyDetail != "" {
		c.Line(pdf.AtX, pdf.MarginLeft, l.PartyDetail, pdf.Style{Color: accent, Size: pdf.SizeLabel})
	}
	c.Down(pdf.SpaceTight)
	c.Rule(pdf.RuleOptions{})

	c.Down(pdf.SpaceTight)
	c.Eyebrow(pdf.Center, 0, l.AmountLabel)
	c.Down(pdf.SpaceBlock)
	c.Line(pdf.Center, 0, l.Currency+" "+money.DocumentAmount(l.Amount), pdf.Style{Font: pdf.MonoBold, Size: pdf.SizeAmount})
	c.Down(4)
	c.Line(pdf.Center, 0, amountInWords(l.Amount), pdf.Style{Color: accent, Size: pdf.SizeLabel})
	c.Down(pdf.SpaceBlock)
	c.Rule(pdf.RuleOptions{})

	for _, f := range l.Fields {
		if strings.TrimSpace(f.Value) != "" {
			c.Field(f.Label, f.Value, pdf.FieldOptions{ValueFont: &regular})
		}
	}
	c.Down(pdf.SpaceTight)
	c.Rule(pdf.RuleOptions{})

	for _, n := range l.Notes {
		c.Line(pdf.AtX, pdf.MarginLeft, n, pdf.Style{Color: accent, Size: pdf.SizeFootnote})
	}
	if len(l.Notes) > 0 {
		c.Down(pdf.SpaceTight)
	}
	if !l.Issuer.VatRegistered {
		c.Line(pdf.AtX, pdf.MarginLeft, l.Issuer.LegalName+" is PAN-registered and is not registered for VAT. No VAT is", pdf.Style{Color: accent, Size: pdf.SizeFootnote})
		c.Line(pdf.AtX, pdf.MarginLeft, "charged on this document.", pdf.Style{Color: accent, Size: pdf.SizeFootnote})
	}

	c.To(pdf.MarginBottom + pdf.SpaceRule)
	c.Rule(pdf.RuleOptions{})
	c.To(pdf.MarginBottom)
	muted := &pdf.ColorMuted
	c.Text(pdf.AtX, pdf.MarginLeft, l.FooterNote, pdf.Style{Color: muted, Size: pdf.SizeFootnote})
	w := c.Width(l.Number, pdf.Style{Font: mono, Size: pdf.SizeFootnote})
	c.Text(pdf.AtX, pdf.PageWidth-pdf.MarginRight-w, l.Number, pdf.Style{Color: muted, Font: mono, Size: pdf.SizeFootnote})
	return d.Bytes()
}

func documentFileName(number string) string { return strings.ReplaceAll(number, "/", "-") + ".pdf" }

// attachment is bookingDocumentAttachment: never fails the mail it rides on.
// HostelDocument is GET /hostel-admin/bookings/documents/:number: the payout
// advice of one of the caller's own hostels; anything else is a plain 404.
func (s *Signed) HostelDocument(c *gin.Context) {
	p := authz.From(c)
	number, _ := url.PathUnescape(c.Param("number"))
	var t Transfer
	err := s.db.Collection("bookingtransfers").FindOne(c, bson.D{{Key: "documentNumber", Value: number}, {Key: "kind", Value: "PAYOUT"}, {Key: "status", Value: "SENT"}}).Decode(&t)
	var b Booking
	if err == nil {
		err = s.db.Collection("bookings").FindOne(c, bson.D{{Key: "_id", Value: t.BookingID}}).Decode(&b)
	}
	if errors.Is(err, mongo.ErrNoDocuments) || number == "" || (err == nil && !slices.Contains(p.HostelIDs, b.HostelID.Hex())) {
		notFoundPlain(c)
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	issuer, err := s.loadIssuer(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	data, err := renderDocument(documentLayout("payout", &b, &t, issuer))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	sendDocument(c, number, "application/pdf", data)
}

func (s *Signed) attachment(ctx context.Context, b *Booking) []email.Attachment {
	issuer, err := s.loadIssuer(ctx)
	if err != nil {
		return nil
	}
	bytes, err := renderDocument(documentLayout("invoice", b, nil, issuer))
	if err != nil {
		return nil
	}
	return []email.Attachment{{Content: bytes, Filename: documentFileName(b.InvoiceNumber)}}
}

func notFoundPlain(c *gin.Context) { c.Data(404, "text/plain;charset=UTF-8", []byte("Not found")) }

// document is GET /bookings/documents/:kind/:number: the booker's invoice, receipt
// and refund note; anything else is the same 404 as a number that does not exist.
func (s *Signed) document(c *gin.Context) {
	p, err := s.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	kind, number := c.Param("kind"), c.Param("number")
	if number == "" || (kind != "invoice" && kind != "receipt" && kind != "refund") {
		notFoundPlain(c)
		return
	}
	var b Booking
	var transfer *Transfer
	bookings := s.db.Collection("bookings")
	switch kind {
	case "invoice":
		err = bookings.FindOne(c, bson.D{{Key: "invoiceNumber", Value: number}}).Decode(&b)
	case "receipt":
		err = bookings.FindOne(c, bson.D{{Key: "paymentVerifiedAt", Value: bson.D{{Key: "$ne", Value: nil}}}, {Key: "receiptNumber", Value: number}}).Decode(&b)
	default:
		var t Transfer
		err = s.db.Collection("bookingtransfers").FindOne(c, bson.D{{Key: "documentNumber", Value: number}, {Key: "kind", Value: "REFUND"}, {Key: "status", Value: "SENT"}}).Decode(&t)
		if err == nil {
			transfer = &t
			err = bookings.FindOne(c, bson.D{{Key: "_id", Value: t.BookingID}}).Decode(&b)
		}
	}
	if errors.Is(err, mongo.ErrNoDocuments) || (err == nil && b.UserID.Hex() != p.UserID) {
		notFoundPlain(c)
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	draw := func() ([]byte, error) {
		issuer, err := s.loadIssuer(c)
		if err != nil {
			return nil, err
		}
		return renderDocument(documentLayout(kind, &b, transfer, issuer))
	}
	if kind == "receipt" && b.SoftmatoInvoiceNo != nil && *b.SoftmatoInvoiceNo != "" {
		var cached struct {
			Bytes       bson.Binary `bson:"bytes"`
			ContentType string      `bson:"contentType"`
		}
		err := s.db.Collection("softmatodocuments").FindOne(c, bson.D{{Key: "kind", Value: "receipt"}, {Key: "number", Value: number}, {Key: "version", Value: "1"}}).Decode(&cached)
		if err == nil && strings.HasPrefix(string(cached.Bytes.Data), "%PDF-") {
			sendDocument(c, number, cached.ContentType, cached.Bytes.Data)
			return
		}
		if !s.SoftmatoOn {
			httpx.Fail(c, httpx.NewError(503, "SOFTMATO_UNAVAILABLE", "Our parent company's server is not responding right now. We have saved this and will email you to complete it as soon as the server is back. Thank you for your patience.", nil))
			return
		}
		// ponytail: fetching their copy needs the Softmato client (Phase 8); until
		// then our own drawing answers, as TS does when they send no PDF.
	}
	data, err := draw()
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	sendDocument(c, number, "application/pdf", data)
}

func sendDocument(c *gin.Context, number, contentType string, data []byte) {
	c.Header("Cache-Control", "private, no-store")
	c.Header("Content-Disposition", `attachment; filename="`+documentFileName(number)+`"`)
	c.Data(200, contentType, data)
}
