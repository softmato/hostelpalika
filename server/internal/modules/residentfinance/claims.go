package residentfinance

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/ledger"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

const (
	evidenceMaxAge  = 14 * 24 * time.Hour
	claimLimit      = 8
	rejectedRetries = 3
	paidAtFuture    = 6 * time.Hour
	paidAtMaxAge    = 365 * 24 * time.Hour
	reusedCodeTail  = " has already been recorded for a payment. Each payment has its own ID — check the ID on this transfer."
)

type evidenceAsset struct {
	ID       bson.ObjectID  `bson:"_id"`
	Bucket   string         `bson:"bucket"`
	Hash     string         `bson:"contentHash"`
	HostelID *bson.ObjectID `bson:"hostelId"`
	Insight  *struct {
		NearBlank *bool `bson:"nearBlank"`
		Width     *int  `bson:"width"`
	} `bson:"imageInsight"`
	Key        string                    `bson:"key"`
	Mime       string                    `bson:"mimeType"`
	OwnerID    *bson.ObjectID            `bson:"ownerId"`
	PHash      string                    `bson:"perceptualHash"`
	Provenance *finance.StoredProvenance `bson:"provenance"`
	SystemKind string                    `bson:"systemDocumentKind"`
	Completed  *time.Time                `bson:"uploadCompletedAt"`
}

func (a *evidenceAsset) readable() bool {
	if IsPDFAsset(a) {
		return true
	}
	return a.Insight != nil && a.Insight.Width != nil && a.Insight.NearBlank != nil && !*a.Insight.NearBlank
}

// IsPDFAsset is isPdfEvidence on the asset's mime type.
func IsPDFAsset(a *evidenceAsset) bool { return finance.IsPDF(a.Mime) }

func systemRefusal(kind string) error {
	if kind == "STATEMENT" {
		return finance.Err("EVIDENCE_IS_SYSTEM_DOCUMENT", "That is your hostel statement, which we generated. Please upload the screenshot or receipt from the app you paid with.")
	}
	return finance.Err("EVIDENCE_IS_SYSTEM_DOCUMENT", "That is a receipt your hostel issued, not a record of your payment. Please upload the screenshot or receipt from the app you paid with.")
}

func (h *Handler) usableAsset(ctx context.Context, assetID string, r *residents.Record, p *authz.Principal) (*evidenceAsset, error) {
	notYours := finance.Err("ASSET_NOT_OWNED", "This file is not yours to submit. Upload the screenshot again.")
	id, err := bson.ObjectIDFromHex(assetID)
	if err != nil {
		return nil, notYours
	}
	var a evidenceAsset
	err = h.DB.Collection("fileassets").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}}).Decode(&a)
	if err != nil && err != mongo.ErrNoDocuments {
		return nil, err
	}
	if err != nil || a.OwnerID == nil || a.OwnerID.Hex() != p.UserID {
		return nil, notYours
	}
	if a.HostelID != nil && *a.HostelID != r.HostelID {
		return nil, notYours
	}
	if a.Completed == nil {
		return nil, finance.Err("ASSET_UPLOAD_INCOMPLETE", "This file did not finish uploading. Please upload the screenshot again.")
	}
	if a.Completed.Before(time.Now().Add(-evidenceMaxAge)) {
		return nil, finance.Err("ASSET_UPLOAD_INCOMPLETE", "That upload has expired. Please upload the screenshot again.")
	}
	if a.SystemKind != "" {
		return nil, systemRefusal(a.SystemKind)
	}
	if a.Insight != nil && a.Insight.NearBlank != nil && *a.Insight.NearBlank {
		return nil, finance.Err("EVIDENCE_NOT_READABLE", "That image is blank or too small to read. Please upload the screenshot from the app you paid with.")
	}
	err = h.DB.Collection("paymentevents").FindOne(ctx, bson.D{{Key: "evidenceAssetId", Value: a.ID}, {Key: "hostelId", Value: r.HostelID}}).Err()
	if err == nil {
		return nil, finance.Err("EVIDENCE_ALREADY_USED", "This screenshot has already been submitted. Please upload the screenshot for this payment.")
	}
	if err != mongo.ErrNoDocuments {
		return nil, err
	}
	return &a, nil
}

