package finance

import (
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// jsre compiles a JavaScript regex source. JS `\s` also matches the Unicode spaces
// OCR text carries (NBSP above all); RE2's is ASCII only, so the class is spelled out.
func jsre(flags, source string) *regexp.Regexp {
	const spaces = `\t\n\v\f\r \x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}`
	var b strings.Builder
	inClass := false
	for i := 0; i < len(source); i++ {
		ch := source[i]
		switch {
		case ch == '\\' && i+1 < len(source):
			if source[i+1] == 's' {
				if inClass {
					b.WriteString(spaces)
				} else {
					b.WriteString("[" + spaces + "]")
				}
			} else {
				b.WriteString(source[i : i+2])
			}
			i++
			continue
		case ch == '[' && !inClass:
			inClass = true
		case ch == ']' && inClass:
			inClass = false
		}
		b.WriteByte(ch)
	}
	return regexp.MustCompile(flags + b.String())
}

func ci(source string) *regexp.Regexp { return jsre("(?i)", source) }

func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		switch r {
		case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
			return true
		}
		return r >= 0x2000 && r <= 0x200A
	})
}

// --- evidence-ocr.ts ---------------------------------------------------------------

const (
	flagNoText     = "EVIDENCE_NO_TEXT_FOUND"
	flagAmount     = "EVIDENCE_AMOUNT_NOT_ON_IMAGE"
	flagReference  = "EVIDENCE_ID_NOT_ON_IMAGE"
	flagNotReceipt = "EVIDENCE_NOT_A_PAYMENT_RECORD"
	flagConfirmed  = "EVIDENCE_TEXT_MATCHES_CLAIM"
	flagOnImage    = "EVIDENCE_REFERENCE_ON_IMAGE"
)

var devanagari = strings.NewReplacer("०", "0", "१", "1", "२", "2", "३", "3", "४", "4", "५", "5", "६", "6", "७", "7", "८", "8", "९", "9")

func normalizeDigits(s string) string { return devanagari.Replace(s) }

var (
	numberRun       = jsre("", `[\dOoIlBS][\dOoIlBS,\s]*(?:\.\d+)?`)
	hasDigit        = regexp.MustCompile(`\d`)
	spacesCommas    = jsre("", `[\s,]`)
	confusableDigit = strings.NewReplacer("B", "8", "I", "1", "O", "0", "S", "5", "l", "1", "o", "0")
	trailingZero    = regexp.MustCompile(`\.0+$`)
	notAlnum        = regexp.MustCompile(`[^A-Z0-9]`)
	digitFold       = strings.NewReplacer("O", "0", "Q", "0", "I", "1", "L", "1", "!", "1", "|", "1", "B", "8", "S", "5")
)

func numbersIn(text string) map[string]bool {
	found := map[string]bool{}
	for _, m := range numberRun.FindAllString(normalizeDigits(text), -1) {
		if !hasDigit.MatchString(m) {
			continue
		}
		raw := confusableDigit.Replace(spacesCommas.ReplaceAllString(m, ""))
		found[trailingZero.ReplaceAllString(raw, "")] = true
		found[raw] = true
	}
	return found
}

func canonical(s string) string {
	return notAlnum.ReplaceAllString(jsUpper(normalizeDigits(s)), "")
}

func jsUpper(s string) string { return strings.ToUpper(s) }

func canonicalDigits(s string) string {
	return canonical(digitFold.Replace(jsUpper(normalizeDigits(s))))
}

func containsTolerant(haystack, needle string) bool {
	if strings.Contains(haystack, needle) {
		return true
	}
	if len(needle) < 10 {
		return false
	}
	for start := 0; start <= len(haystack)-len(needle); start++ {
		miss := 0
		for i := 0; i < len(needle); i++ {
			if haystack[start+i] != needle[i] {
				miss++
				if miss > 1 {
					break
				}
			}
		}
		if miss <= 1 {
			return true
		}
	}
	return false
}

// ClaimFacts is what the resident says about a payment.
type ClaimFacts struct {
	Amount          int64
	ReferenceCode   string
	TransactionCode string
}

// ReferenceOnEvidence is referenceOnEvidence.
func ReferenceOnEvidence(text, code string) bool {
	if code == "" {
		return false
	}
	return strings.Contains(canonical(text), canonical(code)) || slices.Contains(ExtractReferenceCodes(text), code)
}

// ExtractedFields is ExtractedClaimFields; nil pointers are absent keys.
type ExtractedFields struct {
	Amount          *int64
	TransactionCode string
	ReferenceCode   string
	Method          string
}

