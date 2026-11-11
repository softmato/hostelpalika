package financeadmin

import (
	"context"
	"errors"
	"golang.org/x/sync/errgroup"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/expenses"
	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

func (h *Handler) registerInvoices(v1 *gin.RouterGroup) {
	v1.GET("/hostel-admin/finance/invoices", h.invoiceMatrix)
	v1.GET("/hostel-admin/finance/invoices/ledger", h.hostelLedger)
	v1.GET("/hostel-admin/finance/invoices/periods", h.periodSummary)
	v1.GET("/hostel-admin/finance/residents/:residentId/ledger", httpx.ETag(), h.residentLedger)
}

func isoOrNil(t *time.Time) any {
	if t == nil {
		return nil
	}
	return httpx.ISO(*t)
}

// portalInvoice is toPortalInvoice: undefined fields are left out, as JSON drops them.
func portalInvoice(in *finance.LedgerInvoice) ordered.Map {
	m := ordered.Map{{Key: "dueAmount", Value: in.DueAmount}}
	if in.DueDate != nil {
		m = append(m, ordered.Pair{Key: "dueDate", Value: httpx.ISO(*in.DueDate)})
	}
	m = append(m, ordered.Pair{Key: "id", Value: in.ID})
	if in.Method != "" {
		m = append(m, ordered.Pair{Key: "method", Value: in.Method})
	}
	var month any
	if in.Period != nil {
		month = *in.Period
	}
	m = append(m, ordered.Pair{Key: "month", Value: month}, ordered.Pair{Key: "paidAmount", Value: in.PaidAmount})
	if in.PaidDate != nil {
		m = append(m, ordered.Pair{Key: "paidDate", Value: httpx.ISO(*in.PaidDate)})
	}
	return append(m, ordered.Pair{Key: "status", Value: in.Status})
}

func linesOut(lines []finance.LedgerLine) []finance.LedgerLine {
	if lines == nil {
		return []finance.LedgerLine{}
	}
	return lines
}

type matrixResident struct {
	finance.Billable `bson:",inline"`
	FirstName        string         `bson:"firstName"`
	LastName         string         `bson:"lastName"`
	PaidTill         *string        `bson:"paidTill"`
	Phone            *string        `bson:"phone"`
	RoomNumber       *string        `bson:"roomNumber"`
	UserID           *bson.ObjectID `bson:"userId"`
}

func (r *matrixResident) fullName() string {
	return trimSpace(r.FirstName + " " + r.LastName)
}

func trimSpace(s string) string { return valid.Trim(s) }

var residentFields = bson.D{{Key: "bedType", Value: 1}, {Key: "billingCycle", Value: 1}, {Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}, {Key: "monthlyFee", Value: 1}, {Key: "moveInDate", Value: 1},
	{Key: "moveOutDate", Value: 1}, {Key: "paidTill", Value: 1}, {Key: "phone", Value: 1}, {Key: "roomNumber", Value: 1}, {Key: "roomType", Value: 1}, {Key: "userId", Value: 1}}

// priceUnbilled is what a resident with no invoice this month would be billed, and why not yet.
func priceUnbilled(r *matrixResident, s *finance.Schedule, listed map[string]float64, period string, percentOff int64, today time.Time) ordered.Map {
	out := func(amount any, reason string) ordered.Map {
		return ordered.Map{{Key: "amount", Value: amount}, {Key: "reason", Value: reason}}
	}
	if finance.PaidBeforeJoining(r.PaidTill, period) {
		return out(int64(0), "PAID_BEFORE_JOINING")
	}
	fail := func(err error) ordered.Map {
		var e *httpx.Error
		if errors.As(err, &e) {
			return out(nil, e.ErrorCode)
		}
		return out(nil, "FEE_SCHEDULE_MISSING")
	}
	ch, err := finance.MonthlyCharge(&r.Billable, s, listed, percentOff)
	if err != nil {
		return fail(err)
	}
	b, err := finance.ResidentBounds(&r.Billable, period)
	if err != nil {
		return fail(err)
	}
	amt, err := finance.ComputeInvoiceAmount(ch.Amount, r.MoveInDate, r.MoveOutDate, b)
	if err != nil {
		return fail(err)
	}
	if amt.Amount <= 0 {
		reason := "NO_BILLABLE_DAYS"
		switch {
		case amt.NotResident:
			reason = "NOT_YET_RESIDENT"
		case amt.MovedOut:
			reason = "ALREADY_MOVED_OUT"
		case ch.Amount == 0:
			reason = "ZERO_CHARGE"
		}
		return out(int64(0), reason)
	}
	if finance.NotYetDue(&r.Billable, b, today) {
		return out(amt.Amount, "NOT_YET_DUE")
	}
	return out(amt.Amount, "NOT_YET_RUN")
}

var periodQueryRe = periodRe

func (h *Handler) invoiceMatrix(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "viewPayments")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	period, hasPeriod := q["period"]
	if hasPeriod && !periodQueryRe.MatchString(period) {
		is.Add("period", valid.Pattern(`/^\d{4}-(0[1-9]|1[0-2])$/`))
	}
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, requestedHostel(q))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if !hasPeriod {
		if period, err = bs.PeriodOf(time.Now()); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	key := "invoices"
	if raw := c.Request.URL.RawQuery; raw != "" {
		key += "?" + raw
	}
	cache.Respond(c, h.Cache, []string{hostel.Hex()}, p.UserID, key, "Invoices", func() (ordered.Map, error) {
		return h.matrix(c, hostel, period)
	})
}