type priorClaim struct {
	Invoice  *bson.ObjectID `bson:"invoiceId"`
	Occurred *time.Time     `bson:"occurredAt"`
	Resident *bson.ObjectID `bson:"residentId"`
}

type priorOut struct {
	PriorPeriod      any    `json:"priorPeriod"`
	PriorSubmittedAt any    `json:"priorSubmittedAt"`
	TransactionCode  string `json:"transactionCode,omitempty"`
}

func (h *Handler) describePrior(ctx context.Context, prior *priorClaim, resident bson.ObjectID) priorOut {
	if prior.Resident == nil || *prior.Resident != resident {
		return priorOut{}
	}
	out := priorOut{}
	if prior.Invoice != nil {
		var inv struct {
			Period *string `bson:"period"`
		}
		if h.DB.Collection("invoices").FindOne(ctx, bson.D{{Key: "_id", Value: *prior.Invoice}}).Decode(&inv) == nil {
			out.PriorPeriod = nilable(inv.Period)
		}
	}
	if prior.Occurred != nil {
		out.PriorSubmittedAt = httpx.ISO(*prior.Occurred)
	}
	return out
}

func (h *Handler) codeNotReused(ctx context.Context, code string, hostel bson.ObjectID, provider string, resident bson.ObjectID) error {
	if code == "" || provider == "CASH" || provider == "OTHER" {
		return nil
	}
	events := h.DB.Collection("paymentevents")
	var dup priorClaim
	err := events.FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "provider", Value: provider}, {Key: "rawPayload.transactionCode", Value: code}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "REJECTED"}}}}).Decode(&dup)
	if err == nil {
		d := h.describePrior(ctx, &dup, resident)
		d.TransactionCode = code
		return finance.Err("TXN_ID_ALREADY_CLAIMED", "Transaction ID "+code+reusedCodeTail, d)
	}
	if err != mongo.ErrNoDocuments {
		return err
	}
	cur, err := events.Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "provider", Value: provider}, {Key: "rawPayload.transactionCode", Value: code}, {Key: "status", Value: "REJECTED"}}, options.Find().SetLimit(rejectedRetries+1))
	if err != nil {
		return err
	}
	var rejected []struct {
		Resident *bson.ObjectID `bson:"residentId"`
	}
	if err := cur.All(ctx, &rejected); err != nil {
		return err
	}
	details := ordered.Map{{Key: "transactionCode", Value: code}}
	for _, x := range rejected {
		if x.Resident == nil || *x.Resident != resident {
			return finance.Err("TXN_ID_ALREADY_CLAIMED", "Transaction ID "+code+reusedCodeTail, details)
		}
	}
	if len(rejected) >= rejectedRetries {
		return finance.Err("TXN_ID_ALREADY_CLAIMED", "This transaction ID has been submitted and turned down "+strconv.Itoa(len(rejected))+" times. Please speak to your hostel rather than submitting it again.", details)
	}
	return nil
}

func (h *Handler) similarFlags(ctx context.Context, a *evidenceAsset, hostel bson.ObjectID) ([]string, error) {
	if a.PHash == "" {
		return nil, nil
	}
	cur, err := h.DB.Collection("paymentevents").Find(ctx, bson.D{{Key: "evidenceAssetId", Value: bson.D{{Key: "$ne", Value: nil}}}, {Key: "hostelId", Value: hostel}, {Key: "source", Value: "RESIDENT_CLAIM"}},
		options.Find().SetSort(bson.D{{Key: "occurredAt", Value: -1}}).SetLimit(200))
	if err != nil {
		return nil, err
	}
	var prior []struct {
		Asset *bson.ObjectID `bson:"evidenceAssetId"`
	}
	if err := cur.All(ctx, &prior); err != nil {
		return nil, err
	}
	ids := bson.A{}
	for _, x := range prior {
		if x.Asset != nil {
			ids = append(ids, *x.Asset)
		}
	}
	if len(ids) == 0 {
		return nil, nil
	}
	cur, err = h.DB.Collection("fileassets").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}, {Key: "$ne", Value: a.ID}}}, {Key: "hostelId", Value: hostel}, {Key: "perceptualHash", Value: bson.D{{Key: "$exists", Value: true}, {Key: "$ne", Value: nil}}}})
	if err != nil {
		return nil, err
	}
	var others []struct {
		PHash string `bson:"perceptualHash"`
	}
	if err := cur.All(ctx, &others); err != nil {
		return nil, err
	}
	for _, o := range others {
		if o.PHash != "" && finance.HammingNear(a.PHash, o.PHash) {
			return []string{"SIMILAR_EVIDENCE"}, nil
		}
	}
	return nil, nil
}

