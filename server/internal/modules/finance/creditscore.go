package finance

import (
	"context"
	"sort"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// --- resident credit score (credit-score.rules.ts / credit-score.service.ts) ---
//
// Derived from payment events, never stored: a monthly bill earns points once, by
// the first settled payment on it that the resident made. Rejected claims never
// settle and reversed ones carry reversedByEventId, so both drop out (todo B2).

// PointsForDay is pointsForDay (D2): day 1–4 = 10, 5–7 = 8, 8–15 = 5, later = 2.
func PointsForDay(day int) int {
	switch {
	case day <= 4:
		return 10
	case day <= 7:
		return 8
	case day <= 15:
		return 5
	}
	return 2
}

// ScoreRule is one line of SCORE_RULES.
type ScoreRule struct {
	Days   string `json:"days"`
	Points int    `json:"points"`
}

var ScoreRules = []ScoreRule{{"1–4", 10}, {"5–7", 8}, {"8–15", 5}, {"16+", 2}}

var scoredSources = []string{"RESIDENT_CLAIM", "CASH_ENTRY", "GATEWAY_WEBHOOK", "GATEWAY_POLL", "STATEMENT_IMPORT"}

// ScoreEvent is the slice of a PaymentEvent the score reads.
type ScoreEvent struct {
	ID         bson.ObjectID  `bson:"_id"`
	CreatedAt  *time.Time     `bson:"createdAt"`
	Direction  string         `bson:"direction"`
	InvoiceID  *bson.ObjectID `bson:"invoiceId"`
	OccurredAt *time.Time     `bson:"occurredAt"`
	ResidentID bson.ObjectID  `bson:"residentId"`
	ReversedBy *bson.ObjectID `bson:"reversedByEventId"`
	SettledAt  *time.Time     `bson:"settledAt"`
	Source     string         `bson:"source"`
	Status     string         `bson:"status"`
}

// ScoreInvoice is the slice of an Invoice the score reads.
type ScoreInvoice struct {
	ID         bson.ObjectID `bson:"_id"`
	CoversFrom *time.Time    `bson:"coversFrom"`
	Kind       string        `bson:"kind"`
	Period     *string       `bson:"period"`
}

// ScoreEntry is one bill's award.
type ScoreEntry struct {
	Day       int
	EventID   string
	InvoiceID string
	PaidAt    time.Time
	Period    string
	Points    int
	Source    string
}

// ScoreMoment is scoreMoment: a claim from when it was sent, desk cash from when
// the warden recorded it, anything else from when the money moved.
func ScoreMoment(e *ScoreEvent) *time.Time {
	first := func(ts ...*time.Time) *time.Time {
		for _, t := range ts {
			if t != nil {
				return t
			}
		}
		return nil
	}
	switch e.Source {
	case "RESIDENT_CLAIM":
		return first(e.CreatedAt, e.OccurredAt)
	case "CASH_ENTRY":
		return first(e.SettledAt, e.OccurredAt)
	}
	return first(e.OccurredAt, e.SettledAt)
}

// ScoreDay is scoreDay: the bill's first day is day 1, and so is paying before it.
func ScoreDay(start, at time.Time) int { return max(1, bs.DaysBetween(start, at)+1) }

func billStart(inv *ScoreInvoice) (time.Time, bool) {
	if inv.CoversFrom != nil {
		return *inv.CoversFrom, true
	}
	if inv.Period == nil {
		return time.Time{}, false
	}
	b, err := bs.PeriodBounds(*inv.Period)
	if err != nil {
		return time.Time{}, false
	}
	return b.Start, true
}

func scored(e *ScoreEvent) bool {
	if e.Status != "SETTLED" || e.Direction != "CREDIT" || e.ReversedBy != nil {
		return false
	}
	for _, s := range scoredSources {
		if s == e.Source {
			return true
		}
	}
	return false
}

// ScoreEntries is scoreEntries: one entry per monthly bill, newest first.
func ScoreEntries(invoices []ScoreInvoice, events []ScoreEvent) []ScoreEntry {
	byID := map[bson.ObjectID]*ScoreInvoice{}
	for i := range invoices {
		if invoices[i].Kind == "MONTHLY_RENT" {
			byID[invoices[i].ID] = &invoices[i]
		}
	}
	best := map[bson.ObjectID]ScoreEntry{}
	for i := range events {
		e := &events[i]
		if e.InvoiceID == nil || !scored(e) {
			continue
		}
		inv := byID[*e.InvoiceID]
		at := ScoreMoment(e)
		if inv == nil || at == nil {
			continue
		}
		start, ok := billStart(inv)
		if !ok {
			continue
		}
		if cur, seen := best[inv.ID]; seen && !cur.PaidAt.After(*at) {
			continue
		}
		day := ScoreDay(start, *at)
		period := ""
		if inv.Period != nil {
			period = *inv.Period
		}
		best[inv.ID] = ScoreEntry{Day: day, EventID: e.ID.Hex(), InvoiceID: inv.ID.Hex(), PaidAt: *at, Period: period, Points: PointsForDay(day), Source: e.Source}
	}
	out := make([]ScoreEntry, 0, len(best))
	for _, v := range best {
		out = append(out, v)
	}
	sort.SliceStable(out, func(a, b int) bool { return out[a].PaidAt.After(out[b].PaidAt) })
	return out
}

// ClaimCounts is claimCounts (B3): claims sent, and claims settled and standing.
func ClaimCounts(events []ScoreEvent) (approved, shared int) {
	for i := range events {
		e := &events[i]
		if e.Source != "RESIDENT_CLAIM" || e.Direction != "CREDIT" {
			continue
		}
		shared++
		if e.Status == "SETTLED" && e.ReversedBy == nil {
			approved++
		}
	}
	return approved, shared
}

func scoreData(ctx context.Context, db *mongo.Database, residents []bson.ObjectID, invoice ...bson.ObjectID) ([]ScoreEvent, []ScoreInvoice, error) {
	filter := bson.D{{Key: "direction", Value: "CREDIT"}, {Key: "residentId", Value: bson.D{{Key: "$in", Value: residents}}}, {Key: "source", Value: bson.D{{Key: "$in", Value: scoredSources}}}}
	if len(invoice) > 0 {
		filter = append(filter, bson.E{Key: "invoiceId", Value: invoice[0]})
	}
	cur, err := db.Collection("paymentevents").Find(ctx, filter,
		options.Find().SetProjection(bson.D{{Key: "createdAt", Value: 1}, {Key: "direction", Value: 1}, {Key: "invoiceId", Value: 1}, {Key: "occurredAt", Value: 1}, {Key: "residentId", Value: 1},
			{Key: "reversedByEventId", Value: 1}, {Key: "settledAt", Value: 1}, {Key: "source", Value: 1}, {Key: "status", Value: 1}}))
	if err != nil {
		return nil, nil, err
	}
	var events []ScoreEvent
	if err := cur.All(ctx, &events); err != nil {
		return nil, nil, err
	}
	seen := map[bson.ObjectID]bool{}
	ids := bson.A{}
	for _, e := range events {
		if e.InvoiceID != nil && !seen[*e.InvoiceID] {
			seen[*e.InvoiceID] = true
			ids = append(ids, *e.InvoiceID)
		}
	}
	var invoices []ScoreInvoice
	if len(ids) > 0 {
		cur, err := db.Collection("invoices").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "kind", Value: "MONTHLY_RENT"}},
			options.Find().SetProjection(bson.D{{Key: "coversFrom", Value: 1}, {Key: "kind", Value: 1}, {Key: "period", Value: 1}}))
		if err != nil {
			return nil, nil, err
		}
		if err := cur.All(ctx, &invoices); err != nil {
			return nil, nil, err
		}
	}
	return events, invoices, nil
}