var (
	idLabels     = ci(`(?:transaction\s*(?:code|id|no\.?|number)|txn\s*(?:id|no\.?)?|reference\s*(?:code|no\.?|number|id)|ref\s*no\.?|rrn|trace\s*(?:id|no\.?)?|receipt\s*no\.?|purchase\s*order\s*id)\s*[:\-#]?\s*([A-Za-z0-9][A-Za-z0-9\-/]{4,})`)
	amountLabels = []*regexp.Regexp{
		ci(`(?:total\s*(?:amount|paid)?|amount\s*paid|paid\s*amount)\s*[:\-]?\s*(?:rs\.?|npr|रु)?\s*([\d,]+(?:\.\d{1,2})?)`),
		ci(`\b(?:rs\.?|npr|रु)\s*([\d,]+(?:\.\d{1,2})?)`),
		ci(`\bamount\s*[:\-]?\s*([\d,]+(?:\.\d{1,2})?)`),
	}
	methodMarkers = []struct {
		re     *regexp.Regexp
		method string
	}{
		{ci(`\besewa\b`), "ESEWA"},
		{ci(`\bkhalti\b`), "KHALTI"},
		{ci(`\bfone\s?pay\b`), "FONEPAY"},
		{ci(`\bconnect\s?ips\b`), "BANK_TRANSFER"},
		{ci(`\b(bank|nabil|nic asia|global ime|siddhartha|prabhu|kumari|sanima|machhapuchchhre|nmb)\b`), "BANK_TRANSFER"},
	}
)

func wholeRupees(raw string) *int64 {
	v, err := strconv.ParseFloat(leadingFloat(strings.ReplaceAll(raw, ",", "")), 64)
	if err != nil || v <= 0 || v > 10_000_000 {
		return nil
	}
	n := int64(math.Floor(v))
	return &n
}

var floatPrefix = regexp.MustCompile(`^\d*\.?\d*`)

// leadingFloat is what parseFloat reads of a string.
func leadingFloat(s string) string { return floatPrefix.FindString(s) }

// ExtractClaimFields is extractClaimFields.
func ExtractClaimFields(text string) ExtractedFields {
	normalized := normalizeDigits(text)
	out := ExtractedFields{}
	for _, re := range amountLabels {
		if m := re.FindStringSubmatch(normalized); m != nil && m[1] != "" {
			if r := wholeRupees(m[1]); r != nil {
				out.Amount = r
				break
			}
		}
	}
	if m := idLabels.FindStringSubmatch(normalized); m != nil {
		if id := jsTrim(m[1]); id != "" && TransactionCodeProblem(id) == "" {
			out.TransactionCode = id
		}
	}
	if codes := ExtractReferenceCodes(text); len(codes) > 0 {
		out.ReferenceCode = codes[0]
	}
	for _, x := range methodMarkers {
		if x.re.MatchString(text) {
			out.Method = x.method
			break
		}
	}
	return out
}

var receiptSignalRes = []*regexp.Regexp{
	ci(`\b(esewa|khalti|fone\s?pay|connect\s?ips|ime\s?pay|prabhu\s?pay|bank|nabil|nic asia|global ime|siddhartha|kumari|sanima|machhapuchchhre|nmb|laxmi|everest bank)\b`),
	ci(`(?:rs\.?|npr|रु)\s*[\d०-९]`),
	ci(`\b(transaction|txn|reference|ref\s*no|rrn|trace|balance|successful|success|paid|payment|transferred|transfer|receipt|voucher|statement|remarks|debited|credited)\b`),
	ci(`(\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{2,4}\b)`),
}

func receiptSignalCount(text string) int {
	n := 0
	for _, re := range receiptSignalRes {
		if re.MatchString(text) {
			n++
		}
	}
	return n
}

// LooksLikePaymentReceipt is looksLikePaymentReceipt.
func LooksLikePaymentReceipt(text string) bool { return receiptSignalCount(text) >= 2 }

var anySpace = jsre("", `\s+`)

// IsDefinitelyNotPayment is isDefinitelyNotPaymentEvidence.
func IsDefinitelyNotPayment(text string) bool {
	if len([]rune(anySpace.ReplaceAllString(text, ""))) < 40 {
		return false
	}
	return receiptSignalCount(text) == 0
}

