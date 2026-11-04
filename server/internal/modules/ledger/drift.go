package ledger

import (
	"context"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/recon"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

const (
	driftBatch           = 200
	auditChainWindow     = 500
	defaultCadenceDays   = 7
	driftStaleEventLimit = 200
)

// RunLedgerDrift is runLedgerDrift (the ledger-drift job): every live hostel's
// ledger is checked read-only, one reconciliation run each. A hostel whose run
// fails is reported FAIL and the rest carry on.
func RunLedgerDrift(ctx context.Context, db *mongo.Database, now time.Time, triggeredBy string) ([]ordered.Map, error) {
	cur, err := db.Collection("hostels").Find(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}, options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var hostels []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := cur.All(ctx, &hostels); err != nil {
		return nil, err
	}
	out := make([]ordered.Map, 0, len(hostels))
	for _, h := range hostels {
		if ctx.Err() != nil {
			return out, ctx.Err()
		}
		scanned := 0
		id := h.ID
		run, rec, err := recon.WithRun(ctx, db, &id, "LEDGER_DRIFT", triggeredBy, func(rec *recon.Recorder) error {
			var err error
			if scanned, err = checkInvoices(ctx, db, id, rec, now); err != nil {
				return err
			}
			for _, check := range []func(context.Context, *mongo.Database, bson.ObjectID, *recon.Recorder, time.Time) error{
				checkReceipts, checkExpiredEvents, checkCreditBalances, checkUnconfirmedClaims, checkAuditChain} {
				if err := check(ctx, db, id, rec, now); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			out = append(out, ordered.Map{{Key: "findings", Value: 0}, {Key: "hostelId", Value: id.Hex()}, {Key: "runId", Value: ""}, {Key: "scanned", Value: 0}, {Key: "status", Value: "FAIL"}})
			continue
		}
		out = append(out, ordered.Map{{Key: "findings", Value: len(rec.Findings)}, {Key: "hostelId", Value: id.Hex()}, {Key: "runId", Value: run.ID.Hex()}, {Key: "scanned", Value: scanned}, {Key: "status", Value: run.Status}})
	}
	return out, nil
}

func num(n int64) string { return strconv.FormatInt(n, 10) }

func ref(id bson.ObjectID) *bson.ObjectID { return &id }

func checkInvoices(ctx context.Context, db *mongo.Database, hostel bson.ObjectID, rec *recon.Recorder, now time.Time) (int, error) {
	var cursor *bson.ObjectID
	scanned := 0
	for {
		f := bson.D{{Key: "hostelId", Value: hostel}}
		if cursor != nil {
			f = append(f, bson.E{Key: "_id", Value: bson.D{{Key: "$gt", Value: *cursor}}})
		}
		cur, err := db.Collection("invoices").Find(ctx, f, options.Find().SetSort(bson.D{{Key: "_id", Value: 1}}).SetLimit(driftBatch).
			SetProjection(bson.D{{Key: "dueDate", Value: 1}, {Key: "period", Value: 1}, {Key: "status", Value: 1}, {Key: "totalAmount", Value: 1}}))
		if err != nil {
			return scanned, err
		}
		var invoices []struct {
			ID          bson.ObjectID `bson:"_id"`
			DueDate     *time.Time    `bson:"dueDate"`
			Status      string        `bson:"status"`
			TotalAmount int64         `bson:"totalAmount"`
		}
		if err := cur.All(ctx, &invoices); err != nil {
			return scanned, err
		}
		if len(invoices) == 0 {
			break
		}
		cursor = &invoices[len(invoices)-1].ID
		scanned += len(invoices)
		ids := make(bson.A, len(invoices))
		for i, inv := range invoices {
			ids[i] = inv.ID
		}
		in := bson.D{{Key: "$in", Value: ids}}
		ec, err := db.Collection("paymentevents").Find(ctx, bson.D{{Key: "invoiceId", Value: in}, {Key: "status", Value: "SETTLED"}},
			options.Find().SetProjection(bson.D{{Key: "amount", Value: 1}, {Key: "direction", Value: 1}, {Key: "invoiceId", Value: 1}, {Key: "residentId", Value: 1}}))
		if err != nil {
			return scanned, err
		}
		var events []struct {
			ID         bson.ObjectID  `bson:"_id"`
			Amount     int64          `bson:"amount"`
			Direction  string         `bson:"direction"`
			InvoiceID  bson.ObjectID  `bson:"invoiceId"`
			ResidentID *bson.ObjectID `bson:"residentId"`
		}
		if err := ec.All(ctx, &events); err != nil {
			return scanned, err
		}
		bc, err := db.Collection("invoicebalances").Find(ctx, bson.D{{Key: "invoiceId", Value: in}}, options.Find().SetProjection(bson.D{{Key: "invoiceId", Value: 1}, {Key: "settledAmount", Value: 1}}))
		if err != nil {
			return scanned, err
		}
		var balances []struct {
			InvoiceID     bson.ObjectID `bson:"invoiceId"`
			SettledAmount int64         `bson:"settledAmount"`
		}
		if err := bc.All(ctx, &balances); err != nil {
			return scanned, err
		}
		rc, err := db.Collection("receipts").Find(ctx, bson.D{{Key: "invoiceId", Value: in}, {Key: "voidedAt", Value: nil}}, options.Find().SetProjection(bson.D{{Key: "eventId", Value: 1}}))
		if err != nil {
			return scanned, err
		}
		var receipts []struct {
			EventID *bson.ObjectID `bson:"eventId"`
		}
		if err := rc.All(ctx, &receipts); err != nil {
			return scanned, err
		}
		computed := map[bson.ObjectID]int64{}
		for _, e := range events {
			if e.Direction == "DEBIT" {
				computed[e.InvoiceID] -= e.Amount
			} else {
				computed[e.InvoiceID] += e.Amount
			}
		}
		stored := map[bson.ObjectID]int64{}
		for _, b := range balances {
			stored[b.InvoiceID] = b.SettledAmount
		}
		receipted := map[bson.ObjectID]bool{}
		for _, r := range receipts {
			if r.EventID != nil {
				receipted[*r.EventID] = true
			}
		}
		for _, inv := range invoices {
			settled := computed[inv.ID]
			have, ok := stored[inv.ID]
			if (!ok && settled != 0) || (ok && have != settled) {
				shown := "none"
				if ok {
					shown = num(have)
				}
				rec.Finding(recon.Finding{Code: "LEDGER_DRIFT", Detail: "stored " + shown + ", events sum to " + num(settled), EntityID: ref(inv.ID), EntityType: "Invoice", Severity: "ERROR"})
			}
			if want := DeriveInvoiceStatus(inv.Status, inv.DueDate, now, settled, inv.TotalAmount); want != inv.Status {
				rec.Finding(recon.Finding{Code: "STATUS_DRIFT", Detail: "stored " + inv.Status + ", balance implies " + want, EntityID: ref(inv.ID), EntityType: "Invoice", Severity: "WARN"})
			}
			if inv.Status == "PAID" && settled < inv.TotalAmount {
				rec.Finding(recon.Finding{Code: "PAID_SHORTFALL", Detail: "marked PAID but events sum to " + num(settled) + " of " + num(inv.TotalAmount), EntityID: ref(inv.ID), EntityType: "Invoice", Severity: "ERROR"})
			}
		}
		for _, e := range events {
			if e.Direction == "CREDIT" && e.ResidentID != nil && !receipted[e.ID] {
				rec.Finding(recon.Finding{Code: "RECEIPT_MISSING", Detail: "settled " + num(e.Amount) + " with no live receipt", EntityID: ref(e.ID), EntityType: "PaymentEvent", Severity: "WARN"})
			}
		}
		rec.Count("scanned", int64(len(invoices)))
		if len(invoices) < driftBatch {
			break
		}
	}
	return scanned, nil
}

func checkReceipts(ctx context.Context, db *mongo.Database, hostel bson.ObjectID, rec *recon.Recorder, _ time.Time) error {
	cur, err := db.Collection("receipts").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "voidedAt", Value: nil}},
		options.Find().SetProjection(bson.D{{Key: "amount", Value: 1}, {Key: "eventId", Value: 1}, {Key: "receiptNumber", Value: 1}}))
	if err != nil {
		return err
	}
	var receipts []struct {
		ID            bson.ObjectID  `bson:"_id"`
		Amount        int64          `bson:"amount"`
		EventID       *bson.ObjectID `bson:"eventId"`
		ReceiptNumber string         `bson:"receiptNumber"`
	}
	if err := cur.All(ctx, &receipts); err != nil {
		return err
	}
	ids := bson.A{}
	for _, r := range receipts {
		if r.EventID != nil {
			ids = append(ids, *r.EventID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	ec, err := db.Collection("paymentevents").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "status", Value: "SETTLED"}}, options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		return err
	}
	var settled []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := ec.All(ctx, &settled); err != nil {
		return err
	}
	ok := map[bson.ObjectID]bool{}
	for _, e := range settled {
		ok[e.ID] = true
	}
	for _, r := range receipts {
		if r.EventID != nil && !ok[*r.EventID] {
			rec.Finding(recon.Finding{Code: "RECEIPT_ORPHANED", Detail: "receipt " + r.ReceiptNumber + " for " + num(r.Amount) + " has no settled event", EntityID: ref(r.ID), EntityType: "Receipt", Severity: "ERROR"})
		}
	}
	rec.Count("receiptsChecked", int64(len(receipts)))
	return nil
}

