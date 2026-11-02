package movechecklist

import (
	"context"
	"errors"
	"math"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/ledger"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// Money is move-out-money.ts: what a move-out does to the bills.
type Money struct {
	DB     *mongo.Database
	Ledger *ledger.Engine
	Audit  *audit.Log
}

// Resident is the part of a resident the money rules read.
type Resident struct {
	ID           bson.ObjectID `bson:"_id"`
	BillingCycle *string       `bson:"billingCycle"`
	HostelID     bson.ObjectID `bson:"hostelId"`
	MoveInDate   *time.Time    `bson:"moveInDate"`
}

func (r Resident) billable() *finance.Billable {
	return &finance.Billable{ID: r.ID, BillingCycle: r.BillingCycle, MoveInDate: r.MoveInDate}
}

const dayMs = int64(24 * 60 * 60 * 1000)

func dayNumber(t time.Time) int64 { return int64(math.Floor(float64(t.UnixMilli()) / float64(dayMs))) }

var unsettled = bson.A{"OPEN", "PARTIAL", "OVERDUE"}

// MoveOutDay is moveOutDay: the given YYYY-MM-DD, else today.
func MoveOutDay(input string) time.Time {
	if input == "" {
		return bs.Today(time.Now())
	}
	t, err := time.Parse("2006-01-02", input)
	if err != nil {
		return bs.Today(time.Now())
	}
	return t
}

// DefaultLastMonthCharge is defaultLastMonthCharge.
func (m *Money) DefaultLastMonthCharge(ctx context.Context, hostel bson.ObjectID) (string, error) {
	var s struct {
		Charge *string `bson:"moveOutCharge"`
	}
	err := m.DB.Collection("hostelsettings").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "moveOutCharge", Value: 1}})).Decode(&s)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return "", err
	}
	if s.Charge == nil {
		return "TILL_DAY", nil
	}
	return *s.Charge, nil
}

type bill struct {
	ID     bson.ObjectID `bson:"_id"`
	Kind   string        `bson:"kind"`
	Lines  []billLine    `bson:"lines"`
	Period *string       `bson:"period"`
	Status string        `bson:"status"`
	Total  float64       `bson:"totalAmount"`
}

type billLine struct {
	Adjust string  `bson:"adjust"`
	Amount float64 `bson:"amount"`
	Basis  string  `bson:"basis"`
}