func (h *Handler) payeeIdentity(ctx context.Context, hostel bson.ObjectID) finance.PayeeIdentity {
	var p finance.PayeeProfile
	err := h.DB.Collection("hostelpaymentprofiles").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}).Decode(&p)
	if err != nil && err != mongo.ErrNoDocuments {
		return finance.PayeeIdentity{AccountIDs: []string{}, Names: []string{}}
	}
	name, err := residents.HostelName(ctx, h.DB, hostel)
	if err != nil {
		return finance.PayeeIdentity{AccountIDs: []string{}, Names: []string{}}
	}
	return finance.HostelPayeeIdentity(&p, name)
}

func (h *Handler) readBytes(ctx context.Context, a *evidenceAsset) []byte {
	if h.R2 == nil {
		return nil
	}
	return h.R2.ReadStoredObject(ctx, a.Bucket, a.Key)
}

type evidenceOutcome struct {
	flags      []string
	notPayment bool
	refusal    string
	system     string
}

// evidenceFlags is evidenceFlags: what the file itself and its text say.
func (h *Handler) evidenceFlags(ctx context.Context, a *evidenceAsset, facts finance.ClaimFacts, id finance.PayeeIdentity, method string) evidenceOutcome {
	fileFlags := append(finance.ProvenanceFlags(a.Provenance), finance.TxnIDFlags(method, facts.TransactionCode)...)
	unchecked := evidenceOutcome{flags: append([]string{"EVIDENCE_NOT_MACHINE_CHECKED"}, fileFlags...)}
	if !a.readable() {
		return unchecked
	}
	if !h.Reader.Enabled() {
		return evidenceOutcome{flags: fileFlags}
	}
	text, failure := "", "unknown"
	if b := h.readBytes(ctx, a); b != nil {
		text, failure = h.Reader.Read(ctx, b, a.Mime)
	}
	if text == "" {
		slog.WarnContext(ctx, "[evidence-claim] no text for asset", "asset", a.ID.Hex(), "failure", failure)
		return unchecked
	}
	receipt := finance.ParseReceipt(text)
	direction := finance.ReadDirection(text)
	payee := finance.ReadPayee(text, id, receipt.Payee)
	flags := finance.EvidenceTextFlags(text, facts)
	if direction.Direction != "DEBIT" && payee.Verdict != "MATCHED" && receipt.Direction != "DEBIT" {
		flags = append(flags, "EVIDENCE_DIRECTION_UNVERIFIED")
	}
	if direction.Outcome == "PENDING" {
		flags = append(flags, "EVIDENCE_OUTCOME_PENDING")
	}
	if payee.Verdict == "MATCHED" {
		flags = append(flags, "EVIDENCE_PAYEE_VERIFIED")
	} else {
		flags = append(flags, "EVIDENCE_PAYEE_UNVERIFIED")
	}
	if receipt.Shape == "STATEMENT" || finance.LooksLikeStatement(text) {
		flags = append(flags, "EVIDENCE_IS_STATEMENT")
	}
	if m := finance.MethodForProvider(receipt.Provider); m != "" && m != method {
		flags = append(flags, "EVIDENCE_METHOD_MISMATCH")
	}
	refusal := finance.OutcomeRefusal(direction)
	if refusal == "" {
		refusal = finance.DirectionRefusal(direction)
	}
	if refusal == "" {
		refusal = finance.PayeeRefusal(payee)
	}
	return evidenceOutcome{append(flags, fileFlags...), finance.IsDefinitelyNotPayment(text), refusal, finance.SystemDocumentFromText(text)}
}

type claimInput struct {
	amount           int64
	notified         bool
	paidAt           *time.Time
	method, asset    string
	note, code       string
	hasNote, hasCode bool
}