func checkExpiredEvents(ctx context.Context, db *mongo.Database, hostel bson.ObjectID, rec *recon.Recorder, now time.Time) error {
	cur, err := db.Collection("paymentevents").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "expiresAt", Value: bson.D{{Key: "$lt", Value: now}}}, {Key: "status", Value: "PENDING"}},
		options.Find().SetProjection(bson.D{{Key: "amount", Value: 1}, {Key: "expiresAt", Value: 1}}).SetLimit(driftStaleEventLimit))
	if err != nil {
		return err
	}
	var stale []struct {
		ID        bson.ObjectID `bson:"_id"`
		Amount    int64         `bson:"amount"`
		ExpiresAt time.Time     `bson:"expiresAt"`
	}
	if err := cur.All(ctx, &stale); err != nil {
		return err
	}
	for _, e := range stale {
		rec.Finding(recon.Finding{Code: "EXPIRY_UNSWEPT", Detail: "pending since " + httpx.ISO(e.ExpiresAt) + " for " + num(e.Amount), EntityID: ref(e.ID), EntityType: "PaymentEvent", Severity: "WARN"})
	}
	rec.Count("expiredUnswept", int64(len(stale)))
	return nil
}

func checkCreditBalances(ctx context.Context, db *mongo.Database, hostel bson.ObjectID, rec *recon.Recorder, _ time.Time) error {
	cur, err := db.Collection("creditbalances").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}}, options.Find().SetProjection(bson.D{{Key: "amount", Value: 1}, {Key: "entries", Value: 1}, {Key: "residentId", Value: 1}}))
	if err != nil {
		return err
	}
	type entry struct {
		Amount    int64          `bson:"amount"`
		InvoiceID *bson.ObjectID `bson:"invoiceId"`
		Kind      string         `bson:"kind"`
	}
	var balances []struct {
		ID      bson.ObjectID `bson:"_id"`
		Amount  int64         `bson:"amount"`
		Entries []entry       `bson:"entries"`
	}
	if err := cur.All(ctx, &balances); err != nil {
		return err
	}
	if len(balances) == 0 {
		return nil
	}
	applied := bson.A{}
	for _, b := range balances {
		for _, e := range b.Entries {
			if e.Kind == "APPLIED" && e.InvoiceID != nil {
				applied = append(applied, *e.InvoiceID)
			}
		}
	}
	withCredit := map[bson.ObjectID]bool{}
	if len(applied) > 0 {
		ic, err := db.Collection("invoices").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: applied}}}}, options.Find().SetProjection(bson.D{{Key: "lines", Value: 1}}))
		if err != nil {
			return err
		}
		var invoices []struct {
			ID    bson.ObjectID `bson:"_id"`
			Lines []struct {
				Basis string `bson:"basis"`
			} `bson:"lines"`
		}
		if err := ic.All(ctx, &invoices); err != nil {
			return err
		}
		for _, inv := range invoices {
			for _, l := range inv.Lines {
				if l.Basis == "CREDIT" {
					withCredit[inv.ID] = true
				}
			}
		}
	}
	for _, b := range balances {
		var computed int64
		for _, e := range b.Entries {
			if e.Kind == "EARNED" {
				computed += e.Amount
			} else {
				computed -= e.Amount
			}
		}
		if b.Amount != computed {
			rec.Finding(recon.Finding{Code: "CREDIT_DRIFT", Detail: "stored " + num(b.Amount) + ", entries sum to " + num(computed), EntityID: ref(b.ID), EntityType: "CreditBalance", Severity: "ERROR"})
		}
		for _, e := range b.Entries {
			if e.Kind == "APPLIED" && e.InvoiceID != nil && !withCredit[*e.InvoiceID] {
				rec.Finding(recon.Finding{Code: "CREDIT_UNAPPLIED", Detail: num(e.Amount) + " consumed for an invoice with no credit line", EntityID: ref(*e.InvoiceID), EntityType: "Invoice", Severity: "ERROR"})
			}
		}
	}
	rec.Count("creditBalancesChecked", int64(len(balances)))
	return nil
}

