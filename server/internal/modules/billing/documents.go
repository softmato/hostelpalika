package billing

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	"github.com/softmato/hostelpalika/server/internal/platform/pdf"
	"github.com/softmato/hostelpalika/server/internal/platform/plans"
	"github.com/softmato/hostelpalika/server/internal/platform/softmato"
)

// Issuer is the company printed on a plan document.
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
	raw, err := s.Config.Section(ctx, "issuer")
	if err != nil {
		return i, err
	}
	return i, platformconfig.Decode(raw, &i)
}

func (i Issuer) creator() string {
	if i.ProductName != "" {
		return i.ProductName
	}
	return i.LegalName
}

func docAmount(rupees int64) string { return money.FormatPaisa(rupees * 100) }

func drawIssuer(c *pdf.Cursor, i Issuer, compact bool) {
	c.Line(pdf.AtX, pdf.MarginLeft, i.LegalName, pdf.Style{Font: pdf.Bold, Size: pdf.SizeIssuer})
	line := func(v string, color *pdf.RGB) {
		if v != "" {
			c.Line(pdf.AtX, pdf.MarginLeft, v, pdf.Style{Color: color, Size: pdf.SizeLabel})
		}
	}
	accent, label := pdf.ColorAccent, pdf.ColorLabel
	if !compact {
		line(i.Address, &accent)
		line(i.Phone, &label)
	}
	if compact && i.Pan != "" {
		line("PAN:  "+i.Pan, &label)
	}
	line(i.Email, &accent)
	if !compact && i.Pan != "" {
		line("PAN: "+i.Pan, &label)
	}
}

func drawTaxNote(c *pdf.Cursor, i Issuer) {
	if i.VatRegistered {
		return
	}
	accent := pdf.ColorAccent
	c.Line(pdf.AtX, pdf.MarginLeft, i.LegalName+" is PAN-registered and is not registered for VAT. No VAT is", pdf.Style{Color: &accent, Size: pdf.SizeFootnote})
	c.Line(pdf.AtX, pdf.MarginLeft, "charged on this document.", pdf.Style{Color: &accent, Size: pdf.SizeFootnote})
}

func drawFooter(c *pdf.Cursor, note, reference string) {
	muted := pdf.ColorMuted
	c.To(pdf.MarginBottom + pdf.SpaceRule)
	c.Rule(pdf.RuleOptions{})
	c.To(pdf.MarginBottom)
	c.Text(pdf.AtX, pdf.MarginLeft, note, pdf.Style{Color: &muted, Size: pdf.SizeFootnote})
	c.Text(pdf.Right, 0, reference, pdf.Style{Color: &muted, Font: pdf.Mono, Size: pdf.SizeFootnote})
}

type invoicePrint struct {
	inv          *planInvoice
	amountPaid   int64
	number       string
	issuer       Issuer
	presentation *softmato.Presentation
	lineLabel    string
}