// matrix is getInvoiceMatrix: every active resident against the month's invoice,
// with what the unbilled ones would owe.
func (h *Handler) matrix(ctx context.Context, hostel bson.ObjectID, period string) (ordered.Map, error) {
	b, err := bs.PeriodBounds(period)
	if err != nil {
		return nil, finance.Err("FEE_SCHEDULE_MISSING", err.Error())
	}
	// Six independent reads: one parallel wave instead of six round trips (P11-11).
	var (
		people   []matrixResident
		invoices []struct {
			ID         bson.ObjectID        `bson:"_id"`
			FineWaived bool                 `bson:"fineWaived"`
			Lines      []finance.LedgerLine `bson:"lines"`
			ResidentID bson.ObjectID        `bson:"residentId"`
		}
		schedule  *finance.Schedule
		hostelDoc struct {
			Rooms []bson.D `bson:"roomConfigurations"`
		}
		concession struct {
			PercentOff int64 `bson:"percentOff"`
		}
		balances []finance.LedgerInvoice
	)
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		cur, err := h.DB.Collection("residents").Find(gctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
			{Key: "$or", Value: bson.A{bson.D{{Key: "moveInDate", Value: bson.D{{Key: "$lte", Value: b.End}}}}, bson.D{{Key: "moveInDate", Value: nil}}, bson.D{{Key: "moveInDate", Value: bson.D{{Key: "$exists", Value: false}}}}}},
			{Key: "status", Value: "ACTIVE"}}, options.Find().SetProjection(residentFields))
		if err != nil {
			return err
		}
		return cur.All(gctx, &people)
	})
	g.Go(func() error {
		icur, err := h.DB.Collection("invoices").Find(gctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "period", Value: period}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "VOID"}}}})
		if err != nil {
			return err
		}
		return icur.All(gctx, &invoices)
	})
	g.Go(func() (err error) { schedule, err = finance.EffectiveSchedule(gctx, h.DB, hostel, period); return })
	g.Go(func() error {
		err := h.DB.Collection("hostels").FindOne(gctx, bson.D{{Key: "_id", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "roomConfigurations", Value: 1}})).Decode(&hostelDoc)
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil
		}
		return err
	})
	g.Go(func() error {
		err := h.DB.Collection("rentconcessions").FindOne(gctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "period", Value: period}}).Decode(&concession)
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil
		}
		return err
	})
	g.Go(func() (err error) {
		balances, err = finance.ListLedger(gctx, h.DB, finance.UnvoidedMatch(bson.D{{Key: "hostelId", Value: hostel}, {Key: "period", Value: period}}), bson.D{{Key: "createdAt", Value: -1}}, 1000)
		return
	})
	if err := g.Wait(); err != nil {
		return nil, err
	}
	listed := finance.ListedRates(hostelDoc.Rooms)
	byID := map[string]*finance.LedgerInvoice{}
	for i := range balances {
		byID[balances[i].ID] = &balances[i]
	}
	lines := map[string][]finance.LedgerLine{}
	waived := map[string]bool{}
	byResident := map[string]*finance.LedgerInvoice{}
	known := map[string]bool{}
	for _, r := range people {
		known[r.ID.Hex()] = true
	}
	extra := bson.A{}
	for _, inv := range invoices {
		lines[inv.ID.Hex()] = linesOut(inv.Lines)
		waived[inv.ID.Hex()] = inv.FineWaived
		byResident[inv.ResidentID.Hex()] = byID[inv.ID.Hex()]
		if !known[inv.ResidentID.Hex()] {
			extra = append(extra, inv.ResidentID)
		}
	}
	if len(extra) > 0 {
		cur, err := h.DB.Collection("residents").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: extra}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
			options.Find().SetProjection(residentFields))
		if err != nil {
			return nil, err
		}
		var more []matrixResident
		if err := cur.All(ctx, &more); err != nil {
			return nil, err
		}
		people = append(people, more...)
	}
	roster := make([]residents.Record, len(people))
	for i := range people {
		roster[i].UserID = people[i].UserID
	}
	avatars, err := residents.Avatars(ctx, h.DB, roster)
	if err != nil {
		return nil, err
	}
	today := bs.Today(time.Now())
	type row struct {
		name   string
		status string
		paid   int64
		due    int64
		out    ordered.Map
	}
	rows := make([]row, len(people))
	for i := range people {
		r := &people[i]
		inv := byResident[r.ID.Hex()]
		var image, notBilled, payment any
		if r.UserID != nil {
			if img, ok := avatars[r.UserID.Hex()]; ok && img != nil {
				image = *img
			}
		}
		x := row{name: r.fullName(), status: "NOT_BILLED"}
		if inv != nil {
			x.status, x.paid, x.due = inv.Status, inv.PaidAmount, inv.DueAmount
			payment = append(portalInvoice(inv), ordered.Pair{Key: "fineWaived", Value: waived[inv.ID]}, ordered.Pair{Key: "lines", Value: lines[inv.ID]})
		} else {
			notBilled = priceUnbilled(r, schedule, listed, period, concession.PercentOff, today)
		}
		moveIn := ""
		if r.MoveInDate != nil {
			moveIn = httpx.ISO(*r.MoveInDate)
		}
		res := ordered.Map{{Key: "fullName", Value: x.name}, {Key: "id", Value: r.ID.Hex()}, {Key: "image", Value: image}, {Key: "moveInDate", Value: moveIn}}
		if r.Phone != nil {
			res = append(res, ordered.Pair{Key: "phone", Value: *r.Phone})
		}
		var roomType any
		if r.BedType != nil {
			roomType = *r.BedType
		} else if r.RoomType != nil {
			roomType = *r.RoomType
		}
		res = append(res, ordered.Pair{Key: "roomNumber", Value: strOrNil(r.RoomNumber)}, ordered.Pair{Key: "roomType", Value: roomType})
		x.out = ordered.Map{{Key: "displayStatus", Value: x.status}, {Key: "notBilled", Value: notBilled}, {Key: "payment", Value: payment}, {Key: "resident", Value: res}}
		rows[i] = x
	}
	sort.SliceStable(rows, func(i, j int) bool { return hostelrooms.JSLess(rows[i].name, rows[j].name) })
	count := map[string]int{}
	var collected, due int64
	outRows := make([]ordered.Map, len(rows))
	for i, r := range rows {
		count[r.status]++
		collected += r.paid
		due += r.due
		outRows[i] = r.out
	}
	return ordered.Map{{Key: "month", Value: period}, {Key: "rows", Value: outRows}, {Key: "totals", Value: ordered.Map{{Key: "collected", Value: collected}, {Key: "due", Value: due},
		{Key: "notBilled", Value: count["NOT_BILLED"]}, {Key: "overdue", Value: count["OVERDUE"]}, {Key: "paid", Value: count["PAID"]}, {Key: "partial", Value: count["PARTIAL"]},
		{Key: "unpaid", Value: count["UNPAID"] + count["PENDING_PROOF"]}}}}, nil
}