func checkUnconfirmedClaims(ctx context.Context, db *mongo.Database, hostel bson.ObjectID, rec *recon.Recorder, now time.Time) error {
	var profile struct {
		StatementCadenceDays *int64 `bson:"statementCadenceDays"`
	}
	if err := db.Collection("hostelpaymentprofiles").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "statementCadenceDays", Value: 1}})).Decode(&profile); err != nil && err != mongo.ErrNoDocuments {
		return err
	}
	cadence := int64(defaultCadenceDays)
	if profile.StatementCadenceDays != nil {
		cadence = *profile.StatementCadenceDays
	}
	cutoff := now.Add(-time.Duration(2*cadence) * 24 * time.Hour)
	cur, err := db.Collection("paymentevents").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "confirmation", Value: "MANUAL_REVIEW"}, {Key: "reversedByEventId", Value: nil},
		{Key: "settledAt", Value: bson.D{{Key: "$lt", Value: cutoff}}}, {Key: "source", Value: "RESIDENT_CLAIM"}, {Key: "status", Value: "SETTLED"}},
		options.Find().SetSort(bson.D{{Key: "settledAt", Value: 1}}).SetLimit(driftStaleEventLimit).SetProjection(bson.D{{Key: "amount", Value: 1}, {Key: "residentId", Value: 1}, {Key: "reviewedBy", Value: 1}, {Key: "settledAt", Value: 1}}))
	if err != nil {
		return err
	}
	var stale []struct {
		ID         bson.ObjectID  `bson:"_id"`
		Amount     int64          `bson:"amount"`
		ResidentID *bson.ObjectID `bson:"residentId"`
		ReviewedBy *bson.ObjectID `bson:"reviewedBy"`
		SettledAt  *time.Time     `bson:"settledAt"`
	}
	if err := cur.All(ctx, &stale); err != nil {
		return err
	}
	if len(stale) == 0 {
		rec.Count("unconfirmedClaims", 0)
		return nil
	}
	residentIDs, reviewerIDs := bson.A{}, bson.A{}
	for _, e := range stale {
		if e.ResidentID != nil {
			residentIDs = append(residentIDs, *e.ResidentID)
		}
		if e.ReviewedBy != nil {
			reviewerIDs = append(reviewerIDs, *e.ReviewedBy)
		}
	}
	names := map[bson.ObjectID]string{}
	if len(residentIDs) > 0 {
		c, err := db.Collection("residents").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: residentIDs}}}}, options.Find().SetProjection(bson.D{{Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}}))
		if err != nil {
			return err
		}
		var rs []struct {
			ID        bson.ObjectID `bson:"_id"`
			FirstName string        `bson:"firstName"`
			LastName  string        `bson:"lastName"`
		}
		if err := c.All(ctx, &rs); err != nil {
			return err
		}
		for _, r := range rs {
			var parts []string
			for _, p := range []string{r.FirstName, r.LastName} {
				if p != "" {
					parts = append(parts, p)
				}
			}
			names[r.ID] = strings.TrimSpace(strings.Join(parts, " "))
		}
	}
	reviewers := map[bson.ObjectID]string{}
	if len(reviewerIDs) > 0 {
		c, err := db.Collection("users").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: reviewerIDs}}}}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}))
		if err != nil {
			return err
		}
		var us []struct {
			ID   bson.ObjectID `bson:"_id"`
			Name string        `bson:"name"`
		}
		if err := c.All(ctx, &us); err != nil {
			return err
		}
		for _, u := range us {
			reviewers[u.ID] = u.Name
		}
	}
	for _, e := range stale {
		who := "a resident"
		if e.ResidentID != nil && names[*e.ResidentID] != "" {
			who = names[*e.ResidentID]
		}
		on := "an unknown date"
		if e.SettledAt != nil {
			on = httpx.ISO(*e.SettledAt)[:10]
		}
		by := ""
		if e.ReviewedBy != nil && reviewers[*e.ReviewedBy] != "" {
			by = " by " + reviewers[*e.ReviewedBy]
		}
		rec.Finding(recon.Finding{Code: "CLAIM_UNCONFIRMED", Detail: who + " was credited " + num(e.Amount) + " on " + on + by + " — no statement credit has matched it in " + num(2*cadence) + " days",
			EntityID: ref(e.ID), EntityType: "PaymentEvent", Severity: "WARN"})
	}
	rec.Count("unconfirmedClaims", int64(len(stale)))
	return nil
}