// CreditScoreHistory is one history row of CreditScore.
type CreditScoreHistory struct {
	Day       int    `json:"day"`
	InvoiceID string `json:"invoiceId"`
	PaidAt    string `json:"paidAt"`
	Period    string `json:"period"`
	Points    int    `json:"points"`
	Source    string `json:"source"`
}

// CreditScore is the response of /resident/credit-score and
// /hostel-admin/residents/:id/credit-score.
type CreditScore struct {
	Approved    int                  `json:"approved"`
	History     []CreditScoreHistory `json:"history"`
	PaymentCode *string              `json:"paymentCode"`
	Rules       []ScoreRule          `json:"rules"`
	Score       int                  `json:"score"`
	Shared      int                  `json:"shared"`
}

// CreditScoreOf builds one resident's CreditScore; paymentCode is filled by the caller.
func CreditScoreOf(ctx context.Context, db *mongo.Database, resident bson.ObjectID, paymentCode *string) (*CreditScore, error) {
	events, invoices, err := scoreData(ctx, db, []bson.ObjectID{resident})
	if err != nil {
		return nil, err
	}
	entries := ScoreEntries(invoices, events)
	approved, shared := ClaimCounts(events)
	out := &CreditScore{Approved: approved, History: []CreditScoreHistory{}, PaymentCode: paymentCode, Rules: ScoreRules, Shared: shared}
	for _, x := range entries {
		out.Score += x.Points
		out.History = append(out.History, CreditScoreHistory{Day: x.Day, InvoiceID: x.InvoiceID, PaidAt: httpx.ISO(x.PaidAt), Period: x.Period, Points: x.Points, Source: x.Source})
	}
	return out, nil
}

// PointsEarnedBy is pointsEarnedBy (todo C3): what this settlement earned, 0 when an
// earlier payment on the bill already did.
func PointsEarnedBy(ctx context.Context, db *mongo.Database, resident, invoice, event bson.ObjectID) int {
	events, invoices, err := scoreData(ctx, db, []bson.ObjectID{resident}, invoice)
	if err != nil {
		return 0
	}
	for _, x := range ScoreEntries(invoices, events) {
		if x.EventID == event.Hex() {
			return x.Points
		}
	}
	return 0
}

// CreditScoresFor is creditScoresFor (D4): scores for many residents at once.
func CreditScoresFor(ctx context.Context, db *mongo.Database, residents []bson.ObjectID) (map[bson.ObjectID]int, error) {
	scores := map[bson.ObjectID]int{}
	if len(residents) == 0 {
		return scores, nil
	}
	events, invoices, err := scoreData(ctx, db, residents)
	if err != nil {
		return nil, err
	}
	by := map[bson.ObjectID][]ScoreEvent{}
	for _, e := range events {
		by[e.ResidentID] = append(by[e.ResidentID], e)
	}
	for id, list := range by {
		for _, x := range ScoreEntries(invoices, list) {
			scores[id] += x.Points
		}
	}
	return scores, nil
}