// EvidenceTextFlags is evidenceTextFlags for text that was read.
func EvidenceTextFlags(text string, f ClaimFacts) []string {
	typed := ""
	if f.TransactionCode != "" {
		typed = canonicalDigits(f.TransactionCode)
	}
	amount := numbersIn(text)[strconv.FormatInt(f.Amount, 10)]
	reference := ReferenceOnEvidence(text, f.ReferenceCode)
	transaction := len(typed) >= 6 && containsTolerant(canonicalDigits(text), typed)
	if !LooksLikePaymentReceipt(text) {
		return []string{flagNotReceipt}
	}
	if !amount && !transaction && !reference {
		return []string{flagNoText}
	}
	flags := []string{}
	if !amount {
		flags = append(flags, flagAmount)
	}
	if !transaction && !reference {
		flags = append(flags, flagReference)
	}
	if len(flags) > 0 {
		return flags
	}
	if reference {
		return []string{flagConfirmed, flagOnImage}
	}
	return []string{flagConfirmed}
}

// --- transaction-code.ts + txn-id-rules.ts -----------------------------------------

var (
	codeJunk     = jsre("", `[\s\-_/.]`)
	notLetters   = regexp.MustCompile(`[^A-Z]`)
	placeholders = map[string]bool{"ABC": true, "ASDF": true, "DEMO": true, "DUMMY": true, "FAKE": true, "NA": true, "NIL": true, "NONE": true, "NOTHING": true, "PAID": true, "QWERTY": true, "SAMPLE": true, "TEST": true, "TESTING": true, "UNKNOWN": true, "XXX": true, "YES": true}
	esewaShape   = regexp.MustCompile(`^[0-9A-Z]{7}$`)
)

func codeCanonical(raw string) string { return codeJunk.ReplaceAllString(jsUpper(jsTrim(raw)), "") }

// TransactionCodeProblem is transactionCodeProblem; "" means plausible.
func TransactionCodeProblem(raw string) string {
	v := codeCanonical(raw)
	if v == "" {
		return ""
	}
	if len(v) < 6 {
		return "That transaction ID looks too short. Open the app you paid with and copy the full transaction or reference ID from the payment receipt."
	}
	if placeholders[v] {
		return "Please enter the real transaction ID from your payment receipt, not a placeholder."
	}
	if isRepeated(v) || isSequential(v) {
		return "That does not look like a transaction ID. Open the app you paid with and copy the ID from the payment receipt."
	}
	if !hasDigit.MatchString(v) {
		return "A transaction ID contains numbers. Open the app you paid with and copy the ID from the payment receipt."
	}
	return ""
}

func isRepeated(v string) bool {
	return len(v) > 1 && strings.Count(v, v[:1]) == len(v)
}

func isSequential(v string) bool {
	if len(v) < 3 {
		return false
	}
	step := int(v[1]) - int(v[0])
	if step != 1 && step != -1 {
		return false
	}
	for i := 1; i < len(v); i++ {
		if int(v[i])-int(v[i-1]) != step {
			return false
		}
	}
	return true
}

// TransactionCodeRequired is transactionCodeRequired.
func TransactionCodeRequired(method string) bool {
	return method == "BANK_TRANSFER" || method == "ESEWA" || method == "FONEPAY" || method == "KHALTI"
}

// TxnIDFlags is txnIdFlags: eSewa is the one provider with a proven shape.
func TxnIDFlags(method, code string) []string {
	v := codeCanonical(code)
	if strings.ToUpper(method) != "ESEWA" || v == "" {
		return nil
	}
	if esewaShape.MatchString(v) {
		return []string{"EVIDENCE_TXN_ID_SHAPE_OK"}
	}
	return []string{"EVIDENCE_TXN_ID_MALFORMED"}
}

// --- evidence-direction.ts ---------------------------------------------------------

// DirectionRead is what the receipt says about which way the money went.
type DirectionRead struct {
	Direction    string
	IsLedgerView bool
	Outcome      string
	StrongCredit bool
}