func parseClaim(body any) (*claimInput, error) {
	f := valid.NewForm(body)
	in := &claimInput{}
	n, _ := f.Num("amount", valid.N{Int: true})
	if f.M != nil {
		if v, present := f.M["amount"].(float64); present && v == math.Trunc(v) && v <= 0 {
			f.Is.Add("amount", valid.TooSmall("number", 0, false))
		}
	}
	in.amount = int64(n)
	in.notified, _ = f.Bool("notifiedOnDevice", true, nil)
	if v, present := f.M["paidAt"]; present {
		t, ok := valid.CoerceDate(v)
		now := time.Now()
		switch {
		case !ok:
			f.Is.Add("paidAt", valid.Type("date", "Date"))
		case t.After(now.Add(paidAtFuture)):
			f.Is.Add("paidAt", "That payment date is in the future. Enter the date you actually paid.")
		case t.Before(now.Add(-paidAtMaxAge)):
			f.Is.Add("paidAt", "That payment date is more than a year ago. Please contact your hostel about this payment.")
		default:
			in.paidAt = &t
		}
	}
	in.method, _ = f.Enum("paymentMethod", false, nil, "CASH", "ESEWA", "KHALTI", "FONEPAY", "BANK_TRANSFER", "OTHER")
	in.asset, _ = f.Str("proofImageAssetId", valid.S{Trim: true, Min: 1})
	in.hasNote = f.Present("referenceNote")
	in.note, _ = f.Str("referenceNote", valid.S{Opt: true, Trim: true, Max: 500})
	in.hasCode = f.Present("transactionCode")
	in.code, _ = f.Str("transactionCode", valid.S{Opt: true, Trim: true, Max: 120})
	if err := f.Err(); err != nil {
		return nil, err
	}
	return in, nil
}

type claimResult struct {
	Created bool   `json:"created"`
	EventID string `json:"eventId"`
	Status  string `json:"status"`
}

