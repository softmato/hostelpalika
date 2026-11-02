// Package financeadmin is /hostel-admin/finance: the staff side of money. Every write
// of a payment, receipt, balance or credit goes through modules/ledger.
package financeadmin

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/ledger"
	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/modules/referrals"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Handler is the routes under /hostel-admin/finance.
type Handler struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Ledger *ledger.Engine
	Audit  *audit.Log
	Cache  *cache.Cache
	RT     *realtime.Client
}

// Register mounts the claim review, cash and void routes; the other groups add theirs.
func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.GET("/hostel-admin/finance/events", httpx.ETag(), h.listEvents)
	v1.POST("/hostel-admin/finance/events/bulk-approve", h.bulkApprove)
	v1.POST("/hostel-admin/finance/events/:id/approve", h.approve)
	v1.POST("/hostel-admin/finance/events/:id/reject", h.reject)
	v1.POST("/hostel-admin/finance/events/:id/reverse", h.reverse)
	v1.POST("/hostel-admin/finance/invoices/:id/cash", h.cash)
	v1.POST("/hostel-admin/finance/invoices/:id/void", h.voidInvoice)
	v1.GET("/hostel-admin/finance/receipts/:id/pdf", h.receiptPDF)
	h.registerRules(v1)
	h.registerConcessions(v1)
	h.registerFeeSchedules(v1)
	h.registerInvoices(v1)
	h.registerBillingRuns(v1)
}

func scopeOf(p *authz.Principal) bson.A {
	out := bson.A{}
	for _, id := range opsscope.IDs(p) {
		out = append(out, id)
	}
	return out
}

func requestedHostel(q map[string]string) string { return q["hostelId"] }

func (h *Handler) listEvents(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "viewPayments")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	status := valid.QueryEnum(q, "status", &is, "PENDING", "SETTLED", "REJECTED")
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, requestedHostel(q))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	want := "PENDING"
	if status != nil {
		want = *status
	}
	rows, err := finance.ListStaffQueue(c, h.DB, hostel, want)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if rows == nil {
		rows = []finance.ReviewRow{}
	}
	httpx.OK(c, struct {
		Events []finance.ReviewRow `json:"events"`
	}{rows}, "Payment claims")
}

// claim is a reviewable event, scoped to the caller's hostels.
type claim struct {
	ID         bson.ObjectID  `bson:"_id"`
	HostelID   bson.ObjectID  `bson:"hostelId"`
	InvoiceID  *bson.ObjectID `bson:"invoiceId"`
	ResidentID *bson.ObjectID `bson:"residentId"`
	Provider   string         `bson:"provider"`
	Source     string         `bson:"source"`
	Status     string         `bson:"status"`
	Raw        struct {
		RecordedBy *string `bson:"recordedBy"`
	} `bson:"rawPayload"`
}

var errClaimMissing = finance.Err("CLAIM_NOT_FOUND", "Payment claim was not found.")
var errClaimReviewed = finance.Err("CLAIM_ALREADY_REVIEWED", "This claim has already been reviewed.")

func (h *Handler) findClaim(ctx context.Context, raw string, p *authz.Principal) (*claim, error) {
	id, err := bson.ObjectIDFromHex(raw)
	if err != nil {
		return nil, errClaimMissing // out of scope and malformed answer alike
	}
	out := &claim{}
	err = h.DB.Collection("paymentevents").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: bson.D{{Key: "$in", Value: scopeOf(p)}}},
		{Key: "source", Value: bson.D{{Key: "$in", Value: bson.A{"RESIDENT_CLAIM", "CASH_ENTRY"}}}}}).Decode(out)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, errClaimMissing
	}
	return out, err
}

type approved struct {
	EventID       string  `json:"eventId"`
	ReceiptNumber *string `json:"receiptNumber"`
	SettledAmount int64   `json:"settledAmount"`
}