var (
	debitMarkers = []*regexp.Regexp{ci(`\bq\.?r\.?\s*merchant\b`), ci(`\bmerchant\s*(?:name|code|id)\b`), ci(`\binitiat(?:or|ed\s+by)\b`), ci(`\bdebit(?:ed)?\s*(?:from|amount|amt)?\b`), ci(`(?:^|[\s|(])dr\.?(?:$|[\s|):])`),
		ci(`\b(?:sent|send|sending)\s+(?:money\s+)?to\b`), ci(`\bpaid\s+to\b`), ci(`\bpayment\s+(?:to|made\s+to)\b`), ci(`\btransfer(?:red)?\s+to\b`), ci(`\byou\s+(?:have\s+)?(?:sent|paid|transferred)\b`),
		ci(`\b(?:withdraw(?:al|n)?|cash\s+out)\b`), ci(`\b(?:receiver|recipient|beneficiary|payee|credited\s+to)\b`), ci(`\b(?:outgoing|money\s+out|debit\s+transaction)\b`)}
	creditMarkers = []*regexp.Regexp{ci(`\breceiv(?:ed|e)\s+from\b`), ci(`\byou\s+(?:have\s+)?receiv(?:ed|e)\b`), ci(`\bcredit(?:ed)?\s+to\s+your\s+(?:account|wallet|balance)\b`), ci(`\b(?:amount|money|fund)\s+credit(?:ed)?\b`),
		ci(`\b(?:deposit(?:ed)?|cash\s+in|load(?:ed)?\s+fund|fund\s+load)\b`), ci(`\b(?:refund(?:ed)?|reversal|reversed|cashback|bonus|reward)\b`), ci(`(?:^|[\s|(])cr\.?(?:$|[\s|):])`), ci(`\b(?:sender|remitter|from\s+account|payer)\b`), ci(`\bcredit\b`), ci(`\b(?:incoming|money\s+in|credit\s+transaction)\b`)}
	outcomeMarkers = []struct {
		outcome string
		re      *regexp.Regexp
	}{{"FAILED", ci(`\b(?:fail(?:ed|ure)?|declined|unsuccessful|rejected|error)\b`)}, {"CANCELLED", ci(`\b(?:cancel(?:led|ed)?|void(?:ed)?|expired)\b`)}, {"PENDING", ci(`\b(?:pending|processing|in\s+progress|awaiting|on\s+hold)\b`)}, {"SUCCESS", ci(`\b(?:success(?:ful|fully)?|completed?|approved|confirmed)\b`)}}
)

const strongCreditMarkers = 6

// ReadDirection is readEvidenceDirection.
func ReadDirection(text string) DirectionRead {
	if text == "" {
		return DirectionRead{Direction: "UNKNOWN", Outcome: "UNKNOWN"}
	}
	debit, credit, strong := 0, 0, false
	for _, re := range debitMarkers {
		if re.MatchString(text) {
			debit++
		}
	}
	for i, re := range creditMarkers {
		if re.MatchString(text) {
			credit++
			strong = strong || i < strongCreditMarkers
		}
	}
	outcome := "UNKNOWN"
	for _, x := range outcomeMarkers {
		if x.re.MatchString(text) {
			outcome = x.outcome
			break
		}
	}
	ledger := debit >= 2 && credit >= 2
	switch {
	case ledger:
		return DirectionRead{"UNKNOWN", true, outcome, false}
	case debit > credit:
		return DirectionRead{"DEBIT", false, outcome, strong}
	case credit > debit:
		return DirectionRead{"CREDIT", false, outcome, strong}
	}
	return DirectionRead{"UNKNOWN", false, outcome, strong}
}

// DirectionRefusal is directionRefusal.
func DirectionRefusal(r DirectionRead) string {
	if !r.IsLedgerView && r.Direction == "CREDIT" && r.StrongCredit {
		return "That receipt shows money coming *into* your account, not a payment you made. Please upload the receipt for the payment you sent to the hostel — the one showing the money leaving your account."
	}
	return ""
}

// OutcomeRefusal is outcomeRefusal.
func OutcomeRefusal(r DirectionRead) string {
	switch r.Outcome {
	case "FAILED":
		return "That receipt says the transaction failed, so no money left your account. Please upload the receipt for a payment that went through."
	case "CANCELLED":
		return "That receipt says the transaction was cancelled, so no money left your account. Please upload the receipt for a payment that went through."
	}
	return ""
}

// --- evidence-payee.ts -------------------------------------------------------------

// PayeeIdentity is HostelPayeeIdentity.
type PayeeIdentity struct {
	AccountIDs []string
	Names      []string
}

// PayeeProfile is the slice of a payment profile the identity is built from.
type PayeeProfile struct {
	BankAccountName   *string `bson:"bankAccountName"`
	BankAccountNumber *string `bson:"bankAccountNumber"`
	DisplayName       *string `bson:"displayName"`
	EsewaID           *string `bson:"esewaId"`
	Extra             []struct {
		AccountName *string `bson:"accountName"`
		Number      *string `bson:"number"`
	} `bson:"extraAccounts"`
	KhaltiID      *string `bson:"khaltiId"`
	QRPayeeName   *string `bson:"qrPayeeName"`
	QRPayeeNumber *string `bson:"qrPayeeNumber"`
}

var notDigits = regexp.MustCompile(`\D`)

