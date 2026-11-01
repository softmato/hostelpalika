package ledger

import (
	"context"
	"errors"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
)

// creditEntry is a CreditBalance entry, by its unique idempotency key.
type creditEntry struct {
	Amount  int64
	Event   *bson.ObjectID
	Invoice *bson.ObjectID
	Key     string
	Kind    string // EARNED, APPLIED, REFUNDED
	Note    string
	At      time.Time
}

func balanceFilter(hostel, resident bson.ObjectID) bson.D {
	return bson.D{{Key: "hostelId", Value: hostel}, {Key: "residentId", Value: resident}}
}

// RecomputeCredit rebuilds amount from the entries; an increment can drift.
func (e *Engine) RecomputeCredit(ctx context.Context, hostel, resident bson.ObjectID) (int64, error) {
	var row struct {
		Entries []struct {
			Amount int64  `bson:"amount"`
			Kind   string `bson:"kind"`
		} `bson:"entries"`
	}
	err := e.DB.Collection("creditbalances").FindOne(ctx, balanceFilter(hostel, resident)).Decode(&row)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return 0, err
	}
	var amount int64
	for _, en := range row.Entries {
		if en.Kind == "EARNED" {
			amount += en.Amount
		} else {
			amount -= en.Amount
		}
	}
	at := now()
	_, err = e.DB.Collection("creditbalances").UpdateOne(ctx, balanceFilter(hostel, resident),
		bson.D{{Key: "$set", Value: bson.D{{Key: "amount", Value: JSInt(amount)}, {Key: "lastComputedAt", Value: at}, {Key: "updatedAt", Value: at}}}})
	return amount, err
}

// appendCredit pushes an entry and recomputes. created is false when the key was
// already there, so a replay credits nothing. TS relied on a unique index for this,
// and that index only guards across documents: within one resident's row the same key
// could be pushed twice (finding FIN-5). So the push itself is conditional.
func (e *Engine) appendCredit(ctx context.Context, hostel, resident bson.ObjectID, en creditEntry) (amount int64, created bool, err error) {
	if en.Amount <= 0 {
		return 0, false, finance.Err("AMOUNT_OUT_OF_BOUNDS", "A credit entry must move a positive amount.")
	}
	at := en.At
	if at.IsZero() {
		at = now()
	}
	entry := bson.D{{Key: "kind", Value: en.Kind}, {Key: "amount", Value: JSInt(en.Amount)}, {Key: "eventId", Value: idOrNil(en.Event)}, {Key: "invoiceId", Value: idOrNil(en.Invoice)},
		{Key: "idempotencyKey", Value: en.Key}, {Key: "occurredAt", Value: at}, {Key: "note", Value: en.Note}}
	stamp := now()
	filter := append(balanceFilter(hostel, resident), bson.E{Key: "entries.idempotencyKey", Value: bson.D{{Key: "$ne", Value: en.Key}}})
	res, err := e.DB.Collection("creditbalances").UpdateOne(ctx, filter, bson.D{
		{Key: "$push", Value: bson.D{{Key: "entries", Value: entry}}},
		{Key: "$set", Value: bson.D{{Key: "updatedAt", Value: stamp}}},
	})
	if err != nil {
		return 0, false, err
	}
	created = res.MatchedCount > 0
	if !created {
		// No row matched: either the key is already there, or the resident has no row yet.
		ins, err := e.DB.Collection("creditbalances").UpdateOne(ctx, balanceFilter(hostel, resident), bson.D{
			{Key: "$setOnInsert", Value: bson.D{{Key: "amount", Value: 0}, {Key: "currency", Value: "NPR"}, {Key: "entries", Value: bson.A{entry}}, {Key: "__v", Value: 0}, {Key: "createdAt", Value: stamp}, {Key: "updatedAt", Value: stamp}}},
		}, options.UpdateOne().SetUpsert(true))
		if err != nil {
			return 0, false, err
		}
		created = ins.UpsertedCount > 0
	}
	amount, err = e.RecomputeCredit(ctx, hostel, resident)
	return amount, created, err
}