func (in invoicePrint) render() ([]byte, error) {
	d := pdf.New()
	c := pdf.NewCursor(d)
	inv := in.inv
	issuedAt := time.Now()
	if inv.LocalIssuedAt != nil {
		issuedAt = *inv.LocalIssuedAt
	} else if inv.IssuedAt != nil {
		issuedAt = *inv.IssuedAt
	}
	d.SetMeta("Invoice "+in.number, in.issuer.LegalName, in.issuer.creator())
	subtotal := inv.Amount
	due := max(0, subtotal-in.amountPaid)
	status := "UNPAID"
	switch {
	case inv.Status == "VOID":
		status = "VOID"
	case in.amountPaid >= inv.Amount:
		status = "PAID"
	case in.amountPaid > 0:
		status = "PARTLY PAID"
	}
	currency := "NPR"
	if inv.Currency != nil {
		currency = *inv.Currency
	}
	accent, label, muted, text := pdf.ColorAccent, pdf.ColorLabel, pdf.ColorMuted, pdf.ColorText

	top := c.Top()
	drawIssuer(c, in.issuer, false)
	after := c.Top()
	c.To(top)
	c.Title(pdf.Right, 0, "Invoice")
	c.Down(pdf.SpaceTight)
	metaX := pdf.PageWidth - pdf.MarginRight - 250
	c.Field("Invoice No.", in.number, pdf.FieldOptions{LabelX: metaX})
	c.Field("Fiscal Year", bs.FiscalYear(issuedAt), pdf.FieldOptions{LabelX: metaX})
	c.Field("Invoice Date", bs.DocumentBsDate(issuedAt), pdf.FieldOptions{LabelX: metaX, Suffix: "(" + bs.DocumentAdDate(issuedAt) + ")"})
	c.To(min(after, c.Top()) - pdf.SpaceTight)
	c.RuleStrong()

	billed := inv.BilledTo.Name
	if billed == "" {
		billed = inv.BilledTo.HostelName
	}
	partiesTop := c.Top()
	c.Eyebrow(pdf.AtX, pdf.MarginLeft, "Bill to")
	c.Line(pdf.AtX, pdf.MarginLeft, billed, pdf.Style{Font: pdf.Bold, Size: pdf.SizePartyName})
	c.Line(pdf.AtX, pdf.MarginLeft, "PAN not recorded", pdf.Style{Color: &muted, Size: pdf.SizeLabel})
	if inv.BilledTo.Email != "" {
		c.Line(pdf.AtX, pdf.MarginLeft, inv.BilledTo.Email, pdf.Style{Color: &accent, Size: pdf.SizeLabel})
	}
	afterParties := c.Top()
	c.To(partiesTop)
	c.Eyebrow(pdf.Right, 0, "Status")
	stampColor := text
	if status == "PAID" {
		stampColor = accent
	}
	_, stampH := c.Stamp(status, pdf.StampOptions{Color: &stampColor, Top: c.Top() + pdf.SizeEyebrow})
	c.Down(stampH - pdf.SizeEyebrow + pdf.SpaceTight)
	headline, figure := "Amount due", due
	if status == "PAID" {
		headline, figure = "Amount received", subtotal
	}
	c.Line(pdf.Right, 0, headline, pdf.Style{Color: &label, Size: pdf.SizeLabel})
	c.Line(pdf.Right, 0, currency+" "+docAmount(figure), pdf.Style{Font: pdf.MonoBold, Size: 15})
	c.To(min(afterParties, c.Top()) - pdf.SpaceTight)
	c.Rule(pdf.RuleOptions{})

	left := pdf.MarginLeft
	amountRight, rateRight, qtyRight := pdf.PageWidth-pdf.MarginRight, left+420, left+340
	for _, h := range []struct {
		x     float64
		label string
		right bool
	}{{left, "#", false}, {left + 26, "Description", false}, {left + 218, "Period", false}, {qtyRight, "Qty", true}, {rateRight, "Rate", true}, {amountRight, "Amount", true}} {
		t := strings.ToUpper(h.label)
		st := pdf.Style{Color: &label, Size: pdf.SizeEyebrow, Tracking: 1}
		w := 0.0
		if h.right {
			w = c.Width(t, st)
		}
		c.Text(pdf.AtX, h.x-w, t, st)
	}
	c.Down(pdf.SpaceLine + 4)
	mono := pdf.Style{Font: pdf.Mono, Size: pdf.SizeBody}
	c.Text(pdf.AtX, left, "1", pdf.Style{Font: pdf.Mono})
	c.Text(pdf.AtX, left+26, in.lineLabel, pdf.Style{Size: pdf.SizeBody})
	c.Text(pdf.AtX, left+218, "—", pdf.Style{Color: &muted, Font: pdf.Mono})
	for _, v := range []struct {
		right float64
		value string
	}{{qtyRight, "1"}, {rateRight, docAmount(inv.Amount)}, {amountRight, docAmount(inv.Amount)}} {
		c.Text(pdf.AtX, v.right-c.Width(v.value, mono), v.value, mono)
	}
	c.Down(pdf.SpaceLine + 2)
	c.Down(pdf.SpaceTight)

	labelX := left + 240
	total := func(name string, value int64, emphasis bool) {
		d.Line(labelX, c.Top()+9, amountRight, c.Top()+9, 0.6, pdf.ColorRule)
		st := pdf.Style{Color: &label, Size: pdf.SizeLabel}
		font := pdf.Mono
		if emphasis {
			st = pdf.Style{Color: &text, Font: pdf.Bold, Size: pdf.SizeBody + 0.5}
			font = pdf.MonoBold
		}
		c.Text(pdf.AtX, labelX, name, st)
		v := docAmount(value)
		fig := pdf.Style{Font: font, Size: pdf.SizeBody}
		c.Text(pdf.AtX, amountRight-c.Width(v, fig), v, fig)
		c.Down(pdf.SpaceLine + 2)
	}
	total("Subtotal", subtotal, false)
	total("Total ("+currency+")", subtotal, true)
	total("Amount paid", in.amountPaid, false)
	total("Amount due", due, true)
	c.Down(pdf.SpaceTight)
	c.Rule(pdf.RuleOptions{})
	w := c.Text(pdf.AtX, left, "AMOUNT IN WORDS", pdf.Style{Color: &label, Size: pdf.SizeEyebrow, Tracking: 1.2})
	c.Text(pdf.AtX, left+w+12, money.AmountInWords(subtotal), pdf.Style{Size: pdf.SizeBody})
	c.Down(pdf.SpaceRule + 2)
	c.Rule(pdf.RuleOptions{})
	if p := in.presentation; p != nil {
		c.Eyebrow(pdf.AtX, left, p.PlanName)
		if p.Tagline != "" {
			c.Line(pdf.AtX, left, p.Tagline, pdf.Style{Color: &accent, Size: pdf.SizeLabel})
		}
		if len(p.Features) > 0 {
			c.Down(4)
			for i := 0; i < len(p.Features); i += 2 {
				for col := 0; col < 2 && i+col < len(p.Features); col++ {
					x := left + float64(col)*pdf.ContentWidth/2
					c.Text(pdf.AtX, x, "•", pdf.Style{Color: &label, Size: pdf.SizeLabel})
					c.Text(pdf.AtX, x+9, p.Features[i+col], pdf.Style{Color: &label, Size: pdf.SizeLabel})
				}
				c.Down(pdf.SpaceLine)
			}
		}
		if len(p.Highlights) > 0 {
			c.Line(pdf.AtX, left, strings.Join(p.Highlights, " · "), pdf.Style{Color: &accent, Size: pdf.SizeLabel})
		}
		c.Down(pdf.SpaceTight)
	}
	c.Line(pdf.AtX, left, "Pay via Khalti · eSewa · Fonepay · Bank transfer.", pdf.Style{Color: &label, Size: pdf.SizeLabel})
	c.Down(pdf.SpaceTight)
	drawTaxNote(c, in.issuer)
	drawFooter(c, "This is a computer-generated invoice.", in.number)
	return d.Bytes()
}

