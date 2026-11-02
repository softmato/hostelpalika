package finance

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// LedgerScope narrows the invoice ledger (ledger-read.service.ts); status is
// never VOID, or only the unsettled ones.
type LedgerScope struct {
	HostelID, ResidentID bson.ObjectID
	UnsettledOnly        bool
	Limit                int64
}

// LedgerInvoice is one invoice as the money screens read it, amounts in paisa.
type LedgerInvoice struct {
	CreatedAt  *time.Time
	DueAmount  int64
	DueDate    *time.Time
	HostelID   string
	ID         string
	Method     string
	PaidAmount int64
	PaidDate   *time.Time
	Period     *string
	ResidentID string
	Status     string
	Lines      []LedgerLine
}

// LedgerLine is one line of an invoice.
type LedgerLine struct {
	Amount      int64  `json:"amount"`
	Basis       string `json:"basis"`
	Description string `json:"description"`
}

var (
	legacyStatus = map[string]string{"DRAFT": "UNPAID", "OPEN": "UNPAID", "OVERDUE": "OVERDUE", "PAID": "PAID", "PARTIAL": "PARTIAL", "WRITTEN_OFF": "WRITTEN_OFF"}
	legacyMethod = map[string]string{"BANK": "BANK_TRANSFER", "CASH": "CASH", "ESEWA": "ESEWA", "FONEPAY": "FONEPAY", "KHALTI": "KHALTI"}
)

// LegacyMethodFor is the word the screens show for a provider, "" when it has none.
func LegacyMethodFor(provider string) string { return legacyMethod[provider] }

// LegacyStatusFor is legacyStatusFor: a claim awaiting review reads PENDING_PROOF.
func LegacyStatusFor(status string, pendingClaim bool) string {
	mapped, ok := legacyStatus[status]
	if !ok {
		mapped = status
	}
	if pendingClaim && (mapped == "UNPAID" || mapped == "PARTIAL") {
		return "PENDING_PROOF"
	}
	return mapped
}

func ledgerStages(s LedgerScope) bson.A {
	match := bson.D{{Key: "hostelId", Value: s.HostelID}, {Key: "residentId", Value: s.ResidentID}}
	if s.UnsettledOnly {
		match = append(match, bson.E{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"OPEN", "PARTIAL", "OVERDUE"}}}})
	} else {
		match = append(match, bson.E{Key: "status", Value: bson.D{{Key: "$ne", Value: "VOID"}}})
	}
	return LedgerStages(match)
}

// LedgerStages is ledgerPipeline: invoices joined to their balance, last settlement and pending claim.
func LedgerStages(match bson.D) bson.A {
	eventFor := func(status string) bson.D {
		return bson.D{{Key: "$match", Value: bson.D{{Key: "$expr", Value: bson.D{{Key: "$eq", Value: bson.A{"$invoiceId", "$$invoiceId"}}}}, {Key: "direction", Value: "CREDIT"}, {Key: "status", Value: status}}}}
	}
	return bson.A{
		bson.D{{Key: "$match", Value: match}},
		bson.D{{Key: "$lookup", Value: bson.D{{Key: "as", Value: "balance"}, {Key: "foreignField", Value: "invoiceId"}, {Key: "from", Value: "invoicebalances"}, {Key: "localField", Value: "_id"}}}},
		bson.D{{Key: "$lookup", Value: bson.D{{Key: "as", Value: "lastSettled"}, {Key: "from", Value: "paymentevents"}, {Key: "let", Value: bson.D{{Key: "invoiceId", Value: "$_id"}}},
			{Key: "pipeline", Value: bson.A{eventFor("SETTLED"), bson.D{{Key: "$sort", Value: bson.D{{Key: "settledAt", Value: -1}}}}, bson.D{{Key: "$limit", Value: 1}},
				bson.D{{Key: "$project", Value: bson.D{{Key: "provider", Value: 1}, {Key: "settledAt", Value: 1}}}}}}}}},
		bson.D{{Key: "$lookup", Value: bson.D{{Key: "as", Value: "pendingClaims"}, {Key: "from", Value: "paymentevents"}, {Key: "let", Value: bson.D{{Key: "invoiceId", Value: "$_id"}}},
			{Key: "pipeline", Value: bson.A{eventFor("PENDING"), bson.D{{Key: "$limit", Value: 1}}, bson.D{{Key: "$project", Value: bson.D{{Key: "_id", Value: 1}}}}}}}}},
		bson.D{{Key: "$addFields", Value: bson.D{{Key: "hasPendingClaim", Value: bson.D{{Key: "$gt", Value: bson.A{bson.D{{Key: "$size", Value: "$pendingClaims"}}, 0}}}},
			{Key: "method", Value: bson.D{{Key: "$arrayElemAt", Value: bson.A{"$lastSettled.provider", 0}}}},
			{Key: "paidAmount", Value: bson.D{{Key: "$ifNull", Value: bson.A{bson.D{{Key: "$arrayElemAt", Value: bson.A{"$balance.settledAmount", 0}}}, 0}}}},
			{Key: "paidDate", Value: bson.D{{Key: "$arrayElemAt", Value: bson.A{"$lastSettled.settledAt", 0}}}}}}},
	}
}

// ListResidentInvoices is listResidentInvoices: newest due date first.
func ListResidentInvoices(ctx context.Context, db *mongo.Database, s LedgerScope) ([]LedgerInvoice, error) {
	return ListLedger(ctx, db, ledgerStages(s), bson.D{{Key: "dueDate", Value: -1}}, s.Limit)
}

// UnvoidedMatch is ledgerFilterFor's default status: everything but VOID.
func UnvoidedMatch(match bson.D) bson.A {
	return LedgerStages(append(match, bson.E{Key: "status", Value: bson.D{{Key: "$ne", Value: "VOID"}}}))
}

// ListLedger runs the ledger stages, sorted and limited (0 = no limit).
// listRecentInvoices is this with createdAt -1.
func ListLedger(ctx context.Context, db *mongo.Database, stages bson.A, sort bson.D, limit int64) ([]LedgerInvoice, error) {
	stages = append(stages, bson.D{{Key: "$sort", Value: sort}})
	if limit > 0 {
		stages = append(stages, bson.D{{Key: "$limit", Value: limit}})
	}
	cur, err := db.Collection("invoices").Aggregate(ctx, stages)
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID              bson.ObjectID `bson:"_id"`
		CreatedAt       *time.Time    `bson:"createdAt"`
		DueDate         *time.Time    `bson:"dueDate"`
		HasPendingClaim bool          `bson:"hasPendingClaim"`
		HostelID        bson.ObjectID `bson:"hostelId"`
		Lines           []LedgerLine  `bson:"lines"`
		Method          string        `bson:"method"`
		PaidAmount      int64         `bson:"paidAmount"`
		PaidDate        *time.Time    `bson:"paidDate"`
		Period          *string       `bson:"period"`
		ResidentID      bson.ObjectID `bson:"residentId"`
		Status          string        `bson:"status"`
		TotalAmount     int64         `bson:"totalAmount"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := make([]LedgerInvoice, len(rows))
	for i, r := range rows {
		out[i] = LedgerInvoice{r.CreatedAt, r.TotalAmount, r.DueDate, r.HostelID.Hex(), r.ID.Hex(), legacyMethod[r.Method], r.PaidAmount, r.PaidDate, r.Period, r.ResidentID.Hex(), LegacyStatusFor(r.Status, r.HasPendingClaim), r.Lines}
	}
	return out, nil
}