// HostelPayeeIdentity is hostelPayeeIdentity.
func HostelPayeeIdentity(p *PayeeProfile, hostelName string) PayeeIdentity {
	if p == nil {
		p = &PayeeProfile{}
	}
	names := []*string{p.DisplayName, p.BankAccountName}
	ids := []*string{p.EsewaID, p.KhaltiID, p.BankAccountNumber}
	for i := range p.Extra {
		names = append(names, p.Extra[i].AccountName)
		ids = append(ids, p.Extra[i].Number)
	}
	names = append(names, p.QRPayeeName, &hostelName)
	ids = append(ids, p.QRPayeeNumber)
	out := PayeeIdentity{AccountIDs: []string{}, Names: []string{}}
	for _, n := range names {
		if v := jsTrim(deref(n)); v != "" {
			out.Names = append(out.Names, v)
		}
	}
	for _, id := range ids {
		if v := notDigits.ReplaceAllString(deref(id), ""); len(v) >= 8 {
			out.AccountIDs = append(out.AccountIDs, v)
		}
	}
	return out
}

var (
	nameStop     = map[string]bool{"AND": true, "BOYS": true, "CO": true, "COMPANY": true, "GIRLS": true, "HOME": true, "HOSTEL": true, "HOSTELS": true, "HOUSE": true, "LIMITED": true, "LTD": true, "NEPAL": true, "PG": true, "PRIVATE": true, "PVT": true, "RESIDENCY": true, "THE": true}
	notUpper     = regexp.MustCompile(`[^A-Z]+`)
	notLatin     = regexp.MustCompile(`[^A-Za-z]`)
	payeeLabels  = ci(`(?:^|\n)\s*(?:sent\s+to|send\s+to|paid\s+to|pay\s+to|payment\s+to|transferred\s+to|transfer\s+to|credited\s+to|receiver(?:'s)?(?:\s+name)?|recipient(?:'s)?(?:\s+name)?|beneficiary(?:\s+name)?|payee(?:\s+name)?|(?:q\.?r\.?\s*)?merchant(?:\s+name)?|to)\s*[:\-–]\s*([^\n]{2,80})`)
	payeeTabular = ci(`(?:^|\n)[ \t|]*(?:sent\s+to|paid\s+to|transferred\s+to|credited\s+to|receiver(?:'s)?(?:\s+name)?|recipient(?:'s)?(?:\s+name)?|beneficiary(?:\s+name)?|payee(?:\s+name)?|(?:q\.?r\.?\s*)?merchant(?:\s+name)?)[ \t|]*(?:\n[ \t|]*)?([^\n]{2,80})`)
	twoSpaces    = jsre("", `\s{2,}`)
	endPunct     = regexp.MustCompile(`[.,;]+$`)
	nameLetter   = regexp.MustCompile(`[A-Za-z\x{0900}-\x{097F}]`)
)

func nameTokens(v string) []string {
	out := []string{}
	for _, t := range notUpper.Split(jsUpper(v), -1) {
		if len(t) >= 3 && !nameStop[t] {
			out = append(out, t)
		}
	}
	return out
}

func extractPayee(text string) string {
	m := payeeLabels.FindStringSubmatch(text)
	if m == nil {
		m = payeeTabular.FindStringSubmatch(text)
	}
	if m == nil {
		return ""
	}
	raw := jsTrim(m[1])
	if raw == "" {
		return ""
	}
	cleaned := jsTrim(endPunct.ReplaceAllString(twoSpaces.ReplaceAllString(raw, " "), ""))
	if !nameLetter.MatchString(cleaned) {
		return ""
	}
	return cleaned
}

// PayeeRead is what the receipt says about who was paid.
type PayeeRead struct {
	Payee   string
	Verdict string
}

func matchesIdentity(text, payee string, id PayeeIdentity) bool {
	digits := notDigits.ReplaceAllString(text, "")
	for _, a := range id.AccountIDs {
		if strings.Contains(digits, a[len(a)-8:]) {
			return true
		}
	}
	if payee == "" {
		return false
	}
	mine := nameTokens(payee)
	for _, name := range id.Names {
		tokens := nameTokens(name)
		for _, t := range tokens {
			if slices.Contains(mine, t) {
				return true
			}
		}
		letters := jsUpper(notLatin.ReplaceAllString(name, ""))
		if len(tokens) == 0 && len(letters) >= 4 && strings.Contains(jsUpper(notLatin.ReplaceAllString(payee, "")), letters) {
			return true
		}
	}
	return false
}

// ReadPayee is readPayeeOnEvidence.
func ReadPayee(text string, id PayeeIdentity, template string) PayeeRead {
	if text == "" {
		return PayeeRead{"", "UNKNOWN"}
	}
	payee := jsTrim(template)
	if payee == "" {
		payee = extractPayee(text)
	}
	if len(id.AccountIDs) == 0 && len(id.Names) == 0 {
		return PayeeRead{payee, "UNKNOWN"}
	}
	if matchesIdentity(text, payee, id) {
		return PayeeRead{payee, "MATCHED"}
	}
	if payee != "" {
		return PayeeRead{payee, "FOREIGN"}
	}
	return PayeeRead{"", "UNKNOWN"}
}