type planPayment struct {
	ID        bson.ObjectID `bson:"_id"`
	Amount    int64         `bson:"amount"`
	Currency  *string       `bson:"currency"`
	Reference *string       `bson:"gatewayReference"`
	InvoiceID bson.ObjectID `bson:"invoiceId"`
	LocalNo   *string       `bson:"localTransactionNo"`
	Method    string        `bson:"method"`
	ReceiptNo *string       `bson:"receiptNumber"`
	SettledAt *time.Time    `bson:"settledAt"`
	Provider  *string       `bson:"softmatoProvider"`
	TxNo      *string       `bson:"softmatoTransactionNo"`
	Status    string        `bson:"status"`
}

type receiptPrint struct {
	pay                    *planPayment
	number, invoiceNumber  string
	invoiceTotal, received int64
	fromName, fromEmail    string
	issuer                 Issuer
}

func (in receiptPrint) render() ([]byte, error) {
	d := pdf.New()
	c := pdf.NewCursor(d)
	paidAt := time.Now()
	if in.pay.SettledAt != nil {
		paidAt = *in.pay.SettledAt
	}
	d.SetMeta("Receipt "+in.number, in.issuer.LegalName, in.issuer.creator())
	balance := max(0, in.invoiceTotal-in.received)
	currency := "NPR"
	if in.pay.Currency != nil {
		currency = *in.pay.Currency
	}
	accent, label, text := pdf.ColorAccent, pdf.ColorLabel, pdf.ColorText
	regular := pdf.Regular
	left := pdf.MarginLeft
	drawIssuer(c, in.issuer, true)
	c.Down(pdf.SpaceTight)
	c.RuleStrong()
	c.Down(pdf.SpaceTight)
	c.Title(pdf.Center, 0, "Payment Receipt")
	c.Down(pdf.SpaceTight)
	c.Field("Receipt No.", in.number, pdf.FieldOptions{ValueColor: &accent})
	c.Field("Receipt Date", bs.DocumentBsDate(paidAt), pdf.FieldOptions{Suffix: "(" + bs.DocumentAdDate(paidAt) + ")"})
	c.Field("Against Invoice", in.invoiceNumber, pdf.FieldOptions{Suffix: "(FY " + bs.FiscalYear(paidAt) + ")"})
	c.Down(pdf.SpaceTight)
	c.Rule(pdf.RuleOptions{})
	c.Eyebrow(pdf.AtX, left, "Received from")
	c.Line(pdf.AtX, left, in.fromName, pdf.Style{Font: pdf.Bold, Size: pdf.SizePartyName})
	if in.fromEmail != "" {
		c.Line(pdf.AtX, left, in.fromEmail, pdf.Style{Color: &accent, Size: pdf.SizeLabel})
	}
	c.Down(pdf.SpaceTight)
	c.Rule(pdf.RuleOptions{})
	c.Down(pdf.SpaceTight)
	c.Eyebrow(pdf.Center, 0, "Amount received")
	c.Down(pdf.SpaceBlock)
	c.Line(pdf.Center, 0, currency+" "+docAmount(in.pay.Amount), pdf.Style{Font: pdf.MonoBold, Size: pdf.SizeAmount})
	c.Down(4)
	c.Line(pdf.Center, 0, money.AmountInWords(in.pay.Amount), pdf.Style{Color: &accent, Size: pdf.SizeLabel})
	c.Down(pdf.SpaceBlock)
	c.Rule(pdf.RuleOptions{})
	method := "Online payment"
	if in.pay.Method == "CASH" {
		method = "Cash"
	} else if in.pay.Provider != nil && *in.pay.Provider != "" {
		method = *in.pay.Provider
	}
	c.Field("Payment method", method, pdf.FieldOptions{ValueColor: &accent, ValueFont: &regular})
	tx := ""
	if in.pay.TxNo != nil {
		tx = *in.pay.TxNo
	} else if in.pay.Reference != nil {
		tx = *in.pay.Reference
	}
	if tx != "" {
		c.Field("Transaction ID", tx, pdf.FieldOptions{ValueColor: &accent})
	}
	c.Field("Paid at", bs.DocumentInstant(paidAt), pdf.FieldOptions{})
	if in.issuer.ProductName != "" {
		c.Field("For", in.issuer.ProductName, pdf.FieldOptions{ValueFont: &regular})
	}
	c.Down(pdf.SpaceTight)
	c.Rule(pdf.RuleOptions{})
	ledgerTop := c.Top()
	for _, row := range []struct {
		name  string
		value int64
	}{{"Invoice total", in.invoiceTotal}, {"Total received", in.received}, {"Balance due", balance}} {
		c.Text(pdf.AtX, left, row.name, pdf.Style{Color: &label, Size: pdf.SizeLabel})
		c.Text(pdf.AtX, left+170, docAmount(row.value), pdf.Style{Font: pdf.Mono, Size: pdf.SizeBody})
		c.Down(pdf.SpaceLine + 2)
	}
	c.To(ledgerTop - (pdf.SpaceLine + 2))
	stamp, color := "Partly paid", text
	if balance == 0 {
		stamp, color = "Paid in full", accent
	}
	c.Stamp(stamp, pdf.StampOptions{Color: &color, Top: ledgerTop + pdf.SizeBody, Width: 145})
	c.To(ledgerTop - (pdf.SpaceLine+2)*3)
	c.Down(pdf.SpaceTight)
	c.Rule(pdf.RuleOptions{})
	drawTaxNote(c, in.issuer)
	reference := in.number
	if in.pay.ReceiptNo != nil {
		reference = *in.pay.ReceiptNo
	}
	drawFooter(c, "Computer-generated receipt. No signature required.", reference)
	return d.Bytes()
}

