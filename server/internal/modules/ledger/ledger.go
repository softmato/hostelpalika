// Package ledger is the one module that writes money (ADR-2): payment events,
// invoice balances, receipts and credit. modules/finance/payment-event.service,
// receipt.service and credit-balance.service in TS.
//
// TS orders its writes so a crash leaves a state the drift job can find (ADR-4,
// no transactions, because a standalone mongod has none). Every Go deployment runs
// a replica set, so a settlement here is one transaction: the event, the balance,
// the credit and the receipt land together (review_fixes_needed.md R28). The
// unique indexes still make a retried call a no-op. Audit lines and notifications
// follow the commit, and a failure in them never undoes the money.
package ledger

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
)

// Engine holds what a money write touches. Audit, Notify and Mail may be nil in a
// caller that does not need them (a test of the sums).
type Engine struct {
	DB     *mongo.Database
	Audit  *audit.Log
	Notify *notifications.Service
	Mail   *email.Sender
	Config *platformconfig.Service
	Bump   realtime.Bumper
	AppURL func(path string) string
}

// JSInt is how the JS driver stores a whole number: int32 when it fits, else a
// double. An int64 would land as NumberLong, a type no TS writer produces.
func JSInt(v int64) any {
	if v >= math.MinInt32 && v <= math.MaxInt32 {
		return int32(v)
	}
	return float64(v)
}

func now() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

// Event is one PaymentEvent row.
type Event struct {
	ID            bson.ObjectID  `bson:"_id"`
	Amount        int64          `bson:"amount"`
	Confirmation  string         `bson:"confirmation"`
	Direction     string         `bson:"direction"`
	HostelID      bson.ObjectID  `bson:"hostelId"`
	InvoiceID     *bson.ObjectID `bson:"invoiceId"`
	Provider      string         `bson:"provider"`
	ReferenceCode *string        `bson:"referenceCode"`
	ResidentID    *bson.ObjectID `bson:"residentId"`
	ReversedBy    *bson.ObjectID `bson:"reversedByEventId"`
	Source        string         `bson:"source"`
	Status        string         `bson:"status"`
	Raw           struct {
		ReferenceNote   *string `bson:"referenceNote"`
		TransactionCode *string `bson:"transactionCode"`
		RecordedBy      *string `bson:"recordedBy"`
	} `bson:"rawPayload"`
}