// PayeeRefusal is payeeRefusal.
func PayeeRefusal(r PayeeRead) string {
	if r.Verdict != "FOREIGN" {
		return ""
	}
	return "That receipt shows the money went to " + r.Payee + ", which is not an account this hostel collects payments in. If you were asked to pay that account, please check with the hostel office before submitting — payments to any other account cannot be credited to your invoice."
}

// --- evidence-receipt.ts ------------------------------------------------------------

// ParsedReceipt is the template read of one receipt.
type ParsedReceipt struct {
	Amount    *int64
	Payee     string
	Direction string
	Provider  string
	Shape     string
	TxnID     string
}

type receiptTemplate struct {
	amount, payee, txn string
	brand              *regexp.Regexp
	provider           string
}

var (
	receiptTemplates = []receiptTemplate{
		{`amount(?:\s*\(?npr\)?)?|total\s*amount|paid\s*amount`, `(?:sent\s*to|paid\s*to|receiver(?:'s)?(?:\s*name)?|recipient(?:\s*name)?|q\.?r\.?\s*merchant(?:\s*name)?|merchant(?:\s*name)?|to)`, `(?:transaction\s*code|reference\s*code|transaction\s*id|txn\s*id)`, ci(`\be-?sewa\b`), "ESEWA"},
		{`amount(?:\s*\(?(?:npr|rs\.?)\)?)?|total|paid`, `(?:paid\s*to|sent\s*to|receiver(?:'s)?(?:\s*name)?|recipient(?:\s*name)?|merchant(?:\s*name)?|product\s*name|to)`, `(?:purchase\s*order\s*id|transaction\s*id|txn\s*id|idx|transaction\s*code)`, ci(`\bkhalti\b`), "KHALTI"},
		{`amount(?:\s*\(?(?:npr|rs\.?)\)?)?|total\s*amount`, `(?:q\.?r\.?\s*merchant(?:\s*name)?|merchant(?:\s*name)?|paid\s*to|sent\s*to|receiver(?:'s)?(?:\s*name)?|recipient(?:\s*name)?|to)`, `(?:trace\s*(?:id|no\.?)|reference\s*code|transaction\s*id|txn\s*id|reference\s*(?:no\.?|id))`, ci(`\bfone\s?pay\b`), "FONEPAY"},
		{`amount(?:\s*\(?(?:npr|rs\.?)\)?)?|total\s*amount|transfer\s*amount`, `(?:beneficiary(?:\s*name)?|credited\s*to|receiver(?:'s)?(?:\s*name)?|payee(?:\s*name)?|to\s*account|to)`, `(?:transaction\s*id|reference\s*(?:no\.?|id)|rrn|txn\s*id)`, ci(`\bconnect\s?ips\b`), "CONNECTIPS"},
		{`amount(?:\s*\(?(?:npr|rs\.?)\)?)?|total\s*amount|transaction\s*amount`, `(?:q\.?r\.?\s*merchant(?:\s*name)?|merchant(?:\s*name)?|beneficiary(?:\s*name)?|credited\s*to|receiver(?:'s)?(?:\s*name)?|payee(?:\s*name)?|to\s*account)`, `(?:reference\s*code|transaction\s*id|reference\s*(?:no\.?|id)|rrn|txn\s*id|trace\s*(?:id|no\.?)|receipt\s*no\.?)`, ci(`\b(?:bank|nabil|nic\s*asia|global\s*ime|siddhartha|prabhu|kumari|sanima|machhapuchchhre|nmb|laxmi|everest|ebl|nabil|rastriya\s*banijya|nepal\s*investment)\b|payment\s*attribute|q\.?r\.?\s*merchant\s*name`), "BANK"},
	}
	nextLabel      = jsre("", `\s+[A-Za-z][A-Za-z.]*(?:\s+[A-Za-z][A-Za-z.]*){0,2}\s+[:\-–]\s`)
	statementTitle = ci(`\b(?:account\s*statement|transaction\s*statement|statement\s*of\s*account|mini\s*statement|passbook|transaction\s*history)\b`)
	statementPairs = [][2]*regexp.Regexp{{ci(`(?:^|[\s|])cr\.?(?:$|[\s|])`), ci(`(?:^|[\s|])dr\.?(?:$|[\s|])`)}, {ci(`amount\s*\(\+\)`), ci(`amount\s*\(-\)`)}, {ci(`\bcredit\b`), ci(`\bdebit\b`)}}
	amountRun      = jsre("", `(\d[\d,\s]*(?:\.\d{1,2})?)`)
	headline       = ci(`(?:rs\.?|npr|रु)\s*([\d,\s]*\d(?:\.\d{1,2})?)`)
	nameSuffix     = jsre("", `\s*\(\s*(?:[^\s()@]+@[^\s()]+|\+?[\d\s-]{6,})\s*\)\s*$`)
	nameEndPunct   = regexp.MustCompile(`[.,;|]+$`)
	nameBlank      = ci(`^(?:n/?a|null|none|-{1,})$`)
	nameMasked     = regexp.MustCompile(`[*•]{3,}`)
	endPipes       = regexp.MustCompile(`[|]+$`)
	labelCache     = map[string][3]*regexp.Regexp{}
)