func fileNameFor(number string) string { return strings.ReplaceAll(number, "/", "-") + ".pdf" }

type resolvedDoc struct {
	data              []byte
	contentType, name string
}

var pdfMagic = []byte("%PDF-")

// softmatoDoc is softmatoDocument: a stored copy, else a download kept for next time. A
// non-PDF answer is redrawn by us, never handed to an owner. Nil when Softmato has none.
func (s *Service) softmatoDoc(ctx context.Context, kind, number, version string, redraw func() ([]byte, error)) (*resolvedDoc, error) {
	key := bson.D{{Key: "kind", Value: kind}, {Key: "number", Value: number}, {Key: "version", Value: version}}
	coll := s.DB.Collection("softmatodocuments")
	var cached struct {
		Bytes       []byte `bson:"bytes"`
		ContentType string `bson:"contentType"`
	}
	err := coll.FindOne(ctx, key).Decode(&cached)
	switch {
	case err == nil && bytes.HasPrefix(cached.Bytes, pdfMagic):
		return &resolvedDoc{cached.Bytes, cached.ContentType, fileNameFor(number)}, nil
	case err == nil:
		_, _ = coll.DeleteOne(ctx, key)
	case !errors.Is(err, mongo.ErrNoDocuments):
		return nil, err
	}
	if s.Softmato == nil {
		return nil, payErr(503, "SOFTMATO_UNAVAILABLE", softmatoDownMsg)
	}
	file, err := s.Softmato.Download(ctx, kind+"s", number)
	if err != nil {
		if softmato.IsDown(err) {
			return nil, payErr(503, "SOFTMATO_UNAVAILABLE", softmatoDownMsg)
		}
		return nil, err
	}
	if file == nil {
		return nil, nil
	}
	if file.ContentType != "application/pdf" || !bytes.HasPrefix(file.Bytes, pdfMagic) {
		slog.ErrorContext(ctx, "softmato_document_not_pdf", "kind", kind, "number", number, "reason", file.Fallback)
		data, err := redraw()
		if err != nil {
			return nil, err
		}
		return &resolvedDoc{data, "application/pdf", fileNameFor(number)}, nil
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := coll.UpdateOne(ctx, key, bson.D{{Key: "$setOnInsert", Value: bson.D{{Key: "bytes", Value: file.Bytes}, {Key: "contentType", Value: file.ContentType}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}}}, options.UpdateOne().SetUpsert(true)); err != nil {
		slog.WarnContext(ctx, "softmato_document_not_cached", "number", number, "error", err.Error())
	}
	return &resolvedDoc{file.Bytes, file.ContentType, fileNameFor(number)}, nil
}

func scopeIDs(hostelIDs []string) bson.A {
	ids := bson.A{}
	for _, h := range hostelIDs {
		if oid, err := bson.ObjectIDFromHex(h); err == nil {
			ids = append(ids, oid)
		}
	}
	return ids
}

func (s *Service) resolveInvoice(ctx context.Context, number string, hostelIDs []string) (*resolvedDoc, error) {
	var inv planInvoice
	err := s.DB.Collection("subscriptioninvoices").FindOne(ctx, bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: scopeIDs(hostelIDs)}}}, {Key: "invoiceNumber", Value: number}}).Decode(&inv)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	draw := func(documentNumber string) ([]byte, error) {
		paid, err := s.settledTotal(ctx, bson.D{{Key: "invoiceId", Value: inv.ID}})
		if err != nil {
			return nil, err
		}
		issuer, err := s.loadIssuer(ctx)
		if err != nil {
			return nil, err
		}
		catalog, err := s.catalog(ctx)
		if err != nil {
			return nil, err
		}
		label := inv.Cycle
		switch plans.Cycle(inv.Cycle) {
		case plans.Monthly:
			label = catalog.CycleLabels.Monthly
		case plans.HalfYearly:
			label = catalog.CycleLabels.HalfYearly
		case plans.Annual:
			label = catalog.CycleLabels.Annual
		}
		return invoicePrint{inv: &inv, amountPaid: paid, number: documentNumber, issuer: issuer, lineLabel: inv.PlanName + " — " + label,
			presentation: buildPresentation("", label, inv.CycleMonths, plans.GetPlan(catalog, inv.PlanID), inv.PlanName)}.render()
	}
	if inv.SoftmatoNo != nil {
		theirs, err := s.softmatoDoc(ctx, "invoice", *inv.SoftmatoNo, inv.Status, func() ([]byte, error) { return draw(*inv.SoftmatoNo) })
		if err != nil {
			return nil, err
		}
		if theirs != nil || inv.LocalNo == nil {
			return theirs, nil
		}
	}
	if inv.LocalNo == nil {
		return nil, nil
	}
	data, err := draw(*inv.LocalNo)
	if err != nil {
		return nil, err
	}
	return &resolvedDoc{data, "application/pdf", fileNameFor(*inv.LocalNo)}, nil
}