// AppendInput is appendEvent's argument. Zero values take the schema's defaults.
type AppendInput struct {
	Amount         int64
	Confirmation   string
	Direction      string
	EvidenceAsset  *bson.ObjectID
	EvidenceHash   string
	HostelID       bson.ObjectID
	IdempotencyKey string
	InvoiceID      *bson.ObjectID
	OccurredAt     time.Time
	Provider       string
	ProviderTxnID  string
	RawPayload     bson.D
	ReferenceCode  string
	ResidentID     *bson.ObjectID
	ReviewFlags    []string
	Source         string
	StatementID    *bson.ObjectID
	Status         string
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func stringOrNil(v string) any {
	if v == "" {
		return nil
	}
	return v
}

func idOrNil(id *bson.ObjectID) any {
	if id == nil {
		return nil
	}
	return *id
}

// AppendEvent records an attempt to pay. Idempotent by the unique index on
// idempotencyKey: a replay returns the row that exists. A collision on
// providerTxnId or evidenceHash is the same money or the same screenshot claimed
// twice, and reaches the caller as an error.
func (e *Engine) AppendEvent(ctx context.Context, in AppendInput) (event *Event, created bool, err error) {
	if in.Amount <= 0 { // positiveWholeRupees on the model
		return nil, false, finance.Err("AMOUNT_OUT_OF_BOUNDS", "A payment event must move a positive amount.")
	}
	at := now()
	occurred := in.OccurredAt
	if occurred.IsZero() {
		occurred = at
	}
	flags, raw := in.ReviewFlags, in.RawPayload
	if flags == nil {
		flags = []string{}
	}
	if raw == nil {
		raw = bson.D{}
	}
	id := bson.NewObjectID()
	_, err = e.DB.Collection("paymentevents").InsertOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: in.HostelID}, {Key: "invoiceId", Value: idOrNil(in.InvoiceID)},
		{Key: "residentId", Value: idOrNil(in.ResidentID)}, {Key: "referenceCode", Value: stringOrNil(strings.ToUpper(strings.TrimSpace(in.ReferenceCode)))}, {Key: "amount", Value: JSInt(in.Amount)},
		{Key: "currency", Value: "NPR"}, {Key: "direction", Value: orDefault(in.Direction, "CREDIT")}, {Key: "source", Value: in.Source}, {Key: "provider", Value: orDefault(in.Provider, "NONE")},
		{Key: "providerTxnId", Value: stringOrNil(strings.TrimSpace(in.ProviderTxnID))}, {Key: "statementImportId", Value: idOrNil(in.StatementID)}, {Key: "confirmation", Value: orDefault(in.Confirmation, "UNCONFIRMED")},
		{Key: "confirmedAt", Value: nil}, {Key: "status", Value: orDefault(in.Status, "PENDING")}, {Key: "evidenceAssetId", Value: idOrNil(in.EvidenceAsset)}, {Key: "evidenceHash", Value: stringOrNil(in.EvidenceHash)},
		{Key: "rawPayload", Value: raw}, {Key: "idempotencyKey", Value: in.IdempotencyKey}, {Key: "occurredAt", Value: occurred}, {Key: "observedAt", Value: at},
		{Key: "reversedByEventId", Value: nil}, {Key: "reversesEventId", Value: nil}, {Key: "reviewFlags", Value: flags},
		{Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}})
	if err == nil {
		event = &Event{}
		return event, true, e.DB.Collection("paymentevents").FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(event)
	}
	if !mongo.IsDuplicateKeyError(err) {
		return nil, false, err
	}
	switch msg := err.Error(); {
	case strings.Contains(msg, "providerTxnId"):
		return nil, false, finance.Err("TXN_ID_ALREADY_USED", "This transaction ID has already been recorded.")
	case strings.Contains(msg, "evidenceHash"):
		return nil, false, finance.Err("EVIDENCE_ALREADY_USED", "This screenshot has already been submitted.")
	}
	event = &Event{}
	if derr := e.DB.Collection("paymentevents").FindOne(ctx, bson.D{{Key: "idempotencyKey", Value: in.IdempotencyKey}}).Decode(event); derr != nil {
		return nil, false, err
	}
	return event, false, nil
}

// Balance is InvoiceBalanceResult.
type Balance struct {
	InvoiceID     bson.ObjectID
	Outstanding   int64
	SettledAmount int64
	Status        string
	TotalAmount   int64
}

// DeriveInvoiceStatus is deriveInvoiceStatus: PAID → OVERDUE → PARTIAL → OPEN. VOID
// and WRITTEN_OFF are decisions and stay; a recomputation must not resurrect them.
func DeriveInvoiceStatus(current string, due *time.Time, at time.Time, settled, total int64) string {
	if current == "VOID" || current == "WRITTEN_OFF" {
		return current
	}
	if settled >= total {
		return "PAID"
	}
	if due != nil && due.Before(at) {
		return "OVERDUE"
	}
	if settled > 0 {
		return "PARTIAL"
	}
	return "OPEN"
}