// approveClaim is approveClaim, and the second half of maker-checker for cash above
// the hostel's threshold. TS built that half (approveCashPayment) and no route called
// it, so such cash stayed PENDING for ever with nobody able to confirm it (FIN-2).
func (h *Handler) approveClaim(ctx context.Context, raw string, p *authz.Principal) (*approved, error) {
	cl, err := h.findClaim(ctx, raw, p)
	if err != nil {
		return nil, err
	}
	if cl.Status != "PENDING" {
		return nil, errClaimReviewed
	}
	if cl.Source == "CASH_ENTRY" {
		if cl.Raw.RecordedBy != nil && *cl.Raw.RecordedBy == p.UserID {
			return nil, finance.Err("SECOND_APPROVER_REQUIRED", "Cash above the approval threshold must be confirmed by someone else.")
		}
	} else {
		// Two screens, one transfer: the statement row may already have credited it.
		n, err := h.DB.Collection("paymentevents").CountDocuments(ctx, bson.D{{Key: "hostelId", Value: cl.HostelID}, {Key: "rawPayload.claimEventId", Value: cl.ID.Hex()}, {Key: "source", Value: "STATEMENT_IMPORT"}, {Key: "status", Value: "SETTLED"}})
		if err != nil {
			return nil, err
		}
		if n > 0 {
			return nil, finance.Err("CLAIM_ALREADY_REVIEWED", "This payment was already recorded from your account statement, so it is credited. Approving it again would count the same transfer twice.")
		}
	}
	s, err := h.Ledger.SettleEvent(ctx, cl.ID, ledger.SettleOptions{Confirmation: "MANUAL_REVIEW", Principal: p})
	if errors.Is(err, ledger.ErrNotPending) {
		return nil, errClaimReviewed // lost a race with another reviewer: the same answer as arriving later
	}
	if err != nil {
		return nil, err
	}
	out := &approved{EventID: cl.ID.Hex(), SettledAmount: s.Event.Amount}
	if s.Balance != nil {
		out.SettledAmount = s.Balance.SettledAmount
	}
	if s.Receipt != nil {
		out.ReceiptNumber = &s.Receipt.ReceiptNumber
	}
	if cl.Source == "CASH_ENTRY" { // settling told the resident already
		realtime.PublishResourceChange(ctx, h.RT, h.Cache, realtime.Change{HostelIDs: []string{cl.HostelID.Hex()}, Topics: []realtime.Topic{realtime.Payments}})
		return out, nil
	}
	if ev := s.Event; ev.ResidentID != nil {
		paymentID := cl.ID
		if cl.InvoiceID != nil {
			paymentID = *cl.InvoiceID
		}
		referrals.MarkConverted(ctx, h.DB, cl.HostelID, *ev.ResidentID, paymentID)
		var remaining int64
		if s.Balance != nil {
			remaining = max(s.Balance.TotalAmount-s.Balance.SettledAmount, 0)
		}
		h.Ledger.NotifyClaimReviewed(ctx, ledger.ClaimReview{HostelID: cl.HostelID, InvoiceID: cl.InvoiceID, Kind: "verified", Period: h.Ledger.PeriodOf(ctx, cl.InvoiceID), Receipt: s.Receipt, Remaining: remaining, ResidentID: *ev.ResidentID, Verified: ev.Amount})
	}
	realtime.PublishResourceChange(ctx, h.RT, h.Cache, realtime.Change{HostelIDs: []string{cl.HostelID.Hex()}, Topics: []realtime.Topic{realtime.Payments}})
	return out, nil
}

func (h *Handler) approve(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "approvePayments")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.approveClaim(c, c.Param("id"), p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Payment verified")
}