func strOrNil(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// countableResidents is countableResidentIds: every resident row not erased.
func (h *Handler) countableResidents(ctx context.Context, hostel bson.ObjectID) (bson.A, error) {
	cur, err := h.DB.Collection("residents").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}, options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := bson.A{}
	for _, r := range rows {
		out = append(out, r.ID)
	}
	return out, nil
}

const ledgerLimit = 5000

func (h *Handler) hostelLedger(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "viewPayments")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, requestedHostel(valid.Query(c)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	mineOnly := p.Role != authz.HostelAdmin
	cache.Respond(c, h.Cache, []string{hostel.Hex()}, p.UserID, "ledger", "Transactions", func() (ordered.Map, error) {
		return h.ledger(c, hostel, p.UserID, mineOnly)
	})
}

// ledger is getHostelLedger: every resident invoice newest first, the spending
// beside it, and the opening balance for the owner.
func (h *Handler) ledger(ctx context.Context, hostel bson.ObjectID, asker string, mineOnly bool) (ordered.Map, error) {
	ids, err := h.countableResidents(ctx, hostel)
	if err != nil {
		return nil, err
	}
	invoices, err := finance.ListLedger(ctx, h.DB, finance.UnvoidedMatch(bson.D{{Key: "hostelId", Value: hostel}, {Key: "residentId", Value: bson.D{{Key: "$in", Value: ids}}}}), bson.D{{Key: "createdAt", Value: -1}}, ledgerLimit)
	if err != nil {
		return nil, err
	}
	spent, truncated, err := expenses.LedgerExpenses(ctx, h.DB, hostel, asker, ledgerLimit, mineOnly)
	if err != nil {
		return nil, err
	}
	var opening any
	if !mineOnly {
		s, err := h.settings(ctx, hostel)
		if err != nil {
			return nil, err
		}
		if r := readMoneyRules(s); r.OpeningBalance != nil {
			opening = r.OpeningBalance
		}
	}
	cur, err := h.DB.Collection("residents").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var people []struct {
		ID        bson.ObjectID `bson:"_id"`
		FirstName string        `bson:"firstName"`
		LastName  string        `bson:"lastName"`
	}
	if err := cur.All(ctx, &people); err != nil {
		return nil, err
	}
	names := map[string]string{}
	for _, r := range people {
		names[r.ID.Hex()] = trimSpace(r.FirstName + " " + r.LastName)
	}
	entries := make([]ordered.Map, len(invoices))
	for i := range invoices {
		inv := &invoices[i]
		e := portalInvoice(inv)
		if inv.CreatedAt != nil {
			e = append(e, ordered.Pair{Key: "createdAt", Value: httpx.ISO(*inv.CreatedAt)})
		}
		if inv.Method != "" {
			e = append(e, ordered.Pair{Key: "paymentMethod", Value: inv.Method})
		}
		entries[i] = append(e, ordered.Pair{Key: "residentId", Value: inv.ResidentID}, ordered.Pair{Key: "residentName", Value: names[inv.ResidentID]})
	}
	return ordered.Map{{Key: "entries", Value: entries}, {Key: "expenses", Value: spent}, {Key: "openingBalance", Value: opening},
		{Key: "truncated", Value: len(invoices) >= ledgerLimit || truncated}}, nil
}