// RecomputeInvoiceBalance rebuilds the projection from the events, from scratch: an
// increment can drift, a recomputation cannot.
func (e *Engine) RecomputeInvoiceBalance(ctx context.Context, invoiceID bson.ObjectID) (*Balance, error) {
	cur, err := e.DB.Collection("paymentevents").Find(ctx, bson.D{{Key: "invoiceId", Value: invoiceID}, {Key: "status", Value: "SETTLED"}},
		options.Find().SetProjection(bson.D{{Key: "amount", Value: 1}, {Key: "direction", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var events []struct {
		ID        bson.ObjectID `bson:"_id"`
		Amount    int64         `bson:"amount"`
		Direction string        `bson:"direction"`
	}
	if err := cur.All(ctx, &events); err != nil {
		return nil, err
	}
	var settled int64
	var last any
	for _, ev := range events {
		if ev.Direction == "DEBIT" {
			settled -= ev.Amount
		} else {
			settled += ev.Amount
		}
		last = ev.ID
	}
	var inv struct {
		DueDate    *time.Time     `bson:"dueDate"`
		HostelID   bson.ObjectID  `bson:"hostelId"`
		ResidentID *bson.ObjectID `bson:"residentId"`
		Status     string         `bson:"status"`
		Total      int64          `bson:"totalAmount"`
	}
	if err := e.DB.Collection("invoices").FindOne(ctx, bson.D{{Key: "_id", Value: invoiceID}}).Decode(&inv); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, finance.Err("INVOICE_NOT_FOUND", "Invoice was not found.")
		}
		return nil, err
	}
	at := now()
	_, err = e.DB.Collection("invoicebalances").UpdateOne(ctx, bson.D{{Key: "invoiceId", Value: invoiceID}},
		bson.D{{Key: "$inc", Value: bson.D{{Key: "version", Value: 1}}},
			{Key: "$set", Value: bson.D{{Key: "hostelId", Value: inv.HostelID}, {Key: "lastComputedAt", Value: at}, {Key: "lastEventId", Value: last},
				{Key: "residentId", Value: idOrNil(inv.ResidentID)}, {Key: "settledAmount", Value: JSInt(settled)}, {Key: "updatedAt", Value: at}}},
			{Key: "$setOnInsert", Value: bson.D{{Key: "__v", Value: 0}, {Key: "createdAt", Value: at}}}},
		options.UpdateOne().SetUpsert(true))
	if err != nil {
		return nil, err
	}
	status := DeriveInvoiceStatus(inv.Status, inv.DueDate, at, settled, inv.Total)
	if status != inv.Status {
		if _, err := e.DB.Collection("invoices").UpdateOne(ctx, bson.D{{Key: "_id", Value: invoiceID}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: status}, {Key: "updatedAt", Value: at}}}}); err != nil {
			return nil, err
		}
	}
	return &Balance{InvoiceID: invoiceID, Outstanding: max(inv.Total-settled, 0), SettledAmount: settled, Status: status, TotalAmount: inv.Total}, nil
}

// qualifiesForOfferProgram: reference quoted and independently verified. Decided
// once, here, for every path that settles.
func qualifiesForOfferProgram(ev *Event) bool {
	if ev.InvoiceID == nil || ev.ReferenceCode == nil || *ev.ReferenceCode == "" {
		return false
	}
	code := strings.ToUpper(*ev.ReferenceCode)
	switch ev.Source {
	case "RESIDENT_CLAIM":
		for _, raw := range []*string{ev.Raw.TransactionCode, ev.Raw.ReferenceNote} {
			if raw == nil {
				continue
			}
			for _, quoted := range finance.ExtractReferenceCodes(*raw) {
				if quoted == code {
					return true
				}
			}
		}
		return false
	case "GATEWAY_POLL", "GATEWAY_WEBHOOK":
		return ev.Confirmation == "GATEWAY_VERIFIED"
	case "STATEMENT_IMPORT":
		return ev.Confirmation == "STATEMENT_MATCH"
	}
	return false
}

// SettleOptions is settleEvent's second argument.
type SettleOptions struct {
	Confirmation string
	Principal    *authz.Principal
	SettledAt    time.Time
}

// Settled is what SettleEvent changed.
type Settled struct {
	Balance *Balance
	Event   *Event
	Receipt *Receipt
}