func checkAuditChain(ctx context.Context, db *mongo.Database, hostel bson.ObjectID, rec *recon.Recorder, _ time.Time) error {
	cur, err := db.Collection("auditlogs").Find(ctx, bson.D{{Key: "financeIntegrity", Value: bson.D{{Key: "$exists", Value: true}}}, {Key: "hostelId", Value: hostel}},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(auditChainWindow).
			SetProjection(bson.D{{Key: "action", Value: 1}, {Key: "createdAt", Value: 1}, {Key: "entityId", Value: 1}, {Key: "financeIntegrity", Value: 1}, {Key: "metadata", Value: 1}}))
	if err != nil {
		return err
	}
	var entries []struct {
		ID               bson.ObjectID `bson:"_id"`
		Action           string        `bson:"action"`
		CreatedAt        time.Time     `bson:"createdAt"`
		EntityID         string        `bson:"entityId"`
		FinanceIntegrity string        `bson:"financeIntegrity"`
		Metadata         struct {
			AmountAfter float64 `bson:"amountAfter"`
		} `bson:"metadata"`
	}
	if err := cur.All(ctx, &entries); err != nil {
		return err
	}
	// Oldest first: each entry is checked against the one before it.
	for i := len(entries) - 2; i >= 0; i-- {
		e, prev := entries[i], entries[i+1]
		if audit.IntegrityHash(prev.FinanceIntegrity, e.Action, e.EntityID, int64(e.Metadata.AmountAfter), e.CreatedAt) != e.FinanceIntegrity {
			rec.Finding(recon.Finding{Code: "AUDIT_CHAIN_BROKEN", Detail: "audit entry " + e.ID.Hex() + " (" + e.Action + ") does not verify against its predecessor", EntityID: ref(e.ID), EntityType: "AuditLog", Severity: "ERROR"})
			break
		}
	}
	rec.Count("auditEntriesChecked", int64(len(entries)))
	return nil
}