func (h *Handler) reject(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "approvePayments")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	f.Str("hostelId", valid.S{Opt: true})
	reason, _ := f.Str("rejectionReason", valid.S{Trim: true, Min: 3, Max: 500})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	cl, err := h.findClaim(c, c.Param("id"), p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	me, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	at := nowMS()
	res, err := h.DB.Collection("paymentevents").UpdateOne(c, bson.D{{Key: "_id", Value: cl.ID}, {Key: "status", Value: "PENDING"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "rejectionReason", Value: reason}, {Key: "reviewedAt", Value: at}, {Key: "reviewedBy", Value: me}, {Key: "status", Value: "REJECTED"}, {Key: "updatedAt", Value: at}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if res.MatchedCount == 0 {
		httpx.Fail(c, errClaimReviewed)
		return
	}
	f2 := audit.Finance{Action: "PAYMENT_CLAIM_REJECTED", EntityID: cl.ID.Hex(), EntityType: "PaymentEvent", EventID: cl.ID.Hex(), HostelID: cl.HostelID, Reason: reason, Source: "CLAIM_REVIEW"}
	if cl.InvoiceID != nil {
		f2.InvoiceID = cl.InvoiceID.Hex()
	}
	if err := h.Audit.WriteFinance(c, me, string(p.Role), f2); err != nil {
		httpx.Fail(c, err)
		return
	}
	if cl.ResidentID != nil {
		h.Ledger.NotifyClaimReviewed(c, ledger.ClaimReview{HostelID: cl.HostelID, InvoiceID: cl.InvoiceID, Kind: "rejected", Period: h.Ledger.PeriodOf(c, cl.InvoiceID), RejectionReason: reason, ResidentID: *cl.ResidentID})
	}
	realtime.PublishResourceChange(c, h.RT, h.Cache, realtime.Change{HostelIDs: []string{cl.HostelID.Hex()}, Topics: []realtime.Topic{realtime.Payments}})
	httpx.OK(c, struct {
		EventID string `json:"eventId"`
		Status  string `json:"status"`
	}{cl.ID.Hex(), "REJECTED"}, "Payment proof rejected")
}

type skippedRow struct {
	EventID string `json:"eventId"`
	Reason  string `json:"reason"`
}

// bulkApprove is bulkApproveClaims: sweeps only rows still all green, re-derived here,
// and says what stopped every row it left behind.
func (h *Handler) bulkApprove(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "approvePayments")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	items, ok := f.Array("eventIds", false, false)
	ids := make([]string, 0, len(items))
	if ok {
		f.Size("eventIds", len(items), 1, 100, "", false)
		for i, v := range items {
			s, isStr := v.(string)
			if !isStr {
				f.Is.Add("eventIds."+strconv.Itoa(i), valid.Type("string", valid.Received(v, false)))
				continue
			}
			ids = append(ids, s)
		}
	}
	requested, _ := f.Str("hostelId", valid.S{Opt: true})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, requested)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	queue, err := finance.ListReviewQueue(c, h.DB, hostel, "PENDING")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	byID := make(map[string]*finance.ReviewRow, len(queue))
	for i := range queue {
		byID[queue[i].EventID] = &queue[i]
	}
	approvedIDs, skipped := []string{}, []skippedRow{}
	for _, id := range ids {
		row := byID[id]
		if row == nil {
			skipped = append(skipped, skippedRow{id, "No longer awaiting review."})
			continue
		}
		reason := ""
		for _, check := range row.Checks {
			if !check.OK {
				reason = check.Detail
				break
			}
		}
		if reason != "" {
			skipped = append(skipped, skippedRow{id, reason})
			continue
		}
		if _, err := h.approveClaim(c, id, p); err != nil {
			var he *httpx.Error
			if errors.As(err, &he) {
				skipped = append(skipped, skippedRow{id, he.Message})
			} else {
				skipped = append(skipped, skippedRow{id, "Could not approve."})
			}
			continue
		}
		approvedIDs = append(approvedIDs, id)
	}
	httpx.OK(c, struct {
		Approved []string     `json:"approved"`
		Skipped  []skippedRow `json:"skipped"`
	}{approvedIDs, skipped}, bulkMessage(len(approvedIDs), len(skipped)))
}

func (h *Handler) reverse(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "reversePayments")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	reason, _ := f.Str("reason", valid.S{Trim: true, Min: 3, Max: 500})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		httpx.Fail(c, finance.Err("EVENT_NOT_FOUND", "Payment event was not found."))
		return
	}
	balance, reversal, err := h.Ledger.ReverseEvent(c, id, p, reason)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, struct {
		Balance    any    `json:"balance"`
		ReversalID string `json:"reversalId"`
	}{balanceOut(balance), reversal.Hex()}, "Payment reversed")
}

func balanceOut(b *ledger.Balance) any {
	if b == nil {
		return nil
	}
	return ordered.Map{{Key: "invoiceId", Value: b.InvoiceID.Hex()}, {Key: "outstanding", Value: b.Outstanding}, {Key: "settledAmount", Value: b.SettledAmount}, {Key: "status", Value: b.Status}, {Key: "totalAmount", Value: b.TotalAmount}}
}

const defaultCashApprovalThreshold = 20000

