package finance

// The matching ladder: where a credit on a statement belongs (matching/ in the TS
// server). Tier B is a reference code that names one open invoice; C is a resident's
// claim of that transaction or a scored suggestion the owner confirms; D is orphan money.

import (
	"context"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/money"
)

// Candidate is an open invoice a credit could belong to.
type Candidate struct {
	BedLabel      string
	DueDate       *time.Time
	InvoiceID     string
	Outstanding   int64
	Period        string
	ReferenceCode *string
	ResidentID    string
	ResidentName  string
	TotalAmount   int64
}

// Suggestion is a scored candidate.
type Suggestion struct {
	Candidate  *Candidate
	Confidence string
	Score      int
	Why        string
}

var signalWeights = map[string]int{"AMOUNT_CLOSE": 12, "AMOUNT_EXACT": 34, "NAME_EXACT": 30, "NAME_SIMILAR": 20, "REFERENCE_SAME_INVOICE": 60, "REFERENCE_SAME_RESIDENT": 40, "TIME_NEAR_DUE": 8}

type scoreIn struct {
	amount     int64
	name       string
	occurredAt time.Time
	refInvoice string
	refRes     string
	hasRef     bool
}

func scoreCandidate(in scoreIn, c *Candidate) *Suggestion {
	var sig []string
	if in.hasRef {
		if in.refInvoice == c.InvoiceID {
			sig = append(sig, "REFERENCE_SAME_INVOICE")
		} else if in.refRes == c.ResidentID {
			sig = append(sig, "REFERENCE_SAME_RESIDENT")
		}
	}
	if in.amount == c.Outstanding {
		sig = append(sig, "AMOUNT_EXACT")
	} else if tol := max(100, int64(math.Round(float64(c.Outstanding)*0.02))); matchAbs(in.amount-c.Outstanding) <= tol {
		sig = append(sig, "AMOUNT_CLOSE")
	}
	if ns := matchNameSimilarity(in.name, c.ResidentName); ns >= 0.95 {
		sig = append(sig, "NAME_EXACT")
	} else if ns >= 0.6 {
		sig = append(sig, "NAME_SIMILAR")
	}
	if c.DueDate != nil && math.Abs(float64(in.occurredAt.Sub(*c.DueDate)))/float64(24*time.Hour) <= 10 {
		sig = append(sig, "TIME_NEAR_DUE")
	}
	identity, score := false, 0
	for _, s := range sig {
		score += signalWeights[s]
		identity = identity || s == "NAME_EXACT" || s == "NAME_SIMILAR" || s == "REFERENCE_SAME_INVOICE" || s == "REFERENCE_SAME_RESIDENT"
	}
	if !identity || score < 30 {
		return nil
	}
	conf := "LOW"
	if score >= 60 {
		conf = "HIGH"
	} else if score >= 42 {
		conf = "MEDIUM"
	}
	return &Suggestion{Candidate: c, Confidence: conf, Score: score, Why: explainMatch(c, sig)}
}