// creditOverpayment records the change from an overpayment, idempotent on the event.
func (e *Engine) creditOverpayment(ctx context.Context, ev *Event, excess int64, at time.Time) error {
	_, _, err := e.appendCredit(ctx, ev.HostelID, *ev.ResidentID, creditEntry{Amount: excess, Event: &ev.ID, Invoice: ev.InvoiceID, Key: "overpay:" + ev.ID.Hex(), Kind: "EARNED", Note: "Overpayment carried forward", At: at})
	return err
}

// takeBackOverpayment undoes creditOverpayment when the money is reversed. TS kept
// the credit, so a reversed 15,000 on a 12,000 invoice still left 3,000 to spend
// (finding FIN-4). If that credit is already spent the balance goes negative, which
// says so: applying credit treats anything under zero as none.
func (e *Engine) takeBackOverpayment(ctx context.Context, ev *Event, at time.Time) error {
	if ev.ResidentID == nil || ev.Direction != "CREDIT" {
		return nil
	}
	var row struct {
		Entries []struct {
			Amount int64  `bson:"amount"`
			Key    string `bson:"idempotencyKey"`
		} `bson:"entries"`
	}
	key := "overpay:" + ev.ID.Hex()
	err := e.DB.Collection("creditbalances").FindOne(ctx, bson.D{{Key: "hostelId", Value: ev.HostelID}, {Key: "residentId", Value: *ev.ResidentID}, {Key: "entries.idempotencyKey", Value: key}}).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, en := range row.Entries {
		if en.Key == key {
			_, _, err := e.appendCredit(ctx, ev.HostelID, *ev.ResidentID, creditEntry{Amount: en.Amount, Event: &ev.ID, Invoice: ev.InvoiceID, Key: "overpay-reversed:" + ev.ID.Hex(), Kind: "REFUNDED", Note: "Overpaid amount reversed", At: at})
			return err
		}
	}
	return nil
}

// ApplyCredit is applyCreditToInvoice: consumes credit for a new invoice and returns
// what was applied. A replay means the invoice already used it, so it applies 0.
func (e *Engine) ApplyCredit(ctx context.Context, hostel, resident, invoice bson.ObjectID, maxAmount int64) (int64, error) {
	available, err := finance.CreditAmount(ctx, e.DB, hostel, resident)
	if err != nil {
		return 0, err
	}
	applied := min(available, max(0, maxAmount))
	if applied <= 0 {
		return 0, nil
	}
	_, created, err := e.appendCredit(ctx, hostel, resident, creditEntry{Amount: applied, Invoice: &invoice, Key: "apply:" + invoice.Hex(), Kind: "APPLIED", Note: "Applied to invoice"})
	if err != nil || !created {
		return 0, err
	}
	return applied, nil
}

// SetConcessionCredit is setConcessionCredit: the one entry that is replaced, because a
// discount is a decision and a corrected one must not credit twice. 0 removes it.
func (e *Engine) SetConcessionCredit(ctx context.Context, hostel, resident, invoice bson.ObjectID, amount int64, kind, note string) (int64, error) {
	if kind == "" {
		kind = "concession"
	}
	key := kind + ":" + invoice.Hex()
	if _, err := e.DB.Collection("creditbalances").UpdateOne(ctx, balanceFilter(hostel, resident), bson.D{{Key: "$pull", Value: bson.D{{Key: "entries", Value: bson.D{{Key: "idempotencyKey", Value: key}}}}}}); err != nil {
		return 0, err
	}
	if amount > 0 {
		if _, _, err := e.appendCredit(ctx, hostel, resident, creditEntry{Amount: amount, Invoice: &invoice, Key: key, Kind: "EARNED", Note: note}); err != nil {
			return 0, err
		}
	}
	return e.RecomputeCredit(ctx, hostel, resident)
}