// cash is recordCashPayment. Scoped to the caller's hostels (FIN-1).
func (h *Handler) cash(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "recordCash")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	amount, _ := f.Num("amount", valid.N{Int: true, Min: valid.P(1)})
	slip, _ := f.Str("cashReceiptNumber", valid.S{Trim: true, Min: 1, Max: 64})
	collector, _ := f.Str("collectedBy", valid.S{Trim: true, Min: 2, Max: 120})
	method, _ := f.Enum("method", true, nil, "CASH", "ESEWA", "KHALTI", "BANK")
	note, hasNote := f.Str("note", valid.S{Opt: true, Trim: true, Max: 500})
	received := nowMS()
	if f.Present("receivedAt") {
		if t, ok := valid.CoerceDate(f.M["receivedAt"]); ok {
			received = t.UTC()
		} else {
			f.Is.Add("receivedAt", valid.Type("date", "Date"))
		}
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	missing := finance.Err("INVOICE_NOT_FOUND", "Invoice was not found.")
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		httpx.Fail(c, missing)
		return
	}
	var inv struct {
		ID         bson.ObjectID `bson:"_id"`
		HostelID   bson.ObjectID `bson:"hostelId"`
		ResidentID bson.ObjectID `bson:"residentId"`
		Status     string        `bson:"status"`
	}
	err = h.DB.Collection("invoices").FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: bson.D{{Key: "$in", Value: scopeOf(p)}}}}).Decode(&inv)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, missing)
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if inv.Status == "VOID" {
		httpx.Fail(c, finance.Err("AMOUNT_OUT_OF_BOUNDS", "This invoice was voided and cannot take a payment."))
		return
	}
	threshold, err := h.cashThreshold(c, inv.HostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	provider := "CASH"
	if method != "" {
		provider = method
	}
	var noteVal any
	if hasNote {
		noteVal = note
	}
	event, created, err := h.Ledger.AppendEvent(c, ledger.AppendInput{Amount: int64(amount), Confirmation: "MANUAL_REVIEW", HostelID: inv.HostelID,
		IdempotencyKey: "cash:" + inv.HostelID.Hex() + ":" + slip, InvoiceID: &inv.ID, OccurredAt: received, Provider: provider,
		RawPayload: bson.D{{Key: "cashReceiptNumber", Value: slip}, {Key: "collectedBy", Value: collector}, {Key: "note", Value: noteVal}, {Key: "recordedBy", Value: p.UserID}},
		ResidentID: &inv.ResidentID, Source: "CASH_ENTRY", Status: "PENDING"})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	reply := func(status int, b *ledger.Balance, pending bool, r *ledger.Receipt) {
		msg := "Cash recorded"
		if pending {
			msg = "Cash recorded — a second approver is required"
		}
		httpx.Write(c, status, ordered.Map{{Key: "balance", Value: balanceOut(b)}, {Key: "eventId", Value: event.ID.Hex()}, {Key: "pendingApproval", Value: pending}, {Key: "receipt", Value: receiptOut(r)}}, msg)
	}
	if !created {
		// The same slip again: what exists, never a second credit.
		pending := event.Status == "PENDING"
		status := http.StatusCreated
		if pending {
			status = http.StatusOK
		}
		reply(status, nil, pending, nil)
		return
	}
	if int64(amount) > threshold {
		reply(http.StatusOK, nil, true, nil)
		return
	}
	s, err := h.Ledger.SettleEvent(c, event.ID, ledger.SettleOptions{Confirmation: "MANUAL_REVIEW", Principal: p})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	reply(http.StatusCreated, s.Balance, false, s.Receipt)
}

func (h *Handler) cashThreshold(ctx context.Context, hostel bson.ObjectID) (int64, error) {
	var row struct {
		Threshold *int64 `bson:"cashApprovalThreshold"`
	}
	err := h.DB.Collection("hostelpaymentprofiles").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}).Decode(&row)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return 0, err
	}
	if row.Threshold != nil {
		return *row.Threshold, nil
	}
	return defaultCashApprovalThreshold, nil
}

func receiptOut(r *ledger.Receipt) any {
	if r == nil {
		return nil
	}
	return ordered.Map{{Key: "_id", Value: r.ID.Hex()}, {Key: "hostelId", Value: r.HostelID.Hex()}, {Key: "residentId", Value: r.ResidentID.Hex()}, {Key: "eventId", Value: hexOrNil(r.EventID)}, {Key: "invoiceId", Value: hexOrNil(r.InvoiceID)},
		{Key: "receiptNumber", Value: r.ReceiptNumber}, {Key: "issuedAt", Value: httpx.ISO(r.IssuedAt)}, {Key: "amount", Value: r.Amount}, {Key: "certificationCode", Value: r.CertificationCode}}
}

func hexOrNil(id *bson.ObjectID) any {
	if id == nil {
		return nil
	}
	return id.Hex()
}

// voidInvoice is voidInvoice, with the status, the released khata lines and nothing
// half done in one transaction. A paid invoice must have its payments reversed first.
func (h *Handler) voidInvoice(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "reversePayments")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	reason, _ := f.Str("reason", valid.S{Trim: true, Min: 3, Max: 500})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.Ledger.VoidInvoice(c, c.Param("id"), p, reason)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Invoice voided")
}

func (h *Handler) receiptPDF(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "viewPayments")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		httpx.Fail(c, finance.Err("RECEIPT_NOT_FOUND", "Receipt was not found."))
		return
	}
	b, number, err := finance.RenderReceiptForHostels(c, h.DB, id, scopeOf(p))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	c.Header("Content-Disposition", `attachment; filename="`+strings.ReplaceAll(number, `"`, "")+`.pdf"`)
	c.Header("Cache-Control", "private, no-store")
	c.Data(http.StatusOK, "application/pdf", b)
}

func bulkMessage(approved, skipped int) string {
	msg := "Approved " + strconv.Itoa(approved) + " claim(s)"
	if skipped > 0 {
		msg += ", " + strconv.Itoa(skipped) + " left for review"
	}
	return msg
}

func nowMS() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }
