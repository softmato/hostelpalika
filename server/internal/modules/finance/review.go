package finance

import (
	"context"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// --- reference codes (reference-code.ts) ------------------------------------------

const (
	refSymbols    = "0123456789ABCDEFGHJKMNPQRSTVWXY"
	refModulus    = len(refSymbols)
	refCodeLength = 8
)

var (
	refNotCode     = regexp.MustCompile(`[^A-Z0-9]`)
	refRunSplit    = regexp.MustCompile(`[^A-Z0-9\s-]+`)
	refSpaces      = regexp.MustCompile(`\s+`)
	refConfusables = strings.NewReplacer("I", "1", "L", "1", "O", "0")
)

func refCanonical(raw string) string { return refNotCode.ReplaceAllString(strings.ToUpper(raw), "") }

func refCheck(prefix, encoded string) (byte, bool) {
	total, weight := 0, 1
	for i := 0; i < len(prefix); i++ {
		total += int(prefix[i]-'A') * weight
		weight++
	}
	for i := 0; i < len(encoded); i++ {
		v := strings.IndexByte(refSymbols, encoded[i])
		if v < 0 {
			return 0, false
		}
		total += v * weight
		weight++
	}
	return refSymbols[total%refModulus], true
}

// parseReference returns the code's printed form, "" when it does not validate.
func parseReference(raw string) string {
	c := refCanonical(raw)
	if len(c) != refCodeLength {
		return ""
	}
	prefix := c[:3]
	for i := 0; i < 3; i++ {
		if prefix[i] < 'A' || prefix[i] > 'Z' {
			return ""
		}
	}
	encoded := refConfusables.Replace(c[3:7])
	check := refConfusables.Replace(c[7:])
	want, ok := refCheck(prefix, encoded)
	if !ok || string(want) != check {
		return ""
	}
	return prefix + "-" + encoded + "-" + string(want)
}

// ExtractReferenceCodes is extractReferenceCodes: a code is a token in its own right.
func ExtractReferenceCodes(text string) []string {
	found := []string{}
	for _, run := range refRunSplit.Split(strings.ToUpper(text), -1) {
		tokens := []string{}
		for _, t := range refSpaces.Split(run, -1) {
			if t != "" {
				tokens = append(tokens, t)
			}
		}
		for i := range tokens {
			single := refCanonical(tokens[i])
			candidates := []string{}
			if len(single) == refCodeLength {
				candidates = append(candidates, single)
			}
			joined := single
			for span := 1; span < 3 && i+span < len(tokens); span++ {
				joined += refCanonical(tokens[i+span])
				if len(joined) == refCodeLength {
					candidates = append(candidates, joined)
				}
				if len(joined) > refCodeLength {
					break
				}
			}
			for _, c := range candidates {
				if p := parseReference(c); p != "" && !slices.Contains(found, p) {
					found = append(found, p)
				}
			}
		}
	}
	return found
}

// --- the review queue (review.service.ts) ------------------------------------------

// ClaimCheck is one line of a claim's checklist.
type ClaimCheck struct {
	Detail string `json:"detail"`
	Key    string `json:"key"`
	OK     bool   `json:"ok"`
}

// ReviewRow is ReviewQueueRow.
type ReviewRow struct {
	AllGreen         bool         `json:"allGreen"`
	Amount           int64        `json:"amount"`
	Checks           []ClaimCheck `json:"checks"`
	Confirmation     string       `json:"confirmation"`
	EventID          string       `json:"eventId"`
	EvidenceAssetID  any          `json:"evidenceAssetId"`
	EvidenceMimeType any          `json:"evidenceMimeType"`
	InvoiceID        any          `json:"invoiceId"`
	Method           string       `json:"method"`
	OccurredAt       string       `json:"occurredAt"`
	Period           any          `json:"period"`
	ReferenceNote    any          `json:"referenceNote"`
	RejectionReason  any          `json:"rejectionReason"`
	ResidentID       string       `json:"residentId"`
	ResidentName     string       `json:"residentName"`
	ReviewFlags      []string     `json:"reviewFlags"`
	Status           string       `json:"status"`
	TransactionCode  any          `json:"transactionCode"`
}

type claimEvent struct {
	ID         bson.ObjectID  `bson:"_id"`
	Amount     int64          `bson:"amount"`
	Confirm    string         `bson:"confirmation"`
	Evidence   *bson.ObjectID `bson:"evidenceAssetId"`
	InvoiceID  *bson.ObjectID `bson:"invoiceId"`
	OccurredAt time.Time      `bson:"occurredAt"`
	Provider   string         `bson:"provider"`
	Raw        struct {
		Note *string `bson:"referenceNote"`
		Code *string `bson:"transactionCode"`
	} `bson:"rawPayload"`
	Rejection  *string        `bson:"rejectionReason"`
	ResidentID *bson.ObjectID `bson:"residentId"`
	Flags      []string       `bson:"reviewFlags"`
	Status     string         `bson:"status"`
}

type checkInvoice struct {
	ID        bson.ObjectID `bson:"_id"`
	Period    *string       `bson:"period"`
	Reference *string       `bson:"referenceCode"`
	Status    string        `bson:"status"`
	Total     int64         `bson:"totalAmount"`
}

var methodByProvider = map[string]string{"BANK": "BANK_TRANSFER", "CASH": "CASH", "ESEWA": "ESEWA", "FONEPAY": "FONEPAY", "KHALTI": "KHALTI", "NONE": "OTHER"}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func anyOf(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

func has(flags []string, f string) bool { return slices.Contains(flags, f) }

func referenceCheck(e *claimEvent, inv *checkInvoice) ClaimCheck {
	expected := ""
	if inv != nil {
		expected = deref(inv.Reference)
	}
	if expected == "" {
		return ClaimCheck{"Invoice has no reference code to quote", "REFERENCE", false}
	}
	quoted := append(ExtractReferenceCodes(deref(e.Raw.Code)), ExtractReferenceCodes(deref(e.Raw.Note))...)
	if slices.Contains(quoted, expected) {
		return ClaimCheck{"Resident quoted " + expected, "REFERENCE", true}
	}
	if len(quoted) > 0 {
		return ClaimCheck{"Quoted " + quoted[0] + ", but this invoice is " + expected, "REFERENCE", false}
	}
	return ClaimCheck{"Did not quote " + expected, "REFERENCE", false}
}

func directionCheck(flags []string) ClaimCheck {
	if has(flags, "EVIDENCE_IS_STATEMENT") {
		return ClaimCheck{"This is a full statement, not a receipt for one payment — ask for the receipt", "EVIDENCE", false}
	}
	if has(flags, "EVIDENCE_OUTCOME_PENDING") {
		return ClaimCheck{"The receipt says the transaction is still pending — wait for your statement", "EVIDENCE", false}
	}
	return ClaimCheck{"Could not tell whether this receipt shows money going out — open it", "EVIDENCE", false}
}

func evidenceCheck(e *claimEvent) ClaimCheck {
	if e.Evidence == nil {
		return ClaimCheck{"No screenshot attached", "EVIDENCE", false}
	}
	f := e.Flags
	switch {
	case has(f, "EVIDENCE_IS_STATEMENT"), has(f, "EVIDENCE_DIRECTION_UNVERIFIED"), has(f, "EVIDENCE_OUTCOME_PENDING"):
		return directionCheck(f)
	case has(f, "EVIDENCE_TXN_ID_MALFORMED"):
		return ClaimCheck{"The transaction ID is not the shape this provider issues — open it", "EVIDENCE", false}
	case has(f, "EVIDENCE_TEXT_MATCHES_CLAIM"):
		detail := "The amount and ID on the screenshot match this claim"
		if has(f, "EVIDENCE_REFERENCE_ON_IMAGE") {
			detail = "The screenshot carries this invoice's reference code and the amount"
		} else if has(f, "EVIDENCE_TXN_ID_SHAPE_OK") {
			detail = "The amount and ID match, and the ID is the shape this provider issues"
		}
		return ClaimCheck{detail, "EVIDENCE", true}
	case has(f, "EVIDENCE_NOT_A_PAYMENT_RECORD"):
		return ClaimCheck{"This does not look like a payment receipt at all — open it", "EVIDENCE", false}
	case has(f, "EVIDENCE_NO_TEXT_FOUND"):
		return ClaimCheck{"Nothing on this image matches the claim — open it", "EVIDENCE", false}
	}
	missing := []string{}
	if has(f, "EVIDENCE_AMOUNT_NOT_ON_IMAGE") {
		missing = append(missing, "amount")
	}
	if has(f, "EVIDENCE_ID_NOT_ON_IMAGE") {
		missing = append(missing, "transaction ID")
	}
	if len(missing) > 0 {
		return ClaimCheck{"Could not find the " + strings.Join(missing, " or the ") + " on the screenshot — open it", "EVIDENCE", false}
	}
	if has(f, "EVIDENCE_NOT_MACHINE_CHECKED") {
		return ClaimCheck{"Attached, but nothing could read it — open it before approving", "EVIDENCE", false}
	}
	return ClaimCheck{"Screenshot attached and readable", "EVIDENCE", true}
}

func payeeCheck(f []string) ClaimCheck {
	switch {
	case has(f, "EVIDENCE_METHOD_MISMATCH"):
		if has(f, "EVIDENCE_PAYEE_VERIFIED") {
			return ClaimCheck{"Right account, but the receipt is from a different app than the resident chose", "PAYEE", false}
		}
		return ClaimCheck{"The receipt is from a different app than the resident chose — open it", "PAYEE", false}
	case has(f, "EVIDENCE_PAYEE_VERIFIED"):
		return ClaimCheck{"Paid into an account registered to this hostel", "PAYEE", true}
	case has(f, "EVIDENCE_PAYEE_UNVERIFIED"):
		return ClaimCheck{"Could not confirm the receiving account is yours — open it", "PAYEE", false}
	}
	return ClaimCheck{"Receiving account not checked — open it", "PAYEE", false}
}

func fileCheck(f []string) ClaimCheck {
	seen := []string{}
	for _, o := range [][2]string{{"EVIDENCE_EDITOR_SIGNATURE", "saved by an image editor"}, {"EVIDENCE_FILE_RE_ENCODED", "re-encoded outside a phone"}, {"EVIDENCE_NOT_A_SCREENSHOT", "a photo, not a screenshot"}, {"EVIDENCE_DIMENSIONS_UNUSUAL", "cropped or resized"}} {
		if has(f, o[0]) {
			seen = append(seen, o[1])
		}
	}
	switch len(seen) {
	case 0:
		return ClaimCheck{"Nothing unusual about the file itself", "FILE", true}
	case 1:
		return ClaimCheck{"File is " + seen[0], "FILE", true}
	}
	return ClaimCheck{"File is " + strings.Join(seen, ", ") + " — ask for the original", "FILE", false}
}

func claimChecks(e *claimEvent, inv *checkInvoice, settled int64) []ClaimCheck {
	amount := ClaimCheck{"Not attached to an invoice", "AMOUNT", false}
	open := ClaimCheck{"Invoice missing", "INVOICE_OPEN", false}
	if inv != nil {
		outstanding := max(0, inv.Total-settled)
		amount.OK = e.Amount == outstanding
		amount.Detail = "Claimed " + strconv.FormatInt(e.Amount, 10) + " against " + strconv.FormatInt(outstanding, 10) + " outstanding"
		if amount.OK {
			amount.Detail = "Matches the amount outstanding"
		}
		open.Detail = "Invoice is " + inv.Status
		open.OK = inv.Status == "OPEN" || inv.Status == "PARTIAL" || inv.Status == "OVERDUE"
	}
	similar := ClaimCheck{"No similar screenshot seen", "SIMILARITY", true}
	if has(e.Flags, "SIMILAR_EVIDENCE") {
		similar = ClaimCheck{"Looks like an earlier screenshot — compare them", "SIMILARITY", false}
	}
	return []ClaimCheck{evidenceCheck(e), fileCheck(e.Flags), payeeCheck(e.Flags), amount, open, referenceCheck(e, inv), similar}
}

// ListReviewQueue is listReviewQueue: the newest 200 claims in one state.
func ListReviewQueue(ctx context.Context, db *mongo.Database, hostel bson.ObjectID, status string) ([]ReviewRow, error) {
	return listQueue(ctx, db, hostel, status, "RESIDENT_CLAIM")
}

// ListStaffQueue is the staff screen's queue. Pending cash above the hostel's threshold
// is in it too: nothing else showed that cash to the second approver (FIN-2).
func ListStaffQueue(ctx context.Context, db *mongo.Database, hostel bson.ObjectID, status string) ([]ReviewRow, error) {
	if status != "PENDING" {
		return ListReviewQueue(ctx, db, hostel, status)
	}
	return listQueue(ctx, db, hostel, status, bson.D{{Key: "$in", Value: bson.A{"RESIDENT_CLAIM", "CASH_ENTRY"}}})
}

func listQueue(ctx context.Context, db *mongo.Database, hostel bson.ObjectID, status string, source any) ([]ReviewRow, error) {
	cur, err := db.Collection("paymentevents").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "source", Value: source}, {Key: "status", Value: status}},
		options.Find().SetSort(bson.D{{Key: "occurredAt", Value: -1}}).SetLimit(200))
	if err != nil {
		return nil, err
	}
	var events []claimEvent
	if err := cur.All(ctx, &events); err != nil {
		return nil, err
	}
	if len(events) == 0 {
		return nil, nil
	}
	residents, invoices, assets := bson.A{}, bson.A{}, bson.A{}
	for i := range events {
		if events[i].ResidentID != nil {
			residents = append(residents, *events[i].ResidentID)
		}
		if events[i].InvoiceID != nil {
			invoices = append(invoices, *events[i].InvoiceID)
		}
		if events[i].Evidence != nil {
			assets = append(assets, *events[i].Evidence)
		}
	}
	in := func(ids bson.A) bson.D { return bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}} }
	names := map[bson.ObjectID]string{}
	cur, err = db.Collection("residents").Find(ctx, in(residents))
	if err != nil {
		return nil, err
	}
	var people []struct {
		ID    bson.ObjectID `bson:"_id"`
		First string        `bson:"firstName"`
		Last  string        `bson:"lastName"`
	}
	if err := cur.All(ctx, &people); err != nil {
		return nil, err
	}
	for _, p := range people {
		names[p.ID] = strings.TrimSpace(p.First + " " + p.Last)
	}
	cur, err = db.Collection("invoices").Find(ctx, in(invoices))
	if err != nil {
		return nil, err
	}
	var rows []checkInvoice
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	byInvoice := map[bson.ObjectID]*checkInvoice{}
	for i := range rows {
		byInvoice[rows[i].ID] = &rows[i]
	}
	cur, err = db.Collection("fileassets").Find(ctx, in(assets))
	if err != nil {
		return nil, err
	}
	var files []struct {
		ID   bson.ObjectID `bson:"_id"`
		Mime *string       `bson:"mimeType"`
	}
	if err := cur.All(ctx, &files); err != nil {
		return nil, err
	}
	mimes := map[bson.ObjectID]*string{}
	for i := range files {
		mimes[files[i].ID] = files[i].Mime
	}
	cur, err = db.Collection("invoicebalances").Find(ctx, bson.D{{Key: "invoiceId", Value: bson.D{{Key: "$in", Value: invoices}}}})
	if err != nil {
		return nil, err
	}
	var balances []struct {
		Invoice bson.ObjectID `bson:"invoiceId"`
		Settled int64         `bson:"settledAmount"`
	}
	if err := cur.All(ctx, &balances); err != nil {
		return nil, err
	}
	settled := map[bson.ObjectID]int64{}
	for _, b := range balances {
		settled[b.Invoice] = b.Settled
	}
	out := make([]ReviewRow, len(events))
	for i := range events {
		e := &events[i]
		var inv *checkInvoice
		var paid int64
		var invoiceID, period, evidence, mime any
		if e.InvoiceID != nil {
			inv = byInvoice[*e.InvoiceID]
			paid = settled[*e.InvoiceID]
			invoiceID = e.InvoiceID.Hex()
			if inv != nil {
				period = anyOf(inv.Period)
			}
		}
		if e.Evidence != nil {
			evidence = e.Evidence.Hex()
			mime = anyOf(mimes[*e.Evidence])
		}
		checks := claimChecks(e, inv, paid)
		green := true
		for _, c := range checks {
			green = green && c.OK
		}
		provider := e.Provider
		if provider == "" {
			provider = "NONE"
		}
		method, ok := methodByProvider[provider]
		if !ok {
			method = "OTHER"
		}
		who, name := "", ""
		if e.ResidentID != nil {
			who = e.ResidentID.Hex()
			var known bool
			if name, known = names[*e.ResidentID]; !known {
				name = "Removed resident"
			}
		}
		flags := e.Flags
		if flags == nil {
			flags = []string{}
		}
		out[i] = ReviewRow{green, e.Amount, checks, e.Confirm, e.ID.Hex(), evidence, mime, invoiceID, method, httpx.ISO(e.OccurredAt), period, anyOf(e.Raw.Note), anyOf(e.Rejection), who, name, flags, e.Status, anyOf(e.Raw.Code)}
	}
	return out, nil
}