func (h *Handler) periodSummary(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "viewPayments")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, "")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cache.Respond(c, h.Cache, p.HostelIDs, p.UserID, "invoice-periods", "Payment periods", func() (ordered.Map, error) {
		return h.periods(c, hostel)
	})
}

type periodRow struct {
	Collected      int64  `json:"collected"`
	Due            int64  `json:"due"`
	NeedsAttention int    `json:"needsAttention"`
	Paid           int    `json:"paid"`
	Period         string `json:"period"`
	Total          int    `json:"total"`
}

// periods is getPeriodSummary: one row per BS month from approval (or the
// earliest bill) to now (or the latest bill), and the hostel-wide totals.
func (h *Handler) periods(ctx context.Context, hostel bson.ObjectID) (ordered.Map, error) {
	ids, err := h.countableResidents(ctx, hostel)
	if err != nil {
		return nil, err
	}
	var verification struct {
		VerifiedAt *time.Time `bson:"verifiedAt"`
	}
	if err := h.DB.Collection("hostelverifications").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}).Decode(&verification); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	var hostelDoc struct {
		CreatedAt *time.Time `bson:"createdAt"`
	}
	if err := h.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}}).Decode(&hostelDoc); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	now := time.Now()
	approved := verification.VerifiedAt
	if approved == nil {
		approved = hostelDoc.CreatedAt
	}
	if approved == nil {
		approved = &now
	}
	earliestApproved, err := bs.PeriodOf(*approved)
	if err != nil {
		return nil, err
	}
	invoices, err := finance.ListLedger(ctx, h.DB, finance.UnvoidedMatch(bson.D{{Key: "hostelId", Value: hostel}, {Key: "residentId", Value: bson.D{{Key: "$in", Value: ids}}}}), bson.D{{Key: "createdAt", Value: -1}}, ledgerLimit)
	if err != nil {
		return nil, err
	}
	pending, err := h.DB.Collection("paymentevents").CountDocuments(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "residentId", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "source", Value: "RESIDENT_CLAIM"}, {Key: "status", Value: "PENDING"}})
	if err != nil {
		return nil, err
	}
	current, err := bs.PeriodOf(now)
	if err != nil {
		return nil, err
	}
	earliest, latest := earliestApproved, current
	for _, inv := range invoices {
		if inv.Period != nil && bs.IsBsPeriod(*inv.Period) {
			earliest, latest = min(earliest, *inv.Period), max(latest, *inv.Period)
		}
	}
	months, err := bs.PeriodsBetween(earliest, latest, 120)
	if err != nil {
		return nil, err
	}
	byPeriod := map[string]*periodRow{}
	for _, m := range months {
		byPeriod[m] = &periodRow{Period: m}
	}
	var collected, due, outstanding int64
	var paid, partial, unpaid int
	overdue := map[string]bool{}
	for _, inv := range invoices {
		unfinished := inv.Status == "UNPAID" || inv.Status == "OVERDUE" || inv.Status == "PENDING_PROOF" || inv.Status == "PARTIAL"
		if inv.Period != nil && *inv.Period != "" {
			r := byPeriod[*inv.Period]
			if r == nil {
				r = &periodRow{Period: *inv.Period}
				byPeriod[*inv.Period] = r
			}
			r.Collected += inv.PaidAmount
			r.Due += inv.DueAmount
			r.Total++
			if inv.Status == "PAID" {
				r.Paid++
			}
			if unfinished {
				r.NeedsAttention++
			}
		}
		collected += inv.PaidAmount
		due += inv.DueAmount
		outstanding += max(inv.DueAmount-inv.PaidAmount, 0)
		switch inv.Status {
		case "PAID":
			paid++
		case "PARTIAL":
			partial++
		case "UNPAID", "PENDING_PROOF":
			unpaid++
		case "OVERDUE":
			overdue[inv.ResidentID] = true
		}
	}
	rows := make([]*periodRow, 0, len(byPeriod))
	for _, r := range byPeriod {
		rows = append(rows, r)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Period > rows[j].Period })
	return ordered.Map{{Key: "earliestPeriod", Value: earliest}, {Key: "months", Value: rows}, {Key: "overall", Value: ordered.Map{{Key: "collected", Value: collected}, {Key: "due", Value: due},
		{Key: "outstanding", Value: outstanding}, {Key: "overdueResidents", Value: len(overdue)}, {Key: "paid", Value: paid}, {Key: "partial", Value: partial}, {Key: "pendingProofs", Value: pending},
		{Key: "unpaid", Value: unpaid}}}}, nil
}