// ErrNotPending says the event left PENDING before this call got to it: another
// reviewer won. Callers answer in their own words; never a 500.
var ErrNotPending = finance.Err("EVENT_NOT_PENDING", "This payment event is no longer pending.")

// SettleEvent moves a PENDING event to SETTLED, recomputes the balance, credits an
// overpayment in full (never destroy money) and issues the receipt, in one
// transaction. The filter on PENDING is the double-approval guard.
func (e *Engine) SettleEvent(ctx context.Context, eventID bson.ObjectID, o SettleOptions) (*Settled, error) {
	at := o.SettledAt
	if at.IsZero() {
		at = now()
	}
	var out Settled
	err := appmongo.InTx(ctx, e.DB, func(ctx context.Context) error {
		out = Settled{}
		set := bson.D{{Key: "confirmation", Value: o.Confirmation}, {Key: "reviewedAt", Value: at}}
		if o.Principal != nil {
			if me, err := httpx.OID(o.Principal.UserID, "user id"); err == nil {
				set = append(set, bson.E{Key: "reviewedBy", Value: me})
			}
		}
		set = append(set, bson.E{Key: "settledAt", Value: at}, bson.E{Key: "status", Value: "SETTLED"}, bson.E{Key: "updatedAt", Value: now()})
		event := &Event{}
		err := e.DB.Collection("paymentevents").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: eventID}, {Key: "status", Value: "PENDING"}},
			bson.D{{Key: "$set", Value: set}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(event)
		if errors.Is(err, mongo.ErrNoDocuments) {
			return ErrNotPending
		}
		if err != nil {
			return err
		}
		out.Event = event
		if event.InvoiceID != nil {
			if out.Balance, err = e.RecomputeInvoiceBalance(ctx, *event.InvoiceID); err != nil {
				return err
			}
			if b := out.Balance; event.Direction == "CREDIT" && event.ResidentID != nil && b.SettledAmount > b.TotalAmount {
				if err := e.creditOverpayment(ctx, event, b.SettledAmount-b.TotalAmount, at); err != nil {
					return err
				}
			}
		}
		if event.Direction == "CREDIT" && event.ResidentID != nil {
			out.Receipt, err = e.issueReceipt(ctx, event, at, o.Principal)
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	e.afterSettle(ctx, &out, o.Principal)
	return &out, nil
}

// afterSettle runs once the money is committed: audit, staff and resident notices,
// the cache bump. A failure is logged at error and never undoes the settlement.
func (e *Engine) afterSettle(ctx context.Context, s *Settled, p *authz.Principal) {
	ev := s.Event
	settled := ev.Amount
	if s.Balance != nil {
		settled = s.Balance.SettledAmount
	}
	if p != nil && e.Audit != nil {
		if me, err := httpx.OID(p.UserID, "user id"); err == nil {
			f := audit.Finance{Action: "PAYMENT_EVENT_SETTLED", AmountAfter: settled, AmountBefore: settled - ev.Amount, EntityID: ev.ID.Hex(), EntityType: "PaymentEvent",
				EventID: ev.ID.Hex(), HostelID: ev.HostelID, Source: "EVENT_SETTLEMENT"}
			if ev.InvoiceID != nil {
				f.InvoiceID = ev.InvoiceID.Hex()
			}
			if err := e.Audit.WriteFinance(ctx, me, string(p.Role), f); err != nil {
				slog.ErrorContext(ctx, "finance audit failed after settling", "eventId", ev.ID.Hex(), "error", err)
			}
		}
	}
	if p != nil && p.Role == authz.Warden && ev.Direction == "CREDIT" && ev.ResidentID != nil {
		e.notifyAdminsOfStaffSettlement(ctx, ev, p.UserID)
	}
	if ev.Source == "CASH_ENTRY" && ev.Direction == "CREDIT" && ev.ResidentID != nil {
		var remaining int64
		if s.Balance != nil {
			remaining = s.Balance.Outstanding
		}
		e.NotifyClaimReviewed(ctx, ClaimReview{HostelID: ev.HostelID, InvoiceID: ev.InvoiceID, Kind: "verified", Receipt: s.Receipt, Remaining: remaining, Verified: ev.Amount, ResidentID: *ev.ResidentID, Period: e.periodOf(ctx, ev.InvoiceID)})
	}
	if e.Bump != nil {
		e.Bump.Bump(ctx, ev.HostelID.Hex())
	}
}

// periodOf reads an invoice's period; nil for a one-off, or when it cannot be read.
func (e *Engine) periodOf(ctx context.Context, invoiceID *bson.ObjectID) *string {
	if invoiceID == nil {
		return nil
	}
	var inv struct {
		Period *string `bson:"period"`
	}
	if err := e.DB.Collection("invoices").FindOne(ctx, bson.D{{Key: "_id", Value: *invoiceID}},
		options.FindOne().SetProjection(bson.D{{Key: "period", Value: 1}})).Decode(&inv); err != nil {
		return nil
	}
	return inv.Period
}

// ConfirmByStatement promotes a human's settlement once the hostel's own statement
// shows the credit: MANUAL_REVIEW → STATEMENT_MATCH. No money moves. Idempotent: a
// second statement with the same credit matches nothing and reports false.
func (e *Engine) ConfirmByStatement(ctx context.Context, eventID bson.ObjectID, statement *bson.ObjectID, p *authz.Principal) (bool, error) {
	at := now()
	set := bson.D{{Key: "confirmation", Value: "STATEMENT_MATCH"}, {Key: "confirmedAt", Value: at}, {Key: "updatedAt", Value: at}}
	if statement != nil {
		set = append(set, bson.E{Key: "statementImportId", Value: *statement})
	}
	event := &Event{}
	err := e.DB.Collection("paymentevents").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: eventID}, {Key: "confirmation", Value: "MANUAL_REVIEW"}, {Key: "status", Value: "SETTLED"}},
		bson.D{{Key: "$set", Value: set}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(event)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if p != nil && e.Audit != nil {
		if me, err := httpx.OID(p.UserID, "user id"); err == nil {
			f := audit.Finance{Action: "PAYMENT_EVENT_CONFIRMED", AmountAfter: event.Amount, AmountBefore: event.Amount, EntityID: event.ID.Hex(), EntityType: "PaymentEvent", EventID: event.ID.Hex(), HostelID: event.HostelID, Source: "STATEMENT_IMPORT"}
			if event.InvoiceID != nil {
				f.InvoiceID = event.InvoiceID.Hex()
			}
			if err := e.Audit.WriteFinance(ctx, me, string(p.Role), f); err != nil {
				slog.ErrorContext(ctx, "finance audit failed after confirming", "eventId", event.ID.Hex(), "error", err)
			}
		}
	}
	return true, nil
}

// ReverseEvent writes a settled event's mirror, in one transaction with its
// pointers, the balance, the receipt it voids and the credit it takes back.
//
// Scoped to the caller's hostels: TS looked the event up by id alone, so a hostel
// could reverse another hostel's payment (finding FIN-1). A second call answers
// with the first reversal and tells nobody twice (FIN-3). The overpayment credit
// goes back with the money, which TS left standing (FIN-4).
func (e *Engine) ReverseEvent(ctx context.Context, eventID bson.ObjectID, p *authz.Principal, reason string) (*Balance, bson.ObjectID, error) {
	var zero bson.ObjectID
	if len(strings.TrimSpace(reason)) < 3 {
		return nil, zero, finance.Err("REVERSAL_REASON_REQUIRED", "A reversal needs a reason.")
	}
	scope := bson.A{}
	for _, h := range p.HostelIDs {
		if id, err := bson.ObjectIDFromHex(h); err == nil {
			scope = append(scope, id)
		}
	}
	original := &Event{}
	err := e.DB.Collection("paymentevents").FindOne(ctx, bson.D{{Key: "_id", Value: eventID}, {Key: "hostelId", Value: bson.D{{Key: "$in", Value: scope}}}}).Decode(original)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, zero, finance.Err("EVENT_NOT_FOUND", "Payment event was not found.")
	}
	if err != nil {
		return nil, zero, err
	}
	if original.Status != "SETTLED" {
		return nil, zero, finance.Err("EVENT_NOT_SETTLED", "Only a settled payment can be reversed.")
	}
	if original.ReversedBy != nil {
		var balance *Balance
		if original.InvoiceID != nil {
			if balance, err = e.RecomputeInvoiceBalance(ctx, *original.InvoiceID); err != nil {
				return nil, zero, err
			}
		}
		return balance, *original.ReversedBy, nil
	}
	direction := "DEBIT"
	if original.Direction == "DEBIT" {
		direction = "CREDIT"
	}
	me, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		return nil, zero, err
	}
	var balance *Balance
	var reversal *Event
	err = appmongo.InTx(ctx, e.DB, func(ctx context.Context) error {
		balance, reversal = nil, nil
		var err error
		reversal, _, err = e.AppendEvent(ctx, AppendInput{Amount: original.Amount, Confirmation: "MANUAL_REVIEW", Direction: direction, HostelID: original.HostelID,
			IdempotencyKey: "reversal:" + original.ID.Hex(), InvoiceID: original.InvoiceID, RawPayload: bson.D{{Key: "reason", Value: reason}, {Key: "reverses", Value: original.ID.Hex()}},
			ResidentID: original.ResidentID, Source: "ADJUSTMENT", Status: "SETTLED"})
		if err != nil {
			return err
		}
		at := now()
		events := e.DB.Collection("paymentevents")
		if _, err := events.UpdateOne(ctx, bson.D{{Key: "_id", Value: reversal.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "reversesEventId", Value: original.ID}, {Key: "settledAt", Value: at}, {Key: "updatedAt", Value: at}}}}); err != nil {
			return err
		}
		// The ONLY write to the original, and it stays SETTLED: the balance is the sum
		// of SETTLED rows, so demoting it while the DEBIT also subtracts would land at
		// minus the amount. A reversed event is found by reversedByEventId, never status.
		if _, err := events.UpdateOne(ctx, bson.D{{Key: "_id", Value: original.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "reversedByEventId", Value: reversal.ID}, {Key: "updatedAt", Value: at}}}}); err != nil {
			return err
		}
		if original.InvoiceID != nil {
			if balance, err = e.RecomputeInvoiceBalance(ctx, *original.InvoiceID); err != nil {
				return err
			}
		}
		if err := e.takeBackOverpayment(ctx, original, at); err != nil {
			return err
		}
		return e.voidReceiptOfEvent(ctx, original.ID, me, string(p.Role), reason, at)
	})
	if err != nil {
		return nil, zero, err
	}
	var outstanding, settled int64
	if balance != nil {
		outstanding, settled = balance.Outstanding, balance.SettledAmount
	}
	if original.ResidentID != nil {
		e.notifyPaymentReversed(ctx, original, outstanding, reason)
	}
	if e.Audit != nil {
		f := audit.Finance{Action: "PAYMENT_EVENT_REVERSED", AmountAfter: settled, AmountBefore: settled + original.Amount, EntityID: original.ID.Hex(), EntityType: "PaymentEvent",
			EventID: original.ID.Hex(), HostelID: original.HostelID, Reason: reason, Source: "EVENT_REVERSAL"}
		if original.InvoiceID != nil {
			f.InvoiceID = original.InvoiceID.Hex()
		}
		if err := e.Audit.WriteFinance(ctx, me, string(p.Role), f); err != nil {
			slog.ErrorContext(ctx, "finance audit failed after reversing", "eventId", original.ID.Hex(), "error", err)
		}
	}
	if e.Bump != nil {
		e.Bump.Bump(ctx, original.HostelID.Hex())
	}
	return balance, reversal.ID, nil
}