func (m *Money) settledOn(ctx context.Context, ids bson.A) (map[bson.ObjectID]float64, error) {
	out := map[bson.ObjectID]float64{}
	if len(ids) == 0 {
		return out, nil
	}
	cur, err := m.DB.Collection("invoicebalances").Find(ctx, bson.D{{Key: "invoiceId", Value: bson.D{{Key: "$in", Value: ids}}}},
		options.Find().SetProjection(bson.D{{Key: "invoiceId", Value: 1}, {Key: "settledAmount", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		InvoiceID bson.ObjectID `bson:"invoiceId"`
		Settled   float64       `bson:"settledAmount"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.InvoiceID] = r.Settled
	}
	return out, nil
}

func rentOf(b bill) float64 {
	var sum float64
	for _, l := range b.Lines {
		if (l.Basis == "SCHEDULE" || l.Basis == "OVERRIDE" || l.Basis == "MANUAL") && l.Adjust == "" {
			sum += l.Amount
		}
	}
	return sum
}

// Days is stayDays: the days billed in the leaving month, and how many of them were stayed.
type Days struct{ Billed, Stayed, DaysInMonth int64 }

// StayDays is stayDays.
func StayDays(r Resident, period string, moveOut time.Time) (Days, error) {
	b, err := finance.ResidentBounds(r.billable(), period)
	if err != nil {
		return Days{}, err
	}
	from := b.Start
	if r.MoveInDate != nil {
		if j := bs.CalendarDay(*r.MoveInDate); j.After(b.Start) {
			from = j
		}
	}
	billed := max(dayNumber(b.LastDay)-dayNumber(from)+1, 0)
	stayed := min(max(dayNumber(moveOut)-dayNumber(from)+1, 0), billed)
	return Days{billed, stayed, int64(b.DaysInMonth)}, nil
}

// UnusedDaysCut is unusedDaysCut.
func UnusedDaysCut(rent float64, billed, stayed int64) float64 {
	if billed <= 0 || stayed >= billed {
		return 0
	}
	return rent - math.Floor(rent*float64(stayed)/float64(billed)+0.5)
}

func (m *Money) rentBills(ctx context.Context, r Resident) ([]bill, error) {
	cur, err := m.DB.Collection("invoices").Find(ctx, bson.D{{Key: "hostelId", Value: r.HostelID}, {Key: "kind", Value: "MONTHLY_RENT"}, {Key: "residentId", Value: r.ID}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "VOID"}}}},
		options.Find().SetProjection(bson.D{{Key: "kind", Value: 1}, {Key: "lines", Value: 1}, {Key: "period", Value: 1}, {Key: "status", Value: 1}, {Key: "totalAmount", Value: 1}}).SetLimit(600))
	if err != nil {
		return nil, err
	}
	var rows []bill
	return rows, cur.All(ctx, &rows)
}

func ids(bills []bill) bson.A {
	out := bson.A{}
	for _, b := range bills {
		out = append(out, b.ID)
	}
	return out
}

// Outstanding is outstandingForResident: what is still owed on the live bills.
func (m *Money) Outstanding(ctx context.Context, hostel, resident bson.ObjectID) (float64, error) {
	cur, err := m.DB.Collection("invoices").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "residentId", Value: resident}, {Key: "status", Value: bson.D{{Key: "$in", Value: unsettled}}}},
		options.Find().SetProjection(bson.D{{Key: "totalAmount", Value: 1}}).SetLimit(2000))
	if err != nil {
		return 0, err
	}
	var rows []bill
	if err := cur.All(ctx, &rows); err != nil {
		return 0, err
	}
	paid, err := m.settledOn(ctx, ids(rows))
	if err != nil {
		return 0, err
	}
	var sum float64
	for _, b := range rows {
		sum += math.Max(b.Total-paid[b.ID], 0)
	}
	return sum, nil
}

// Pair is a figure for each last-month choice.
type Pair struct {
	FullMonth float64 `json:"FULL_MONTH"`
	TillDay   float64 `json:"TILL_DAY"`
}

// Preview is previewMoveOut's answer.
func (m *Money) Preview(ctx context.Context, r Resident, owedNow float64, dateInput string) (ordered.Map, error) {
	moveOut := MoveOutDay(dateInput)
	period, err := finance.ResidentPeriodOf(r.billable(), moveOut)
	if err != nil {
		return nil, err
	}
	bills, err := m.rentBills(ctx, r)
	if err != nil {
		return nil, err
	}
	settled, err := m.settledOn(ctx, ids(bills))
	if err != nil {
		return nil, err
	}
	days, err := StayDays(r, period, moveOut)
	if err != nil {
		return nil, err
	}
	owing := func(b bill) float64 { return math.Max(b.Total-settled[b.ID], 0) }
	var laterOwed, laterPaid float64
	var leaving *bill
	for i, b := range bills {
		if b.Period != nil && *b.Period > period {
			laterOwed += owing(b)
			laterPaid += settled[b.ID]
		}
		if b.Period != nil && *b.Period == period && leaving == nil {
			leaving = &bills[i]
		}
	}
	var rent, cut, leavingOwed, leavingFull, leavingSettled float64
	if leaving != nil {
		rent = rentOf(*leaving)
		cut = UnusedDaysCut(rent, days.Billed, days.Stayed)
		leavingOwed = owing(*leaving)
		for _, l := range leaving.Lines {
			if l.Adjust != "MOVE_OUT" {
				leavingFull += l.Amount
			}
		}
		leavingSettled = settled[leaving.ID]
	}
	after := func(tillDay bool) (owed, paidBack float64) {
		if leaving == nil {
			return owedNow - laterOwed, laterPaid
		}
		total := leavingFull
		if tillDay {
			total = leavingFull - cut
		}
		owedHere := math.Max(total-leavingSettled, 0)
		return owedNow - laterOwed - leavingOwed + owedHere, laterPaid + math.Max(leavingSettled-total, 0)
	}
	fullOwed, fullBack := after(false)
	dayOwed, dayBack := after(true)
	charge, err := m.DefaultLastMonthCharge(ctx, r.HostelID)
	if err != nil {
		return nil, err
	}
	var last any
	if leaving != nil {
		last = Pair{rent, rent - cut}
	}
	label := bs.FormatPeriod(period)
	if label == "" {
		label = period
	}
	return ordered.Map{
		{Key: "billedDays", Value: days.Billed}, {Key: "date", Value: moveOut.UTC().Format("2006-01-02")}, {Key: "dateLabel", Value: bs.FormatDate(moveOut)},
		{Key: "defaultCharge", Value: charge}, {Key: "lastMonth", Value: last},
		{Key: "owedAfter", Value: Pair{math.Max(fullOwed, 0), math.Max(dayOwed, 0)}}, {Key: "paidBack", Value: Pair{fullBack, dayBack}},
		{Key: "periodLabel", Value: label}, {Key: "stayed", Value: days.Stayed},
	}, nil
}

// voidQuietly is voidQuietly: the bill is withdrawn, its khata freed, the audit chain told.
func (m *Money) voidQuietly(ctx context.Context, b bill, hostel bson.ObjectID, reason string, p *authz.Principal) error {
	by := userID(p)
	at := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := m.DB.Collection("invoices").UpdateOne(ctx, bson.D{{Key: "_id", Value: b.ID}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "VOID"}}}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "VOID"}, {Key: "updatedBy", Value: by}, {Key: "voidReason", Value: reason}, {Key: "voidedAt", Value: at}, {Key: "voidedBy", Value: by}, {Key: "updatedAt", Value: at}}}}); err != nil {
		return err
	}
	if _, err := m.DB.Collection("khataentries").UpdateMany(ctx, bson.D{{Key: "invoiceId", Value: b.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "invoiceId", Value: nil}, {Key: "updatedAt", Value: at}}}}); err != nil {
		return err
	}
	return m.Audit.WriteFinance(ctx, by, string(p.Role), audit.Finance{Action: "INVOICE_VOIDED", AmountBefore: int64(b.Total), EntityID: b.ID.Hex(), EntityType: "Invoice", HostelID: hostel,
		InvoiceID: b.ID.Hex(), Reason: reason, Source: "MOVE_OUT"})
}

func userID(p *authz.Principal) bson.ObjectID {
	id, _ := bson.ObjectIDFromHex(p.UserID)
	return id
}

// clearBill is clearBill: nothing paid, the bill goes; something paid, it is cut to what was paid.
func (m *Money) clearBill(ctx context.Context, b bill, hostel bson.ObjectID, kind, description string, settled float64, p *authz.Principal) error {
	if settled <= 0 {
		return m.voidQuietly(ctx, b, hostel, description, p)
	}
	var takeOff float64
	if kind == "WRITE_OFF" {
		takeOff = math.Max(b.Total-settled, 0)
	} else {
		for _, l := range b.Lines {
			if l.Adjust != kind {
				takeOff += l.Amount
			}
		}
	}
	_, _, _, _, err := m.Ledger.SetAdjustment(ctx, b.ID, kind, description, int64(takeOff), p)
	return err
}

// SettleLeavingMonth is settleLeavingMonth: the leaving month cut to the days
// stayed, every later bill cleared.
func (m *Money) SettleLeavingMonth(ctx context.Context, r Resident, moveOut time.Time, charge string, p *authz.Principal) error {
	period, err := finance.ResidentPeriodOf(r.billable(), moveOut)
	if err != nil {
		return err
	}
	label := bs.FormatDate(moveOut)
	if label == "" {
		label = moveOut.UTC().Format("2006-01-02")
	}
	bills, err := m.rentBills(ctx, r)
	if err != nil {
		return err
	}
	has := func() bool {
		for _, b := range bills {
			if b.Period != nil && *b.Period == period {
				return true
			}
		}
		return false
	}
	if !has() {
		// The month was never billed: bill it now so there is something to cut. Best effort, as TS.
		_, _ = m.Ledger.RunBillingCycle(ctx, ledger.BillingInput{HostelID: r.HostelID, Period: period, ResidentIDs: bson.A{r.ID}}, p)
		if bills, err = m.rentBills(ctx, r); err != nil {
			return err
		}
	}
	settled, err := m.settledOn(ctx, ids(bills))
	if err != nil {
		return err
	}
	for _, b := range bills {
		if b.Period != nil && *b.Period == period {
			days, err := StayDays(r, period, moveOut)
			if err != nil {
				return err
			}
			var cut float64
			if charge == "TILL_DAY" {
				cut = UnusedDaysCut(rentOf(b), days.Billed, days.Stayed)
			}
			if _, _, _, _, err := m.Ledger.SetAdjustment(ctx, b.ID, "MOVE_OUT", "Moved out "+label+" — "+itoa(days.Billed-days.Stayed)+" days not charged", int64(cut), p); err != nil {
				return err
			}
			break
		}
	}
	for _, b := range bills {
		if b.Period != nil && *b.Period > period {
			if err := m.clearBill(ctx, b, r.HostelID, "MOVE_OUT", "Moved out "+label+" — no rent after that", settled[b.ID], p); err != nil {
				return err
			}
		}
	}
	return nil
}

// WriteOffDues is writeOffDues: every unsettled bill of a resident cleared. Returns what was written off.
func (m *Money) WriteOffDues(ctx context.Context, r Resident, p *authz.Principal, reason string) (float64, error) {
	cur, err := m.DB.Collection("invoices").Find(ctx, bson.D{{Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}, {Key: "status", Value: bson.D{{Key: "$in", Value: unsettled}}}},
		options.Find().SetProjection(bson.D{{Key: "kind", Value: 1}, {Key: "lines", Value: 1}, {Key: "period", Value: 1}, {Key: "status", Value: 1}, {Key: "totalAmount", Value: 1}}).SetLimit(2000))
	if err != nil {
		return 0, err
	}
	var open []bill
	if err := cur.All(ctx, &open); err != nil {
		return 0, err
	}
	settled, err := m.settledOn(ctx, ids(open))
	if err != nil {
		return 0, err
	}
	var written float64
	for _, b := range open {
		paid := settled[b.ID]
		written += math.Max(b.Total-paid, 0)
		if err := m.clearBill(ctx, b, r.HostelID, "WRITE_OFF", reason, paid, p); err != nil {
			return written, err
		}
	}
	return written, nil
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
