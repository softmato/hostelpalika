package offerprogram

import (
	"errors"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"golang.org/x/sync/errgroup"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

var (
	certCode   = regexp.MustCompile(`^HP([0-9A-HJKMNP-TV-Z]{12})$`)
	codeNoise  = regexp.MustCompile(`[\s-]`)
	bsSuffixRe = regexp.MustCompile(`\s*BS$`)
)

// NormalizeCertificationCode is normalizeCertificationCode: any spacing or case
// of "HP-7K2M-9QXD-4TRA" back to that form; "" when it cannot be one.
func NormalizeCertificationCode(input string) string {
	m := certCode.FindStringSubmatch(codeNoise.ReplaceAllString(strings.ToUpper(input), ""))
	if m == nil {
		return ""
	}
	return "HP-" + m[1][:4] + "-" + m[1][4:8] + "-" + m[1][8:]
}

// MaskedName is maskedName: first name and last initial — enough to match a printout.
func MaskedName(fullName string) string {
	parts := strings.Fields(fullName)
	if len(parts) == 0 {
		return ""
	}
	if len(parts) == 1 {
		return parts[0]
	}
	return parts[0] + " " + string([]rune(parts[len(parts)-1])[0]) + "."
}

// verify is verifyReceiptByCode, behind `/verify-receipt` (PARITY §9): what the
// platform recorded for a certified receipt's code. No session — whoever holds
// the paper may check it — so the resident's name is masked.
func (h *Handler) verify(c *gin.Context) {
	notFound := ordered.Map{{Key: "verification", Value: ordered.Map{{Key: "found", Value: false}}}}
	code := NormalizeCertificationCode(c.Query("code"))
	if code == "" {
		httpx.OK(c, notFound, "Receipt checked")
		return
	}
	var receipt struct {
		Amount        bson.RawValue  `bson:"amount"`
		Code          string         `bson:"certificationCode"`
		HostelID      bson.ObjectID  `bson:"hostelId"`
		InvoiceID     *bson.ObjectID `bson:"invoiceId"`
		IssuedAt      bson.RawValue  `bson:"issuedAt"`
		ReceiptNumber string         `bson:"receiptNumber"`
		ResidentID    bson.ObjectID  `bson:"residentId"`
		VoidedAt      bson.RawValue  `bson:"voidedAt"`
	}
	err := h.db.Collection("receipts").FindOne(c, bson.D{{Key: "certificationCode", Value: code}}).Decode(&receipt)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.OK(c, notFound, "Receipt checked")
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var hostel struct {
		Name string `bson:"name"`
	}
	var resident struct {
		FirstName, FullName, LastName string
	}
	var invoice struct {
		Period string `bson:"period"`
	}
	g, ctx := errgroup.WithContext(c)
	ignoreMissing := func(err error) error {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil
		}
		return err
	}
	g.Go(func() error {
		return ignoreMissing(h.db.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: receipt.HostelID}}).Decode(&hostel))
	})
	g.Go(func() error {
		var raw bson.Raw
		if err := h.db.Collection("residents").FindOne(ctx, bson.D{{Key: "_id", Value: receipt.ResidentID}}).Decode(&raw); err != nil {
			return ignoreMissing(err)
		}
		str := func(k string) string { s, _ := raw.Lookup(k).StringValueOK(); return s }
		resident.FirstName, resident.FullName, resident.LastName = str("firstName"), str("fullName"), str("lastName")
		return nil
	})
	if receipt.InvoiceID != nil {
		g.Go(func() error {
			return ignoreMissing(h.db.Collection("invoices").FindOne(ctx, bson.D{{Key: "_id", Value: *receipt.InvoiceID}}).Decode(&invoice))
		})
	}
	if err := g.Wait(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelName := hostel.Name
	if hostelName == "" {
		hostelName = "Hostel"
	}
	name := resident.FullName
	if name == "" {
		name = strings.TrimSpace(strings.Join(nonEmpty(resident.FirstName, resident.LastName), " "))
	}
	if name == "" {
		name = "Resident"
	}
	var period any
	if invoice.Period != "" {
		label := bs.FormatPeriod(invoice.Period)
		if label == "" {
			label = invoice.Period
		}
		period = bsSuffixRe.ReplaceAllString(label, "")
	}
	httpx.OK(c, ordered.Map{{Key: "verification", Value: ordered.Map{
		{Key: "amount", Value: ordered.FromBSON(receipt.Amount)},
		{Key: "certificationCode", Value: receipt.Code},
		{Key: "found", Value: true},
		{Key: "hostelName", Value: hostelName},
		{Key: "issuedAt", Value: ordered.FromBSON(receipt.IssuedAt)},
		{Key: "period", Value: period},
		{Key: "receiptNumber", Value: receipt.ReceiptNumber},
		{Key: "residentName", Value: MaskedName(name)},
		{Key: "voidedAt", Value: ordered.FromBSON(receipt.VoidedAt)},
	}}}, "Receipt checked")
}