// ListResidentClaims is listResidentClaims: pending, then settled, then rejected.
func ListResidentClaims(ctx context.Context, db *mongo.Database, hostel, resident bson.ObjectID) ([]ReviewRow, error) {
	out := []ReviewRow{}
	for _, status := range []string{"PENDING", "SETTLED", "REJECTED"} {
		rows, err := ListReviewQueue(ctx, db, hostel, status)
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			if r.ResidentID == resident.Hex() {
				out = append(out, r)
			}
		}
	}
	return out, nil
}

// CreditAmount is getCreditAmount.
func CreditAmount(ctx context.Context, db *mongo.Database, hostel, resident bson.ObjectID) (int64, error) {
	var row struct {
		Amount int64 `bson:"amount"`
	}
	err := db.Collection("creditbalances").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "residentId", Value: resident}}).Decode(&row)
	if err != nil && err != mongo.ErrNoDocuments {
		return 0, err
	}
	return row.Amount, nil
}

// errorStatus is FINANCE_ERROR_STATUS, for the codes Go throws so far.
var errorStatus = map[string]int{
	"FEE_SCHEDULE_MISSING":          422,
	"BED_TYPE_NOT_PRICED":           422,
	"FEE_SCHEDULE_MONTH_LOCKED":     409,
	"FEE_SCHEDULE_IN_USE":           409,
	"KHATA_NOT_ACTIVE":              409,
	"KHATA_ITEM_NOT_FOUND":          404,
	"KHATA_ENTRY_NOT_FOUND":         404,
	"KHATA_ENTRY_DECIDED":           409,
	"RENT_CONCESSION_NOT_FOUND":     404,
	"INVOICE_ALREADY_BILLED":        409,
	"INVOICE_NOT_FOUND":             404,
	"INVOICE_ALREADY_PAID":          409,
	"CLAIM_NOT_FOUND":               404,
	"CLAIM_ALREADY_REVIEWED":        409,
	"INVOICE_HAS_SETTLED_PAYMENTS":  409,
	"REFERENCE_CODE_INVALID":        422,
	"REFERENCE_PREFIX_MISSING":      422,
	"EVIDENCE_IS_SYSTEM_DOCUMENT":   422,
	"EVIDENCE_NOT_READABLE":         422,
	"EVIDENCE_NOT_A_PAYMENT":        422,
	"EVIDENCE_WRONG_TRANSACTION":    422,
	"EVIDENCE_ALREADY_USED":         409,
	"TXN_ID_ALREADY_USED":           409,
	"TXN_ID_ALREADY_CLAIMED":        409,
	"TXN_ID_REQUIRED":               422,
	"TXN_ID_NOT_PLAUSIBLE":          422,
	"ASSET_NOT_OWNED":               403,
	"ASSET_UPLOAD_INCOMPLETE":       422,
	"AMOUNT_OUT_OF_BOUNDS":          422,
	"REVERSAL_REASON_REQUIRED":      422,
	"SETTLED_EVENT_IMMUTABLE":       500,
	"RECEIPT_ALREADY_VOID":          409,
	"RECEIPT_NOT_FOUND":             404,
	"SECOND_APPROVER_REQUIRED":      409,
	"HOSTEL_SCOPE_REQUIRED":         422,
	"STATEMENT_UNREADABLE":          422,
	"STATEMENT_NOT_FOUND":           404,
	"STATEMENT_NOT_READY":           409,
	"EVENT_NOT_FOUND":               404,
	"EVENT_ALREADY_ASSIGNED":        409,
	"GATEWAY_NOT_CONFIGURED":        422,
	"GATEWAY_NOT_ELIGIBLE":          422,
	"GATEWAY_SANDBOX_IN_PRODUCTION": 409,
	"GATEWAY_VERIFICATION_FAILED":   422,
	"GATEWAY_UNREACHABLE":           502,
	"INTENT_NOT_FOUND":              404,
	"RESIDENT_NOT_FOUND":            404,
	"INTENT_NOT_PAYABLE":            409,
	"LEAVE_OFF":                     409,
	"LEAVE_DATES":                   422,
	"LEAVE_CROSSES_MONTH":           422,
	"LEAVE_TOO_SHORT":               422,
	"LEAVE_OVERLAP":                 409,
	"LEAVE_MONTH_NOT_BILLED":        409,
	"LEAVE_NOT_FOUND":               404,
	"EVENT_NOT_PENDING":             409,
	"EVENT_NOT_SETTLED":             409,
}

// Err is new FinanceServiceError(message, code, details?).
func Err(code, message string, details ...any) error {
	var d any
	if len(details) > 0 {
		d = details[0]
	}
	return httpx.NewError(errorStatus[code], code, message, d)
}