func init() {
	for _, t := range receiptTemplates {
		for _, s := range []string{t.amount, t.payee, t.txn} {
			labelCache[s] = [3]*regexp.Regexp{
				ci(`(?:^|\n)[ \t|]*(?:` + s + `)[ \t|]*[:\-–][ \t|]*([^\n]{1,120})`),
				ci(`(?:^|\n)[ \t|]*(?:` + s + `)[ \t|]{1,}([^\n]{1,120})`),
				ci(`(?:^|\n)[ \t|]*(?:` + s + `)[ \t|]*\n[ \t|]*([^\n]{1,120})`),
			}
		}
	}
}

func labelledValue(text, label string) string {
	for _, re := range labelCache[label] {
		m := re.FindStringSubmatch(text)
		if m == nil {
			continue
		}
		raw := m[1]
		if cut := nextLabel.FindStringIndex(raw); cut != nil {
			raw = raw[:cut[0]]
		}
		if v := jsTrim(endPipes.ReplaceAllString(jsTrim(raw), "")); v != "" {
			return v
		}
	}
	return ""
}

func toAmount(raw string) *int64 {
	if raw == "" {
		return nil
	}
	m := amountRun.FindStringSubmatch(raw)
	if m == nil {
		return nil
	}
	return wholeRupees(spacesCommas.ReplaceAllString(m[1], ""))
}

func toName(raw string) string {
	if raw == "" {
		return ""
	}
	c := twoSpaces.ReplaceAllString(raw, " ")
	c = nameSuffix.ReplaceAllString(c, "")
	c = jsTrim(nameEndPunct.ReplaceAllString(c, ""))
	if !nameLetter.MatchString(c) || nameBlank.MatchString(c) || nameMasked.MatchString(c) {
		return ""
	}
	return c
}

// LooksLikeStatement is looksLikeStatement.
func LooksLikeStatement(text string) bool {
	if statementTitle.MatchString(text) {
		return true
	}
	for _, p := range statementPairs {
		if p[0].MatchString(text) && p[1].MatchString(text) {
			return true
		}
	}
	return false
}

// ParseReceipt is parseReceipt.
func ParseReceipt(text string) ParsedReceipt {
	out := ParsedReceipt{Provider: "UNKNOWN", Shape: "UNKNOWN"}
	if text == "" {
		return out
	}
	statement := LooksLikeStatement(text)
	var tpl *receiptTemplate
	for i := range receiptTemplates {
		if receiptTemplates[i].brand.MatchString(text) {
			tpl = &receiptTemplates[i]
			out.Provider = tpl.provider
			break
		}
	}
	if statement {
		out.Shape = "STATEMENT"
		return out
	}
	if tpl == nil {
		return out
	}
	out.Payee = toName(labelledValue(text, tpl.payee))
	out.Amount = toAmount(labelledValue(text, tpl.amount))
	if out.Amount == nil {
		if m := headline.FindStringSubmatch(text); m != nil {
			out.Amount = toAmount(m[1])
		}
	}
	if out.Payee != "" {
		out.Direction = "DEBIT"
	}
	out.Shape = "RECEIPT"
	out.TxnID = labelledValue(text, tpl.txn)
	return out
}

// MethodForProvider is methodForProvider.
func MethodForProvider(p string) string {
	switch p {
	case "ESEWA", "KHALTI", "FONEPAY":
		return p
	case "BANK", "CONNECTIPS":
		return "BANK_TRANSFER"
	}
	return ""
}

// StatementGuidance is STATEMENT_GUIDANCE.
const StatementGuidance = "That looks like a full account statement rather than a receipt for one payment. Please upload the receipt or screenshot for the single payment you made to the hostel — the statement does not show which row is this month's rent."

// --- system documents and banks ------------------------------------------------------