func (h *Handler) residentLedger(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "viewPayments")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, "")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.residentLedgerOf(c, hostel, c.Param("residentId"))
	if err == nil && out == nil {
		err = finance.Err("RESIDENT_NOT_FOUND", "Resident not found.")
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Resident payment history")
}

// residentLedgerOf is getResidentLedger: one row per BS month since move-in, with
// the invoice and each settled payment. nil when the resident is not this hostel's.
func (h *Handler) residentLedgerOf(ctx context.Context, hostel bson.ObjectID, raw string) (ordered.Map, error) {
	id, err := bson.ObjectIDFromHex(raw)
	if err != nil {
		return nil, nil
	}
	var r struct {
		ID         bson.ObjectID `bson:"_id"`
		BedType    *string       `bson:"bedType"`
		FirstName  string        `bson:"firstName"`
		LastName   string        `bson:"lastName"`
		MoveInDate *time.Time    `bson:"moveInDate"`
		Phone      *string       `bson:"phone"`
		RoomType   *string       `bson:"roomType"`
	}
	err = h.DB.Collection("residents").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	invoices, err := finance.ListResidentInvoices(ctx, h.DB, finance.LedgerScope{HostelID: hostel, ResidentID: id})
	if err != nil {
		return nil, err
	}
	cur, err := h.DB.Collection("paymentevents").Find(ctx, bson.D{{Key: "direction", Value: "CREDIT"}, {Key: "hostelId", Value: hostel}, {Key: "residentId", Value: id}, {Key: "status", Value: "SETTLED"}},
		options.Find().SetSort(bson.D{{Key: "occurredAt", Value: 1}}).SetLimit(500))
	if err != nil {
		return nil, err
	}
	var events []struct {
		ID         bson.ObjectID  `bson:"_id"`
		Amount     int64          `bson:"amount"`
		InvoiceID  *bson.ObjectID `bson:"invoiceId"`
		OccurredAt time.Time      `bson:"occurredAt"`
		Provider   *string        `bson:"provider"`
		TxnID      *string        `bson:"providerTxnId"`
		Raw        struct {
			Code *string `bson:"transactionCode"`
		} `bson:"rawPayload"`
		SettledAt *time.Time `bson:"settledAt"`
	}
	if err := cur.All(ctx, &events); err != nil {
		return nil, err
	}
	receipts := map[bson.ObjectID]string{}
	if len(events) > 0 {
		ids := bson.A{}
		for _, e := range events {
			ids = append(ids, e.ID)
		}
		rcur, err := h.DB.Collection("receipts").Find(ctx, bson.D{{Key: "eventId", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "eventId", Value: 1}, {Key: "receiptNumber", Value: 1}}))
		if err != nil {
			return nil, err
		}
		var rows []struct {
			EventID *bson.ObjectID `bson:"eventId"`
			Number  string         `bson:"receiptNumber"`
		}
		if err := rcur.All(ctx, &rows); err != nil {
			return nil, err
		}
		for _, x := range rows {
			if x.EventID != nil {
				receipts[*x.EventID] = x.Number
			}
		}
	}
	payments := map[string][]ordered.Map{}
	for _, e := range events {
		if e.InvoiceID == nil {
			continue
		}
		method := "NONE"
		if e.Provider != nil {
			method = *e.Provider
		}
		var number any
		if n, ok := receipts[e.ID]; ok {
			number = n
		}
		code := e.Raw.Code
		if code == nil {
			code = e.TxnID
		}
		k := e.InvoiceID.Hex()
		payments[k] = append(payments[k], ordered.Map{{Key: "amount", Value: e.Amount}, {Key: "method", Value: method}, {Key: "occurredAt", Value: httpx.ISO(e.OccurredAt)},
			{Key: "receiptNumber", Value: number}, {Key: "settledAt", Value: isoOrNil(e.SettledAt)}, {Key: "transactionCode", Value: strOrNil(code)}})
	}
	// Each bill's month code, for the collect sheet (todo E1).
	codes := map[string]any{}
	if len(invoices) > 0 {
		ids := bson.A{}
		for i := range invoices {
			if oid, err := bson.ObjectIDFromHex(invoices[i].ID); err == nil {
				ids = append(ids, oid)
			}
		}
		ccur, err := h.DB.Collection("invoices").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "referenceCode", Value: 1}}))
		if err != nil {
			return nil, err
		}
		var rows []struct {
			ID   bson.ObjectID `bson:"_id"`
			Code *string       `bson:"referenceCode"`
		}
		if err := ccur.All(ctx, &rows); err != nil {
			return nil, err
		}
		for _, r := range rows {
			if r.Code != nil {
				codes[r.ID.Hex()] = *r.Code
			}
		}
	}
	byPeriod := map[string]*finance.LedgerInvoice{}
	for i := range invoices {
		if invoices[i].Period != nil {
			byPeriod[*invoices[i].Period] = &invoices[i]
		}
	}
	now := time.Now()
	from := now
	if r.MoveInDate != nil {
		from = *r.MoveInDate
	} else if n := len(invoices); n > 0 && invoices[n-1].DueDate != nil {
		from = *invoices[n-1].DueDate
	}
	start, err := bs.PeriodOf(from)
	if err != nil {
		return nil, err
	}
	end, err := bs.PeriodOf(now)
	if err != nil {
		return nil, err
	}
	periods, err := bs.PeriodsBetween(start, end, 120)
	if err != nil {
		return nil, err
	}
	months := make([]ordered.Map, 0, len(periods))
	var billed, paidMonths int
	var outstanding, paid int64
	for i := len(periods) - 1; i >= 0; i-- {
		period := periods[i]
		inv := byPeriod[period]
		var m ordered.Map
		if inv == nil {
			m = ordered.Map{{Key: "dueAmount", Value: 0}, {Key: "dueDate", Value: nil}, {Key: "invoiceId", Value: nil}, {Key: "lines", Value: []finance.LedgerLine{}}, {Key: "paidAmount", Value: 0},
				{Key: "payments", Value: []ordered.Map{}}, {Key: "period", Value: period}, {Key: "referenceCode", Value: nil}, {Key: "status", Value: "NOT_BILLED"}}
		} else {
			ps := payments[inv.ID]
			if ps == nil {
				ps = []ordered.Map{}
			}
			billed++
			if inv.Status == "PAID" {
				paidMonths++
			}
			outstanding += max(inv.DueAmount-inv.PaidAmount, 0)
			paid += inv.PaidAmount
			m = ordered.Map{{Key: "dueAmount", Value: inv.DueAmount}, {Key: "dueDate", Value: isoOrNil(inv.DueDate)}, {Key: "invoiceId", Value: inv.ID}, {Key: "lines", Value: linesOut(inv.Lines)},
				{Key: "paidAmount", Value: inv.PaidAmount}, {Key: "payments", Value: ps}, {Key: "period", Value: period}, {Key: "referenceCode", Value: codes[inv.ID]}, {Key: "status", Value: inv.Status}}
		}
		months = append(months, m)
	}
	var roomType any
	if r.BedType != nil {
		roomType = *r.BedType
	} else if r.RoomType != nil {
		roomType = *r.RoomType
	}
	return ordered.Map{{Key: "months", Value: months}, {Key: "resident", Value: ordered.Map{{Key: "fullName", Value: trimSpace(r.FirstName + " " + r.LastName)}, {Key: "id", Value: r.ID.Hex()},
		{Key: "moveInDate", Value: isoOrNil(r.MoveInDate)}, {Key: "phone", Value: strOrNil(r.Phone)}, {Key: "roomType", Value: roomType}}},
		{Key: "totals", Value: ordered.Map{{Key: "monthsBilled", Value: billed}, {Key: "monthsPaid", Value: paidMonths}, {Key: "outstanding", Value: outstanding}, {Key: "paid", Value: paid}}}}, nil
}

// ResidentLedger is getResidentLedger for the resident scan card.
func (h *Handler) ResidentLedger(ctx context.Context, hostel bson.ObjectID, residentID string) (ordered.Map, error) {
	return h.residentLedgerOf(ctx, hostel, residentID)
}