func (h *Handler) claim(c *gin.Context) {
	if err := h.Limiter.Check(c, "resident-claim-submit", claimLimit, time.Hour); err != nil {
		httpx.Fail(c, err)
		return
	}
	p, r, err := h.current(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, err := parseClaim(body)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.submit(c, c.Param("id"), in, p, r)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if out.Created {
		httpx.Write(c, 201, out, "Payment proof submitted")
		return
	}
	httpx.OK(c, out, "This proof was already submitted")
}

func (h *Handler) submit(ctx context.Context, invoiceID string, in *claimInput, p *authz.Principal, r *residents.Record) (*claimResult, error) {
	id, bad := bson.ObjectIDFromHex(invoiceID)
	if bad != nil {
		id = bson.NewObjectID()
	}
	var inv struct {
		ID        bson.ObjectID `bson:"_id"`
		HostelID  bson.ObjectID `bson:"hostelId"`
		Period    *string       `bson:"period"`
		Reference *string       `bson:"referenceCode"`
		Status    string        `bson:"status"`
		Total     int64         `bson:"totalAmount"`
	}
	err := h.DB.Collection("invoices").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}}).Decode(&inv)
	if err == mongo.ErrNoDocuments {
		return nil, finance.Err("INVOICE_NOT_FOUND", "Invoice was not found.")
	}
	if err != nil {
		return nil, err
	}
	if inv.Status == "PAID" {
		return nil, finance.Err("INVOICE_ALREADY_PAID", "This invoice is already paid.")
	}
	if inv.Status == "VOID" {
		return nil, finance.Err("INVOICE_NOT_FOUND", "This invoice was cancelled.")
	}
	asset, err := h.usableAsset(ctx, in.asset, r, p)
	if err != nil {
		return nil, err
	}
	provider := in.method
	if provider == "BANK_TRANSFER" {
		provider = "BANK"
	}
	if in.code == "" {
		if finance.TransactionCodeRequired(in.method) {
			return nil, finance.Err("TXN_ID_REQUIRED", "Enter the transaction ID from your payment. It is on the confirmation screen of the app you paid with.")
		}
	} else if finance.TransactionCodeRequired(in.method) {
		if problem := finance.TransactionCodeProblem(in.code); problem != "" {
			return nil, finance.Err("TXN_ID_NOT_PLAUSIBLE", problem)
		}
	}
	if err := h.amountWithinBounds(ctx, in.amount, inv.ID, inv.Total); err != nil {
		return nil, err
	}
	if asset.Hash != "" {
		var dup priorClaim
		err := h.DB.Collection("paymentevents").FindOne(ctx, bson.D{{Key: "evidenceHash", Value: asset.Hash}, {Key: "hostelId", Value: inv.HostelID}}).Decode(&dup)
		if err == nil {
			return nil, finance.Err("EVIDENCE_ALREADY_USED", "This screenshot has already been submitted for a payment. If this is a different payment, upload the screenshot for that one.", h.describePrior(ctx, &dup, r.ID))
		}
		if err != mongo.ErrNoDocuments {
			return nil, err
		}
	}
	if err := h.codeNotReused(ctx, in.code, inv.HostelID, provider, r.ID); err != nil {
		return nil, err
	}
	reference := ""
	if inv.Reference != nil {
		reference = *inv.Reference
	}
	read := h.evidenceFlags(ctx, asset, finance.ClaimFacts{Amount: in.amount, ReferenceCode: reference, TransactionCode: in.code}, h.payeeIdentity(ctx, inv.HostelID), in.method)
	if read.system != "" {
		return nil, systemRefusal(read.system)
	}
	if read.notPayment {
		return nil, finance.Err("EVIDENCE_NOT_A_PAYMENT", "That file does not look like a payment at all — there is no app name, no amount and no transaction ID on it. Please upload the screenshot or receipt from the app you paid with.")
	}
	if read.refusal != "" {
		return nil, finance.Err("EVIDENCE_WRONG_TRANSACTION", read.refusal)
	}
	similar, err := h.similarFlags(ctx, asset, inv.HostelID)
	if err != nil {
		return nil, err
	}
	flags := append(append([]string{}, similar...), read.flags...)
	key := asset.Hash
	if key == "" {
		key = asset.ID.Hex()
	}
	occurred := time.Time{}
	if in.paidAt != nil {
		occurred = in.paidAt.UTC()
	}
	idem := "claim:" + r.ID.Hex() + ":" + inv.ID.Hex() + ":" + key
	var noteVal, codeVal any
	if in.hasNote {
		noteVal = in.note
	}
	if in.hasCode {
		codeVal = in.code
	}
	refVal := ""
	if inv.Reference != nil {
		refVal = *inv.Reference
	}
	residentID, invID, assetID := r.ID, inv.ID, asset.ID
	ev, created, err := (&ledger.Engine{DB: h.DB}).AppendEvent(ctx, ledger.AppendInput{Amount: int64(in.amount), HostelID: inv.HostelID, InvoiceID: &invID, ResidentID: &residentID, Source: "RESIDENT_CLAIM", Provider: provider, ReferenceCode: refVal, IdempotencyKey: idem, EvidenceAsset: &assetID, EvidenceHash: asset.Hash, OccurredAt: occurred,
		RawPayload: bson.D{{Key: "referenceNote", Value: noteVal}, {Key: "submittedBy", Value: p.UserID}, {Key: "transactionCode", Value: codeVal}}, ReviewFlags: flags})
	if err != nil {
		return nil, err
	}
	if !created {
		return &claimResult{false, ev.ID.Hex(), ev.Status}, nil
	}
	event := ev.ID
	me, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		return nil, err
	}
	if err := h.Audit.WriteFinance(ctx, me, string(p.Role), audit.Finance{Action: "PAYMENT_CLAIM_SUBMITTED", EntityID: event.Hex(), EntityType: "PaymentEvent", EventID: event.Hex(), HostelID: inv.HostelID, InvoiceID: inv.ID.Hex(), Source: "RESIDENT_CLAIM"}); err != nil {
		return nil, err
	}
	forPeriod := ""
	if inv.Period != nil && *inv.Period != "" {
		forPeriod = " for " + *inv.Period
	}
	amount := money.GroupUS(in.amount)
	if admins, err := residents.HostelStaffUserIDs(ctx, h.DB, inv.HostelID, true); err == nil {
		for _, admin := range admins {
			_, _ = h.Notify.CreateInApp(ctx, notifications.Input{Actions: []notifications.Action{{Endpoint: "/api/v1/hostel-admin/finance/events/" + event.Hex() + "/approve", Key: "approve", Label: "Verify payment", Method: "POST"}}, ActionURL: "/hostel-admin/payments",
				Body: strings.TrimSpace(r.FirstName+" "+r.LastName) + " submitted proof of NPR " + amount + forPeriod + ".", Category: "PAYMENT", Data: ordered.Map{{Key: "eventId", Value: event.Hex()}}, HostelID: inv.HostelID.Hex(), Title: "Payment proof submitted", UserID: admin})
		}
	}
	_, _ = h.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/resident/payments", Body: "Your proof of NPR " + amount + forPeriod + " was sent to your hostel to check. Nothing is credited until they verify it.", Category: "PAYMENT",
		Data: ordered.Map{{Key: "invoiceId", Value: inv.ID.Hex()}}, HostelID: inv.HostelID.Hex(), Kind: "NORMAL", NoPush: in.notified, Title: "Payment proof sent", UserID: p.UserID})
	realtime.PublishResourceChange(ctx, h.RT, h.Bump, realtime.Change{HostelIDs: []string{inv.HostelID.Hex()}, Topics: []realtime.Topic{realtime.Payments}, UserIDs: []string{p.UserID}})
	return &claimResult{true, event.Hex(), "PENDING"}, nil
}