var (
	receiptNumberRe = ci(`\bRCP[-\s]?[A-Z]{3}[-\s]?\d{4}[-\s]?\d{2}[-\s]?\d{5}\b`)
	systemFooterRe  = ci(`not\s+a\s+proof[-\s]?of[-\s]?payment\s+upload`)
	banks           = []struct {
		re        *regexp.Regexp
		key, name string
	}{{ci(`\bnabil\b`), "nabil", "Nabil Bank"}, {ci(`\bnic\s*asia\b`), "nic-asia", "NIC Asia"}, {ci(`\bglobal\s*ime\b`), "global-ime", "Global IME"}, {ci(`\bhimalayan\s+bank\b`), "himalayan", "Himalayan Bank"}, {ci(`\bkumari\s+bank\b`), "kumari", "Kumari Bank"},
		{ci(`\b(laxmi\s+sunrise|laxmi\s+bank|sunrise\s+bank)\b`), "laxmi-sunrise", "Laxmi Sunrise"}, {ci(`\bmachh?apuchh?h?re\b`), "machhapuchchhre", "Machhapuchchhre"}, {ci(`\bnepal\s+bank\b`), "nepal-bank", "Nepal Bank"}, {ci(`\b(nepal\s+investment|nimb|mega\s+bank)\b`), "nepal-investment-mega", "NIMB"},
		{ci(`\b(nepal\s+sbi|sbi\s+bank)\b`), "nepal-sbi", "Nepal SBI"}, {ci(`\bnmb\b`), "nmb", "NMB Bank"}, {ci(`\bprabhu\s+bank\b`), "prabhu", "Prabhu Bank"}, {ci(`\bprime\s+(commercial|bank)\b`), "prime-commercial", "Prime Bank"}, {ci(`\bsanima\b`), "sanima", "Sanima Bank"},
		{ci(`\bsiddhartha\s+bank\b`), "siddhartha", "Siddhartha Bank"}, {ci(`\bstandard\s+chartered\b`), "standard-chartered", "Standard Chartered"}, {ci(`\beverest\s+bank\b`), "everest", "Everest Bank"}, {ci(`\bcitizens\s+bank\b`), "citizens", "Citizens Bank"}, {ci(`\b(agricultural\s+development|adbl)\b`), "agricultural-development", "ADBL"}}
)

// SystemDocumentFromText is systemDocumentKindFromText: "RECEIPT" or "".
func SystemDocumentFromText(text string) string {
	if text != "" && (receiptNumberRe.MatchString(text) || systemFooterRe.MatchString(text)) {
		return "RECEIPT"
	}
	return ""
}

// ReceiptBank is receiptBank: the bank named first on the page.
func ReceiptBank(text string) (key, name string) {
	best := -1
	for _, b := range banks {
		if at := b.re.FindStringIndex(text); at != nil && (best == -1 || at[0] < best) {
			best, key, name = at[0], b.key, b.name
		}
	}
	return key, name
}

// ProvenanceFlags is provenanceFlags, read off the stored document.
func ProvenanceFlags(p *StoredProvenance) []string {
	if p == nil {
		return nil
	}
	flags := []string{}
	if p.EditorSignature != nil && *p.EditorSignature != "" {
		flags = append(flags, "EVIDENCE_EDITOR_SIGNATURE")
	}
	if p.QuantStandard != nil && !*p.QuantStandard {
		flags = append(flags, "EVIDENCE_FILE_RE_ENCODED")
	}
	if p.CameraExif != nil && *p.CameraExif {
		flags = append(flags, "EVIDENCE_NOT_A_SCREENSHOT")
	}
	if p.ScreenshotShape != nil && !*p.ScreenshotShape {
		flags = append(flags, "EVIDENCE_DIMENSIONS_UNUSUAL")
	}
	return flags
}

// StoredProvenance is FileAsset.provenance as the claim reads it back.
type StoredProvenance struct {
	CameraExif      *bool   `bson:"hasCameraExif"`
	EditorSignature *string `bson:"editorSignature"`
	QuantStandard   *bool   `bson:"quantTablesStandard"`
	ScreenshotShape *bool   `bson:"screenshotShape"`
}

// HammingNear is isPerceptualNearDuplicate.
func HammingNear(a, b string) bool {
	if len(a) != len(b) || len(a) == 0 {
		return false
	}
	distance := 0
	for i := 0; i < len(a); i++ {
		l, err1 := strconv.ParseUint(a[i:i+1], 16, 8)
		r, err2 := strconv.ParseUint(b[i:i+1], 16, 8)
		if err1 != nil || err2 != nil {
			return false
		}
		for x := l ^ r; x > 0; x >>= 1 {
			distance += int(x & 1)
		}
	}
	return distance <= 10
}