func matchAbs(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

func explainMatch(c *Candidate, sig []string) string {
	has := func(s string) bool {
		for _, x := range sig {
			if x == s {
				return true
			}
		}
		return false
	}
	var p []string
	if has("REFERENCE_SAME_INVOICE") {
		p = append(p, "carries this invoice's reference code")
	} else if has("REFERENCE_SAME_RESIDENT") {
		p = append(p, "used a reference code for another of their invoices")
	}
	if has("NAME_EXACT") {
		p = append(p, "name matches")
	} else if has("NAME_SIMILAR") {
		p = append(p, "name similar")
	}
	if has("AMOUNT_EXACT") {
		p = append(p, "owes exactly this amount")
	} else if has("AMOUNT_CLOSE") {
		p = append(p, "owes "+money.GroupIN(c.Outstanding))
	}
	if has("TIME_NEAR_DUE") {
		p = append(p, "paid around the due date")
	}
	reason := ""
	if len(p) > 0 {
		reason = " — " + strings.Join(p, ", ")
	}
	return "matches " + c.ResidentName + reason
}

func rankCandidates(in scoreIn, cs []*Candidate) []*Suggestion {
	var out []*Suggestion
	for _, c := range cs {
		if s := scoreCandidate(in, c); s != nil {
			out = append(out, s)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Score != b.Score {
			return a.Score > b.Score
		}
		if x, y := strings.ToLower(a.Candidate.ResidentName), strings.ToLower(b.Candidate.ResidentName); x != y {
			return x < y
		}
		return a.Candidate.InvoiceID < b.Candidate.InvoiceID
	})
	return out[:min(len(out), 3)]
}

var matchNameJunk = regexp.MustCompile(`[^A-Z\s]`)

func matchNameTokens(s string) []string {
	return strings.Fields(matchNameJunk.ReplaceAllString(strings.ToUpper(s), " "))
}

func matchLevenshtein(a, b string) int {
	prev := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur := make([]int, len(b)+1)
		cur[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev = cur
	}
	return prev[len(b)]
}

func matchTokenScore(l, r string) float64 {
	if l == r {
		return 1
	}
	if len(l) == 1 && strings.HasPrefix(r, l) || len(r) == 1 && strings.HasPrefix(l, r) {
		return 0.55
	}
	longest := max(len(l), len(r))
	ratio := 1.0
	if longest != 0 {
		ratio = 1 - float64(matchLevenshtein(l, r))/float64(longest)
	}
	if ratio >= 0.8 {
		return ratio
	}
	return 0
}

func matchNameSimilarity(left, right string) float64 {
	a, b := matchNameTokens(left), matchNameTokens(right)
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	shorter, longer := a, b
	if len(a) > len(b) {
		shorter, longer = b, a
	}
	rest := append([]string(nil), longer...)
	total := 0.0
	for _, t := range shorter {
		best, at := 0.0, -1
		for i, o := range rest {
			if s := matchTokenScore(t, o); s > best {
				best, at = s, i
			}
		}
		if at >= 0 {
			rest = append(rest[:at], rest[at+1:]...)
			total += best
		}
	}
	return total / float64(len(shorter))
}

// ---- the ladder ----

// Claim is a resident's own claim of a transfer.
type Claim struct {
	Amount          int64
	EventID         string
	InvoiceID       string
	Period          *string
	ResidentID      string
	ResidentName    string
	Settled         bool
	SubmittedAt     time.Time
	TransactionCode string
}

// MatchContext is what a statement is classified against.
type MatchContext struct {
	Claims        []*Claim
	ClaimsByTxn   map[string]*Claim
	InvoicesByRef map[string]*Candidate
	Open          []*Candidate
}

// Classification is CreditClassification: Tier is B, C or D.
type Classification struct {
	Claim       *Claim
	Invoice     *Candidate
	Suggestions []*Suggestion
	Tier        string
	Why         string
}

// NormalizeTxnID strips a transaction id to upper-case letters and digits.
func NormalizeTxnID(v string) string { return stmtUpperAlnum.ReplaceAllString(strings.ToUpper(v), "") }

var stmtUpperAlnum = regexp.MustCompile(`[^A-Z0-9]`)

func deref0(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// ClassifyCredit puts one statement credit on the ladder.
func ClassifyCredit(row *StmtRow, ctx *MatchContext) Classification {
	codes := ExtractReferenceCodes(deref0(row.Remarks))
	codes = append(codes, ExtractReferenceCodes(deref0(row.CounterpartyName))...)
	var refd []*Candidate
	for _, c := range codes {
		if inv, ok := ctx.InvoicesByRef[c]; ok {
			refd = append(refd, inv)
		}
	}
	var referenced *Candidate
	if len(refd) == 1 {
		referenced = refd[0]
	}
	if referenced != nil && row.Amount <= referenced.Outstanding {
		return Classification{Invoice: referenced, Tier: "B", Why: "reference " + *referenced.ReferenceCode + " — " + referenced.ResidentName + ", " + referenced.Period}
	}
	if cl, ok := ctx.ClaimsByTxn[NormalizeTxnID(row.ProviderTxnID)]; ok {
		why := cl.ResidentName + " claimed this exact transaction"
		if cl.Amount != row.Amount {
			why += ", but for " + money.GroupIN(cl.Amount)
		}
		return Classification{Claim: cl, Suggestions: []*Suggestion{}, Tier: "C", Why: why}
	}
	in := scoreIn{amount: row.Amount, name: deref0(row.CounterpartyName), occurredAt: row.OccurredAt}
	if referenced != nil {
		in.hasRef, in.refInvoice, in.refRes = true, referenced.InvoiceID, referenced.ResidentID
	}
	if sg := rankCandidates(in, ctx.Open); len(sg) > 0 {
		return Classification{Suggestions: sg, Tier: "C", Why: sg[0].Why}
	}
	why := "no reference, no claim, no close match"
	if row.CounterpartyName != nil && *row.CounterpartyName != "" {
		why = `from "` + *row.CounterpartyName + `" — ` + why
	}
	return Classification{Tier: "D", Why: why}
}

// OrphanClaim is a claim whose transaction the statement does not show.
type OrphanClaim struct {
	Claim *Claim
	Why   string
}

var enGBMonths = [...]string{"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"}

// FindOrphanClaims is findOrphanClaims.
func FindOrphanClaims(ctx *MatchContext, rows []StmtRow, periodEnd *time.Time) []OrphanClaim {
	seen := map[string]bool{}
	for _, r := range rows {
		seen[NormalizeTxnID(r.ProviderTxnID)] = true
	}
	var out []OrphanClaim
	for _, cl := range ctx.Claims {
		if seen[NormalizeTxnID(cl.TransactionCode)] || periodEnd != nil && cl.SubmittedAt.After(*periodEnd) {
			continue
		}
		var near *StmtRow
		gap := int64(math.MaxInt64)
		for i := range rows {
			if rows[i].Direction != "CREDIT" {
				continue
			}
			if g := matchAbs(rows[i].Amount - cl.Amount); g < gap {
				gap, near = g, &rows[i]
			}
		}
		why := "claims " + money.GroupIN(cl.Amount)
		if near != nil {
			why += " — closest real credit is " + money.GroupIN(near.Amount) + " on " + strconv.Itoa(near.OccurredAt.Day()) + " " + enGBMonths[near.OccurredAt.Month()-1]
		} else {
			if cl.TransactionCode != "" {
				why += ", txn " + cl.TransactionCode
			}
			why += " — not in this statement"
		}
		out = append(out, OrphanClaim{Claim: cl, Why: why})
	}
	return out
}

type invoiceRow struct {
	ID            bson.ObjectID `bson:"_id"`
	DueDate       *time.Time    `bson:"dueDate"`
	Period        *string       `bson:"period"`
	ReferenceCode *string       `bson:"referenceCode"`
	ResidentID    bson.ObjectID `bson:"residentId"`
	TotalAmount   int64         `bson:"totalAmount"`
}

// LoadMatchContext is loadMatchContext.
func LoadMatchContext(ctx context.Context, db *mongo.Database, hostel bson.ObjectID) (*MatchContext, error) {
	cur, err := db.Collection("invoices").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"OPEN", "PARTIAL", "OVERDUE"}}}}},
		options.Find().SetProjection(bson.D{{Key: "dueDate", Value: 1}, {Key: "period", Value: 1}, {Key: "referenceCode", Value: 1}, {Key: "residentId", Value: 1}, {Key: "totalAmount", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var invoices []invoiceRow
	if err := cur.All(ctx, &invoices); err != nil {
		return nil, err
	}
	type claimRow struct {
		ID         bson.ObjectID  `bson:"_id"`
		Amount     int64          `bson:"amount"`
		CreatedAt  *time.Time     `bson:"createdAt"`
		InvoiceID  *bson.ObjectID `bson:"invoiceId"`
		OccurredAt time.Time      `bson:"occurredAt"`
		Raw        struct {
			Code *string `bson:"transactionCode"`
		} `bson:"rawPayload"`
		ResidentID *bson.ObjectID `bson:"residentId"`
		Status     string         `bson:"status"`
	}
	cur, err = db.Collection("paymentevents").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "source", Value: "RESIDENT_CLAIM"},
		{Key: "$or", Value: bson.A{bson.D{{Key: "status", Value: "PENDING"}}, bson.D{{Key: "confirmation", Value: "MANUAL_REVIEW"}, {Key: "status", Value: "SETTLED"}}}}},
		options.Find().SetProjection(bson.D{{Key: "amount", Value: 1}, {Key: "confirmation", Value: 1}, {Key: "createdAt", Value: 1}, {Key: "invoiceId", Value: 1}, {Key: "occurredAt", Value: 1}, {Key: "rawPayload", Value: 1}, {Key: "residentId", Value: 1}, {Key: "status", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var claimEvents []claimRow
	if err := cur.All(ctx, &claimEvents); err != nil {
		return nil, err
	}
	var rids bson.A
	for _, i := range invoices {
		rids = append(rids, i.ResidentID)
	}
	for _, c := range claimEvents {
		if c.ResidentID != nil {
			rids = append(rids, *c.ResidentID)
		}
	}
	var ids bson.A
	for _, i := range invoices {
		ids = append(ids, i.ID)
	}
	names, beds := map[string]string{}, map[string]string{}
	if len(rids) > 0 {
		cur, err = db.Collection("residents").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: rids}}}}, options.Find().SetProjection(bson.D{{Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}, {Key: "roomNumber", Value: 1}, {Key: "roomType", Value: 1}}))
		if err != nil {
			return nil, err
		}
		var rs []struct {
			ID         bson.ObjectID `bson:"_id"`
			First      string        `bson:"firstName"`
			Last       string        `bson:"lastName"`
			RoomNumber string        `bson:"roomNumber"`
			RoomType   string        `bson:"roomType"`
		}
		if err := cur.All(ctx, &rs); err != nil {
			return nil, err
		}
		for _, r := range rs {
			var n, b []string
			for _, s := range []string{r.First, r.Last} {
				if s != "" {
					n = append(n, s)
				}
			}
			if r.RoomType != "" {
				b = append(b, r.RoomType)
			}
			if r.RoomNumber != "" {
				b = append(b, "room "+r.RoomNumber)
			}
			names[r.ID.Hex()], beds[r.ID.Hex()] = strings.TrimSpace(strings.Join(n, " ")), strings.Join(b, " · ")
		}
	}
	settled := map[string]int64{}
	if len(ids) > 0 {
		cur, err = db.Collection("invoicebalances").Find(ctx, bson.D{{Key: "invoiceId", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "invoiceId", Value: 1}, {Key: "settledAmount", Value: 1}}))
		if err != nil {
			return nil, err
		}
		var bs []struct {
			InvoiceID bson.ObjectID `bson:"invoiceId"`
			Settled   int64         `bson:"settledAmount"`
		}
		if err := cur.All(ctx, &bs); err != nil {
			return nil, err
		}
		for _, b := range bs {
			settled[b.InvoiceID.Hex()] = b.Settled
		}
	}
	mc := &MatchContext{ClaimsByTxn: map[string]*Claim{}, InvoicesByRef: map[string]*Candidate{}}
	periods := map[string]string{}
	for _, i := range invoices {
		c := &Candidate{BedLabel: beds[i.ResidentID.Hex()], DueDate: i.DueDate, InvoiceID: i.ID.Hex(), Outstanding: max(0, i.TotalAmount-settled[i.ID.Hex()]), ReferenceCode: i.ReferenceCode, ResidentID: i.ResidentID.Hex(), TotalAmount: i.TotalAmount}
		if i.Period != nil {
			c.Period = *i.Period
		}
		if c.ResidentName = names[c.ResidentID]; c.ResidentName == "" {
			if _, known := names[c.ResidentID]; !known {
				c.ResidentName = "Unknown resident"
			}
		}
		periods[c.InvoiceID] = c.Period
		mc.Open = append(mc.Open, c)
		if i.ReferenceCode != nil && *i.ReferenceCode != "" {
			mc.InvoicesByRef[*i.ReferenceCode] = c
		}
	}
	for _, e := range claimEvents {
		cl := &Claim{Amount: e.Amount, EventID: e.ID.Hex(), Settled: e.Status == "SETTLED", SubmittedAt: e.OccurredAt, TransactionCode: deref0(e.Raw.Code), ResidentName: "Unknown resident"}
		if e.CreatedAt != nil {
			cl.SubmittedAt = *e.CreatedAt
		}
		if e.InvoiceID != nil {
			cl.InvoiceID = e.InvoiceID.Hex()
			if p, ok := periods[cl.InvoiceID]; ok {
				cl.Period = &p
			}
		}
		if e.ResidentID != nil {
			cl.ResidentID = e.ResidentID.Hex()
			if n, ok := names[cl.ResidentID]; ok {
				cl.ResidentName = n
			}
		}
		mc.Claims = append(mc.Claims, cl)
		if k := NormalizeTxnID(cl.TransactionCode); k != "" {
			mc.ClaimsByTxn[k] = cl
		}
	}
	return mc, nil
}