func (h *Handler) amountWithinBounds(ctx context.Context, amount int64, invoice bson.ObjectID, total int64) error {
	if amount <= 0 {
		return finance.Err("AMOUNT_OUT_OF_BOUNDS", "Enter the amount you actually paid.")
	}
	var balance struct {
		Settled int64 `bson:"settledAmount"`
	}
	if err := h.DB.Collection("invoicebalances").FindOne(ctx, bson.D{{Key: "invoiceId", Value: invoice}}).Decode(&balance); err != nil && err != mongo.ErrNoDocuments {
		return err
	}
	outstanding := max(0, total-balance.Settled)
	base := total
	if outstanding > 0 {
		base = outstanding
	}
	if float64(amount) > math.Floor(float64(base)*1.5+0.5) {
		if outstanding > 0 {
			return finance.Err("AMOUNT_OUT_OF_BOUNDS", "That is much more than the "+strconv.FormatInt(outstanding, 10)+" still owed on this invoice. Check the amount and try again.")
		}
		return finance.Err("AMOUNT_OUT_OF_BOUNDS", "That is much more than this invoice was for. Check the amount and try again.")
	}
	return nil
}

// --- evidence read ------------------------------------------------------------------

func emptyStage(reason any) ordered.Map {
	return ordered.Map{{Key: "fields", Value: ordered.Map{}}, {Key: "looksLikeReceipt", Value: true}, {Key: "notPayment", Value: false}, {Key: "reason", Value: reason}, {Key: "reference", Value: nil}, {Key: "refusal", Value: nil},
		{Key: "statementGuidance", Value: nil}, {Key: "stage", Value: "done"}, {Key: "systemDocument", Value: false}, {Key: "text", Value: false}}
}

func orNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// readDone is the final "done" line of a successful read.
func readDone(text, reference string, id finance.PayeeIdentity) ordered.Map {
	ours := finance.SystemDocumentFromText(text) != ""
	direction := finance.ReadDirection(text)
	receipt := finance.ParseReceipt(text)
	payee := finance.ReadPayee(text, id, receipt.Payee)
	scanned := finance.ExtractClaimFields(text)
	fields := ordered.Map{}
	if scanned.Amount != nil {
		fields = fields.Set("amount", *scanned.Amount)
	}
	if scanned.TransactionCode != "" {
		fields = fields.Set("transactionCode", scanned.TransactionCode)
	}
	if scanned.ReferenceCode != "" {
		fields = fields.Set("referenceCode", scanned.ReferenceCode)
	}
	if scanned.Method != "" {
		fields = fields.Set("method", scanned.Method)
	}
	if m := finance.MethodForProvider(receipt.Provider); m != "" {
		fields = fields.Set("method", m)
	}
	if scanned.Amount == nil && receipt.Amount != nil {
		fields = fields.Set("amount", *receipt.Amount)
	}
	if scanned.TransactionCode == "" && receipt.TxnID != "" && finance.TransactionCodeProblem(receipt.TxnID) == "" {
		fields = fields.Set("transactionCode", receipt.TxnID)
	}
	var bank, onImage, refusal, guidance any
	if key, name := finance.ReceiptBank(text); key != "" {
		bank = ordered.Map{{Key: "key", Value: key}, {Key: "name", Value: name}}
	}
	if !ours {
		if reference != "" {
			onImage = ordered.Map{{Key: "code", Value: reference}, {Key: "found", Value: finance.ReferenceOnEvidence(text, reference)}}
		}
		why := finance.OutcomeRefusal(direction)
		if why == "" {
			why = finance.DirectionRefusal(direction)
		}
		if why == "" {
			why = finance.PayeeRefusal(payee)
		}
		refusal = orNil(why)
		if finance.LooksLikeStatement(text) {
			guidance = finance.StatementGuidance
		}
	}
	return ordered.Map{{Key: "bank", Value: bank}, {Key: "fields", Value: fields}, {Key: "looksLikeReceipt", Value: finance.LooksLikePaymentReceipt(text)}, {Key: "reason", Value: nil}, {Key: "notPayment", Value: finance.IsDefinitelyNotPayment(text)},
		{Key: "reference", Value: onImage}, {Key: "refusal", Value: refusal}, {Key: "statementGuidance", Value: guidance}, {Key: "stage", Value: "done"}, {Key: "systemDocument", Value: ours}, {Key: "text", Value: true}}
}