// localReceiptNumber is ensureLocalReceiptNumber: HH-TXN-<fiscal year>-<sequence>; a race
// keeps the first number and burns the other.
func (s *Service) localReceiptNumber(ctx context.Context, pay *planPayment) (string, error) {
	if pay.LocalNo != nil {
		return *pay.LocalNo, nil
	}
	settled := time.Now()
	if pay.SettledAt != nil {
		settled = *pay.SettledAt
	}
	year := bs.FiscalYear(settled)
	if year == "" {
		return "", fmt.Errorf("cannot number a document dated %s: outside the Bikram Sambat table", settled)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	var run struct {
		Sequence int `bson:"sequence"`
	}
	if err := s.DB.Collection("platformdocumentsequences").FindOneAndUpdate(ctx, bson.D{{Key: "fiscalYear", Value: year}, {Key: "kind", Value: "SUBSCRIPTION_RECEIPT"}},
		bson.D{{Key: "$inc", Value: bson.D{{Key: "sequence", Value: 1}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: now}}}, {Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&run); err != nil {
		return "", err
	}
	number := fmt.Sprintf("HH-TXN-%s-%08d", year, run.Sequence)
	if _, err := s.DB.Collection("subscriptionpayments").UpdateOne(ctx, bson.D{{Key: "_id", Value: pay.ID}, {Key: "localTransactionNo", Value: nil}}, bson.D{{Key: "$set", Value: bson.D{{Key: "localTransactionNo", Value: number}}}}); err != nil {
		return "", err
	}
	var fresh planPayment
	if err := s.DB.Collection("subscriptionpayments").FindOne(ctx, bson.D{{Key: "_id", Value: pay.ID}}).Decode(&fresh); err != nil {
		return "", err
	}
	if fresh.LocalNo != nil {
		return *fresh.LocalNo, nil
	}
	return number, nil
}

func (s *Service) resolveReceipt(ctx context.Context, number string, hostelIDs []string) (*resolvedDoc, error) {
	var pay planPayment
	err := s.DB.Collection("subscriptionpayments").FindOne(ctx, bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: scopeIDs(hostelIDs)}}},
		{Key: "$or", Value: bson.A{bson.D{{Key: "softmatoTransactionNo", Value: number}}, bson.D{{Key: "localTransactionNo", Value: number}}, bson.D{{Key: "receiptNumber", Value: number}}}}}).Decode(&pay)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if pay.Status != "SETTLED" {
		return nil, nil
	}
	draw := func(documentNumber string) ([]byte, error) {
		issuer, err := s.loadIssuer(ctx)
		if err != nil {
			return nil, err
		}
		print := receiptPrint{pay: &pay, number: documentNumber, invoiceNumber: "—", invoiceTotal: pay.Amount, received: pay.Amount, issuer: issuer}
		var inv planInvoice
		err = s.DB.Collection("subscriptioninvoices").FindOne(ctx, bson.D{{Key: "_id", Value: pay.InvoiceID}}).Decode(&inv)
		if err == nil {
			print.invoiceNumber = inv.InvoiceNumber
			if inv.SoftmatoNo != nil {
				print.invoiceNumber = *inv.SoftmatoNo
			} else if inv.LocalNo != nil {
				print.invoiceNumber = *inv.LocalNo
			}
			print.invoiceTotal = inv.Amount
			print.fromEmail, print.fromName = inv.BilledTo.Email, inv.BilledTo.Name
			if print.fromName == "" {
				print.fromName = inv.BilledTo.HostelName
			}
			if print.received, err = s.settledTotal(ctx, bson.D{{Key: "invoiceId", Value: pay.InvoiceID}}); err != nil {
				return nil, err
			}
		} else if !errors.Is(err, mongo.ErrNoDocuments) {
			return nil, err
		}
		return print.render()
	}
	if pay.TxNo != nil {
		return s.softmatoDoc(ctx, "receipt", *pay.TxNo, "1", func() ([]byte, error) { return draw(*pay.TxNo) })
	}
	if pay.Method == "SOFTMATO" {
		return nil, nil
	}
	documentNumber, err := s.localReceiptNumber(ctx, &pay)
	if err != nil {
		return nil, err
	}
	data, err := draw(documentNumber)
	if err != nil {
		return nil, err
	}
	return &resolvedDoc{data, "application/pdf", fileNameFor(documentNumber)}, nil
}

// document streams a plan invoice or receipt to the hostel it belongs to. Every hostel
// shares one Softmato credential, so the scope here is the only tenancy check there is.
func (a *Admin) document(c *gin.Context) {
	notFound := func() { c.Data(404, "text/plain;charset=UTF-8", []byte("Not found")) }
	p := authz.From(c)
	kind := c.Param("kind")
	if (kind != "invoice" && kind != "receipt") || len(p.HostelIDs) == 0 {
		notFound()
		return
	}
	number, err := url.PathUnescape(c.Param("number"))
	if err != nil {
		number = c.Param("number")
	}
	var doc *resolvedDoc
	if kind == "invoice" {
		doc, err = a.Service.resolveInvoice(c, number, p.HostelIDs)
	} else {
		doc, err = a.Service.resolveReceipt(c, number, p.HostelIDs)
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if doc == nil {
		notFound()
		return
	}
	c.Header("Content-Disposition", `attachment; filename="`+doc.name+`"`)
	c.Header("Cache-Control", "private, no-store")
	c.Header("Content-Length", strconv.Itoa(len(doc.data)))
	c.Data(200, doc.contentType, doc.data)
}