func (h *Handler) evidenceRead(c *gin.Context) {
	_, r, err := h.current(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	p, _ := h.Guards.Require(c)
	notFound := httpx.NewError(404, "NOT_FOUND", "File not found", nil)
	var a evidenceAsset
	id, bad := bson.ObjectIDFromHex(c.Param("assetId"))
	if bad != nil {
		httpx.Fail(c, notFound)
		return
	}
	err = h.DB.Collection("fileassets").FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}}).Decode(&a)
	if err != nil && err != mongo.ErrNoDocuments {
		httpx.Fail(c, err)
		return
	}
	if err != nil || a.OwnerID == nil || a.OwnerID.Hex() != p.UserID || (a.HostelID != nil && *a.HostelID != r.HostelID) {
		httpx.Fail(c, notFound)
		return
	}
	if a.Completed == nil {
		httpx.Fail(c, httpx.NewError(422, "ASSET_UPLOAD_INCOMPLETE", "This file did not finish uploading.", nil))
		return
	}
	reference := ""
	if inv, bad := bson.ObjectIDFromHex(c.Query("invoiceId")); bad == nil {
		var row struct {
			Reference *string `bson:"referenceCode"`
		}
		if h.DB.Collection("invoices").FindOne(c, bson.D{{Key: "_id", Value: inv}, {Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}}).Decode(&row) == nil && row.Reference != nil {
			reference = *row.Reference
		}
	}
	identity := h.payeeIdentity(c, r.HostelID)
	asJSON := c.Query("format") == "json"
	if !asJSON {
		c.Header("Cache-Control", "no-store")
		c.Header("Content-Type", "application/x-ndjson; charset=utf-8")
		c.Header("X-Accel-Buffering", "no")
		c.Status(200)
	}
	send := func(line ordered.Map) {
		if asJSON {
			return
		}
		b, err := json.Marshal(line)
		if err != nil {
			return
		}
		_, _ = c.Writer.Write(append(b, '\n'))
		c.Writer.Flush()
	}
	finish := func(line ordered.Map) {
		if asJSON {
			httpx.OK(c, line, "Receipt read")
			return
		}
		send(line)
	}
	stage := func(name string) ordered.Map { return ordered.Map{{Key: "stage", Value: name}} }
	switch {
	case !h.Reader.Enabled():
		finish(emptyStage("disabled"))
		return
	case !a.readable():
		finish(emptyStage("not-measured"))
		return
	}
	send(stage("decoding"))
	b := h.readBytes(c, &a)
	if b == nil {
		finish(emptyStage("fetch-failed"))
		return
	}
	send(stage("reading"))
	text, failure := h.Reader.Read(c, b, a.Mime)
	if text == "" {
		slog.WarnContext(c, "[evidence-read] no text for asset", "asset", a.ID.Hex(), "failure", failure)
		finish(emptyStage(failure))
		return
	}
	send(stage("matching"))
	finish(readDone(text, reference, identity))
}
