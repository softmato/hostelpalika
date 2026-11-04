package reports

import (
	"context"
	"math"
	"math/big"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"golang.org/x/sync/errgroup"

	"github.com/softmato/hostelpalika/server/internal/modules/expenses"
	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/food"
	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/export"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/plans"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

const (
	overviewMonths = 6
	recentRows     = 12
	trendMonths    = 6
	pickerMonths   = 12
	exportRowCap   = 5000
	dayMillis      = 86_400_000.0
	parallelReads  = 8
)

var (
	monthShape    = regexp.MustCompile(`^\d{4}-\d{2}$`)
	pendingClaims = bson.D{{Key: "source", Value: "RESIDENT_CLAIM"}, {Key: "status", Value: "PENDING"}}
	openStatuses  = bson.D{{Key: "$in", Value: bson.A{"PENDING", "IN_PROGRESS"}}}
	mealTypes     = []string{"BREAKFAST", "LUNCH", "SNACKS", "DINNER"}
	liveStatuses  = bson.A{"ACTIVE", "PENDING", "SUSPENDED"}
)

// Admin is the hostel Reports screen and its exports.
type Admin struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Cache  *cache.Cache
	Spend  *expenses.Handler
}

func (a *Admin) Register(v1 *gin.RouterGroup) {
	r := v1.Group("/hostel-admin/reports")
	r.GET("/overview", httpx.ETag(), a.overview)
	r.GET("/dashboard", a.dashboard)
	r.GET("/payments", httpx.ETag(), a.payments)
	r.GET("/complaints", httpx.ETag(), a.complaints)
	r.GET("/maintenance", httpx.ETag(), a.maintenance)
	r.GET("/food", httpx.ETag(), a.food)
	r.GET("/attendance", httpx.ETag(), a.attendance)
	r.GET("/performance", httpx.ETag(), a.performance)
	r.GET("/performance/pdf", a.performancePDF)
	r.GET("/export", a.export)
}

type scope struct {
	ids    []bson.ObjectID
	filter bson.D
}

func (s scope) with(more ...bson.E) bson.D { return append(append(bson.D{}, s.filter...), more...) }
func (s scope) live(more ...bson.E) bson.D {
	return s.with(append([]bson.E{{Key: "isDeleted", Value: false}}, more...)...)
}

func hostelScope(p *authz.Principal, requested string) (scope, error) {
	if requested != "" {
		if err := authz.AssertHostelScoped(p, requested); err != nil {
			return scope{}, err
		}
		id, err := httpx.OID(requested, "hostel id")
		if err != nil {
			return scope{}, err
		}
		return scope{ids: []bson.ObjectID{id}, filter: bson.D{{Key: "hostelId", Value: id}}}, nil
	}
	ids := opsscope.IDs(p)
	return scope{ids: ids, filter: bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}}}}, nil
}

// reportQuery is reportQuerySchema.
func reportQuery(c *gin.Context) (hostel, month string, err error) {
	q := valid.Query(c)
	var is valid.Issues
	hostel = opsscope.Hostel(q, &is)
	if raw, ok := q["month"]; ok {
		month = valid.Trim(raw)
		if !monthShape.MatchString(month) {
			is.Add("month", `Invalid string: must match pattern /^\d{4}-\d{2}$/`)
		}
	}
	return hostel, month, is.Err()
}

func (a *Admin) staffQuery(c *gin.Context) (*authz.Principal, scope, string, bool) {
	p, err := a.Guards.RequireHostelStaff(c)
	if err != nil {
		httpx.Fail(c, err)
		return nil, scope{}, "", false
	}
	hostel, month, err := reportQuery(c)
	if err != nil {
		httpx.Fail(c, err)
		return nil, scope{}, "", false
	}
	s, err := hostelScope(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return nil, scope{}, "", false
	}
	return p, s, month, true
}

// all runs one report's reads side by side, as its Promise.all.
func all(ctx context.Context, reads ...func(context.Context) error) error {
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(parallelReads)
	for _, read := range reads {
		g.Go(func() error { return read(gctx) })
	}
	return g.Wait()
}

// fixed is Number(v.toFixed(d)); toFixedText the string itself. big.Rat holds the
// double exactly and rounds halves away from zero, which is what toFixed does.
func toFixedText(v float64, d int) string { return new(big.Rat).SetFloat64(v).FloatString(d) }

func fixed(v float64, d int) float64 {
	out, _ := strconv.ParseFloat(toFixedText(v, d), 64)
	return out
}

func collectionRate(due, paid float64) float64 {
	if due > 0 {
		return fixed(paid/due*100, 1)
	}
	return 0
}

func rateOrNull(due, paid float64) any {
	if due > 0 {
		return collectionRate(due, paid)
	}
	return nil
}

func isoOrNull(t *time.Time) any {
	if t == nil {
		return nil
	}
	return httpx.ISO(*t)
}

func count(out *int64, db *mongo.Database, coll string, filter bson.D) func(context.Context) error {
	return func(ctx context.Context) (err error) {
		*out, err = db.Collection(coll).CountDocuments(ctx, filter)
		return err
	}
}

func decodeAll[T any](ctx context.Context, cur *mongo.Cursor, err error) ([]T, error) {
	if err != nil {
		return nil, err
	}
	out := []T{}
	return out, cur.All(ctx, &out)
}

type counted struct {
	ID    *string `bson:"_id"`
	Count int64   `bson:"count"`
}

// countBy is countByField: sorted by the field, a missing value reading UNKNOWN.
func countBy(out *ordered.Map, db *mongo.Database, coll string, filter bson.D, field string) func(context.Context) error {
	return func(ctx context.Context) error {
		cur, err := db.Collection(coll).Aggregate(ctx, bson.A{
			bson.D{{Key: "$match", Value: filter}},
			bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$" + field}, {Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}}}}},
			bson.D{{Key: "$sort", Value: bson.D{{Key: "_id", Value: 1}}}},
		})
		rows, err := decodeAll[counted](ctx, cur, err)
		if err != nil {
			return err
		}
		m := ordered.Map{}
		for _, r := range rows {
			key := "UNKNOWN"
			if r.ID != nil {
				key = *r.ID
			}
			m = m.Set(key, r.Count)
		}
		*out = m
		return nil
	}
}

func valueOf(m ordered.Map, key string) int64 {
	v, ok := m.Get(key)
	if !ok {
		return 0
	}
	n, _ := v.(int64)
	return n
}

type ledgerScope struct {
	hostel    bson.D
	period    string
	periods   []string
	residents []bson.ObjectID
	filtered  bool
	joins     int // finance.Join*; 0 = all (P10-3)
}

func ledgerOf(s scope) ledgerScope { return ledgerScope{hostel: s.filter} }

func (l ledgerScope) forPeriod(period string) ledgerScope { l.period = period; return l }

// join keeps only the ledger joins a read uses.
func (l ledgerScope) join(j int) ledgerScope { l.joins = j; return l }

// recent is the newest n invoices, joined after the limit.
func (l ledgerScope) recent(n int64) bson.A {
	stages := l.join(-1).stages(bson.D{{Key: "$sort", Value: bson.D{{Key: "createdAt", Value: -1}}}}, bson.D{{Key: "$limit", Value: n}})
	return append(stages, finance.LedgerStagesJoin(bson.D{}, finance.JoinAll)[1:]...)
}

func (l ledgerScope) stages(extra ...bson.D) bson.A {
	match := append(bson.D{}, l.hostel...)
	if l.filtered {
		match = append(match, bson.E{Key: "residentId", Value: bson.D{{Key: "$in", Value: l.residents}}})
	}
	if l.period != "" {
		match = append(match, bson.E{Key: "period", Value: l.period})
	}
	if l.periods != nil {
		match = append(match, bson.E{Key: "period", Value: bson.D{{Key: "$in", Value: l.periods}}})
	}
	match = append(match, bson.E{Key: "status", Value: bson.D{{Key: "$ne", Value: "VOID"}}})
	joins := l.joins
	if joins == 0 {
		joins = finance.JoinAll
	}
	if joins < 0 { // recent: joined by the caller after its limit
		joins = 0
	}
	out := finance.LedgerStagesJoin(match, joins)
	for _, e := range extra {
		out = append(out, e)
	}
	return out
}

// Totals lets a row embed the sums; bson skips an unexported embedded struct.
type Totals = totals

type totals struct {
	Due  float64 `bson:"dueAmount"`
	Paid float64 `bson:"paidAmount"`
}

func (t totals) outstanding() float64 { return math.Max(t.Due-t.Paid, 0) }

func sumGroup(id any, more ...bson.E) bson.D {
	group := bson.D{{Key: "_id", Value: id}, {Key: "dueAmount", Value: bson.D{{Key: "$sum", Value: "$totalAmount"}}}, {Key: "paidAmount", Value: bson.D{{Key: "$sum", Value: "$paidAmount"}}}}
	return bson.D{{Key: "$group", Value: append(group, more...)}}
}

func (a *Admin) invoices(ctx context.Context, stages bson.A) (*mongo.Cursor, error) {
	return a.DB.Collection("invoices").Aggregate(ctx, stages)
}

func (a *Admin) totals(out *totals, l ledgerScope) func(context.Context) error {
	return func(ctx context.Context) error {
		cur, err := a.invoices(ctx, l.join(finance.JoinBalance).stages(sumGroup(nil)))
		rows, err := decodeAll[totals](ctx, cur, err)
		if err != nil {
			return err
		}
		if len(rows) > 0 {
			*out = rows[0]
		}
		return nil
	}
}

// byField is countInvoicesByField: grouped raw and translated after, since two
// invoice statuses can read as one word. The pending claim and last settlement
// come from one grouped read of the credit events, joined here, not from a
// lookup per invoice: a lifetime report over 9k invoices took 11 s that way (P10-3).
func (a *Admin) byField(out *ordered.Map, l ledgerScope, field string) func(context.Context) error {
	return func(ctx context.Context) error {
		status := "PENDING"
		if field == "method" {
			status = "SETTLED"
		}
		ev := append(append(bson.D{}, l.hostel...), bson.E{Key: "direction", Value: "CREDIT"}, bson.E{Key: "status", Value: status}, bson.E{Key: "invoiceId", Value: bson.D{{Key: "$ne", Value: nil}}})
		pipe := bson.A{bson.D{{Key: "$match", Value: ev}}}
		if field == "method" { // the last settlement's provider, as the ledger's lastSettled
			pipe = append(pipe, bson.D{{Key: "$sort", Value: bson.D{{Key: "settledAt", Value: -1}}}})
		}
		pipe = append(pipe, bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$invoiceId"}, {Key: "provider", Value: bson.D{{Key: "$first", Value: "$provider"}}}}}})
		cur, err := a.DB.Collection("paymentevents").Aggregate(ctx, pipe)
		events, err := decodeAll[struct {
			ID       bson.ObjectID `bson:"_id"`
			Provider string        `bson:"provider"`
		}](ctx, cur, err)
		if err != nil {
			return err
		}
		byInvoice := make(map[bson.ObjectID]string, len(events))
		for _, e := range events {
			byInvoice[e.ID] = e.Provider
		}
		cur, err = a.invoices(ctx, l.join(-1).stages(bson.D{{Key: "$project", Value: bson.D{{Key: "status", Value: 1}}}}))
		invoices, err := decodeAll[struct {
			ID     bson.ObjectID `bson:"_id"`
			Status string        `bson:"status"`
		}](ctx, cur, err)
		if err != nil {
			return err
		}
		type group struct {
			pending bool
			value   string
		}
		counts := map[group]int64{}
		for _, inv := range invoices {
			g := group{value: inv.Status}
			if field == "method" {
				g = group{value: byInvoice[inv.ID]}
			} else {
				_, g.pending = byInvoice[inv.ID]
			}
			counts[g]++
		}
		groups := make([]group, 0, len(counts))
		for g := range counts {
			groups = append(groups, g)
		}
		// Mongo's {_id: 1} order: false before true, a missing value first.
		sort.Slice(groups, func(i, j int) bool {
			if groups[i].pending != groups[j].pending {
				return !groups[i].pending
			}
			return groups[i].value < groups[j].value
		})
		m := ordered.Map{}
		for _, g := range groups {
			var key string
			if field == "method" {
				if key = finance.LegacyMethodFor(g.value); key == "" {
					key = "UNKNOWN"
				}
			} else {
				raw := g.value
				if raw == "" {
					raw = "UNKNOWN"
				}
				key = finance.LegacyStatusFor(raw, g.pending)
			}
			m = m.Set(key, valueOf(m, key)+counts[g])
		}
		*out = m
		return nil
	}
}

type monthPoint struct {
	Totals    `bson:",inline"`
	Period    string `bson:"_id"`
	Residents int64  `bson:"residentCount"`
}

// series is monthlySeries: a row per asked period, zero where nothing was billed.
func (a *Admin) series(out *[]monthPoint, l ledgerScope, periods []string) func(context.Context) error {
	return func(ctx context.Context) error {
		l.periods = periods
		cur, err := a.invoices(ctx, l.join(finance.JoinBalance).stages(
			sumGroup("$period", bson.E{Key: "residents", Value: bson.D{{Key: "$addToSet", Value: "$residentId"}}}),
			bson.D{{Key: "$project", Value: bson.D{{Key: "dueAmount", Value: 1}, {Key: "paidAmount", Value: 1}, {Key: "residentCount", Value: bson.D{{Key: "$size", Value: "$residents"}}}}}},
		))
		rows, err := decodeAll[monthPoint](ctx, cur, err)
		if err != nil {
			return err
		}
		found := make(map[string]monthPoint, len(rows))
		for _, r := range rows {
			found[r.Period] = r
		}
		points := make([]monthPoint, len(periods))
		for i, period := range periods {
			points[i] = found[period]
			points[i].Period = period
		}
		*out = points
		return nil
	}
}

type roomConfig struct {
	BedsPerRoom float64 `bson:"bedsPerRoom"`
	Rooms       float64 `bson:"rooms"`
	RoomType    *string `bson:"roomType"`
	VacantBeds  float64 `bson:"vacantBeds"`
}

type hostelBeds struct {
	Name  string       `bson:"name"`
	Rooms []roomConfig `bson:"roomConfigurations"`
	Views float64      `bson:"publicViewCount"`
}

func (a *Admin) hostels(out *[]hostelBeds, ids []bson.ObjectID) func(context.Context) error {
	return func(ctx context.Context) error {
		cur, err := a.DB.Collection("hostels").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "isDeleted", Value: false}})
		rows, err := decodeAll[hostelBeds](ctx, cur, err)
		*out = rows
		return err
	}
}

func bedsOf(hostels []hostelBeds) (total, vacant float64) {
	for _, h := range hostels {
		for _, r := range h.Rooms {
			total += r.BedsPerRoom * r.Rooms
			vacant += r.VacantBeds
		}
	}
	return total, vacant
}

type viewStats struct{ last30, total, unique int64 }

func (a *Admin) viewStats(ctx context.Context, ids []bson.ObjectID) (viewStats, error) {
	if len(ids) == 0 {
		return viewStats{}, nil
	}
	var out viewStats
	in := bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}}}
	views := a.DB.Collection("hostelpageviews")
	err := all(ctx, func(ctx context.Context) error {
		cur, err := a.DB.Collection("hostels").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "publicViewCount", Value: 1}}))
		rows, err := decodeAll[hostelBeds](ctx, cur, err)
		for _, h := range rows {
			out.total += int64(h.Views)
		}
		return err
	}, func(ctx context.Context) error {
		var keys []any
		err := views.Distinct(ctx, "visitorKey", in).Decode(&keys)
		out.unique = int64(len(keys))
		return err
	}, count(&out.last30, a.DB, "hostelpageviews", append(append(bson.D{}, in...), bson.E{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: time.Now().Add(-30 * 24 * time.Hour)}}})))
	return out, err
}

func (a *Admin) payments(c *gin.Context) {
	_, s, month, ok := a.staffQuery(c)
	if !ok {
		return
	}
	l := ledgerOf(s).forPeriod(month)
	proofs := s.with(pendingClaims...)
	if month != "" && bs.IsBsPeriod(month) {
		if b, err := bs.PeriodBounds(month); err == nil {
			proofs = append(proofs, bson.E{Key: "occurredAt", Value: bson.D{{Key: "$gte", Value: b.Start}, {Key: "$lte", Value: b.End}}})
		}
	}
	var t totals
	var byStatus ordered.Map
	var pending int64
	if err := all(c, a.totals(&t, l), a.byField(&byStatus, l, "status"), count(&pending, a.DB, "paymentevents", proofs)); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "report", Value: ordered.Map{{Key: "byStatus", Value: byStatus}, {Key: "pendingProofs", Value: pending}, {Key: "totalDue", Value: t.Due}, {Key: "totalPaid", Value: t.Paid}}}}, "Payment report loaded")
}

func (a *Admin) complaints(c *gin.Context) {
	_, s, _, ok := a.staffQuery(c)
	if !ok {
		return
	}
	var byStatus, byCategory ordered.Map
	var total int64
	if err := all(c, countBy(&byStatus, a.DB, "complaints", s.filter, "status"), countBy(&byCategory, a.DB, "complaints", s.filter, "category"), count(&total, a.DB, "complaints", s.filter)); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "report", Value: ordered.Map{{Key: "byCategory", Value: byCategory}, {Key: "byStatus", Value: byStatus}, {Key: "total", Value: total}}}}, "Complaint report loaded")
}

func (a *Admin) maintenance(c *gin.Context) {
	_, s, _, ok := a.staffQuery(c)
	if !ok {
		return
	}
	var byStatus, byCategory ordered.Map
	var total, completed int64
	if err := all(c, countBy(&byStatus, a.DB, "maintenancerequests", s.live(), "status"), countBy(&byCategory, a.DB, "maintenancerequests", s.live(), "category"),
		count(&total, a.DB, "maintenancerequests", s.live()), count(&completed, a.DB, "maintenancerequests", s.live(bson.E{Key: "status", Value: "COMPLETED"}))); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "report", Value: ordered.Map{{Key: "byCategory", Value: byCategory}, {Key: "byStatus", Value: byStatus}, {Key: "completed", Value: completed}, {Key: "open", Value: total - completed}, {Key: "total", Value: total}}}}, "Maintenance report loaded")
}

// statementNudge is getStatementNudge.
func (a *Admin) statementNudge(ctx context.Context, hostel bson.ObjectID) (ordered.Map, error) {
	var profile struct {
		Last    *time.Time `bson:"lastStatementUploadAt"`
		Cadence *float64   `bson:"statementCadenceDays"`
	}
	err := a.DB.Collection("hostelpaymentprofiles").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}).Decode(&profile)
	if err != nil && err != mongo.ErrNoDocuments {
		return nil, err
	}
	cadence := 7.0
	if profile.Cadence != nil && *profile.Cadence > 0 {
		cadence = *profile.Cadence
	}
	if profile.Last == nil {
		return ordered.Map{{Key: "cadenceDays", Value: cadence}, {Key: "daysSinceUpload", Value: nil}, {Key: "due", Value: true}, {Key: "message", Value: "Upload your first eSewa, Khalti or bank statement to check what has actually arrived."}}, nil
	}
	days := int64(math.Floor(time.Since(*profile.Last).Hours() / 24))
	if float64(days) <= cadence {
		return ordered.Map{{Key: "cadenceDays", Value: cadence}, {Key: "daysSinceUpload", Value: days}, {Key: "due", Value: false}, {Key: "message", Value: ""}}, nil
	}
	return ordered.Map{{Key: "cadenceDays", Value: cadence}, {Key: "daysSinceUpload", Value: days}, {Key: "due", Value: true},
		{Key: "message", Value: "It has been " + strconv.FormatInt(days, 10) + " days since your last statement upload. Upload the latest one to reconcile this month."}}, nil
}

func (a *Admin) dashboard(c *gin.Context) {
	p, err := a.Guards.RequireHostelStaff(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, _, err := reportQuery(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	key := "dashboard"
	if raw := c.Request.URL.RawQuery; raw != "" {
		key += "?" + raw
	}
	cache.Respond(c, a.Cache, p.HostelIDs, p.UserID, key, "Hostel report loaded", func() (ordered.Map, error) {
		s, err := hostelScope(p, hostel)
		if err != nil {
			return nil, err
		}
		return a.buildDashboard(c, s)
	})
}

func (a *Admin) buildDashboard(ctx context.Context, s scope) (ordered.Map, error) {
	now := time.Now()
	period, err := bs.PeriodOf(now)
	if err != nil {
		return nil, err
	}
	// Soft-deleted residents keep their invoices; they are out of these figures.
	notDeleted := s.with(bson.E{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}})
	cur, err := a.DB.Collection("residents").Find(ctx, notDeleted, options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
	people, err := decodeAll[struct {
		ID bson.ObjectID `bson:"_id"`
	}](ctx, cur, err)
	if err != nil {
		return nil, err
	}
	ids := make([]bson.ObjectID, len(people))
	for i, r := range people {
		ids[i] = r.ID
	}
	l := ledgerScope{hostel: s.filter, residents: ids, filtered: true}
	var t totals
	var residents, proofs, complaints, repairs, feedback int64
	var night ordered.Map
	var hostels []hostelBeds
	var views viewStats
	err = all(ctx,
		count(&residents, a.DB, "residents", notDeleted),
		a.hostels(&hostels, s.ids),
		a.totals(&t, l.forPeriod(period)),
		count(&proofs, a.DB, "paymentevents", append(s.with(pendingClaims...), bson.E{Key: "residentId", Value: bson.D{{Key: "$in", Value: ids}}})),
		count(&complaints, a.DB, "complaints", s.filter),
		count(&repairs, a.DB, "maintenancerequests", s.live()),
		count(&feedback, a.DB, "foodfeedbacks", s.filter),
		countBy(&night, a.DB, "nightstatuses", s.filter, "status"),
		func(ctx context.Context) (err error) { views, err = a.viewStats(ctx, s.ids); return err },
	)
	if err != nil {
		return nil, err
	}
	// The last six BS months, oldest first: billed, collected and public views.
	monthly := make([]ordered.Map, 6)
	reads := make([]func(context.Context) error, 6)
	for i := range monthly {
		key, err := bs.AddMonths(period, i-5)
		if err != nil {
			return nil, err
		}
		b, err := bs.PeriodBounds(key)
		if err != nil {
			return nil, err
		}
		reads[i] = func(ctx context.Context) error {
			var mt totals
			var seen int64
			tasks := []func(context.Context) error{a.totals(&mt, l.forPeriod(key))}
			if len(s.ids) > 0 {
				tasks = append(tasks, count(&seen, a.DB, "hostelpageviews", bson.D{{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: b.Start}, {Key: "$lte", Value: b.End}}}, {Key: "hostelId", Value: bson.D{{Key: "$in", Value: s.ids}}}}))
			}
			if err := all(ctx, tasks...); err != nil {
				return err
			}
			monthly[i] = ordered.Map{{Key: "collected", Value: mt.Paid}, {Key: "label", Value: bs.FormatPeriodMonth(key)}, {Key: "raised", Value: mt.Due}, {Key: "views", Value: seen}}
			return nil
		}
	}
	if err := all(ctx, reads...); err != nil {
		return nil, err
	}
	// Only for one hostel: a multi-hostel owner would be nudged about whichever sorted first.
	var nudge any
	if len(s.ids) == 1 {
		n, err := a.statementNudge(ctx, s.ids[0])
		if err != nil {
			return nil, err
		}
		nudge = n
	}
	_, vacant := bedsOf(hostels)
	return ordered.Map{{Key: "statementNudge", Value: nudge}, {Key: "report", Value: ordered.Map{
		{Key: "complaints", Value: complaints}, {Key: "foodFeedback", Value: feedback}, {Key: "maintenanceRequests", Value: repairs},
		{Key: "monthlyDues", Value: t.Due}, {Key: "trend", Value: monthly}, {Key: "paidAmount", Value: t.Paid}, {Key: "pendingPaymentProofs", Value: proofs},
		{Key: "publicViewsLast30Days", Value: views.last30}, {Key: "residents", Value: residents}, {Key: "totalPublicViews", Value: views.total},
		{Key: "uniquePublicVisitors", Value: views.unique}, {Key: "vacantBeds", Value: vacant}, {Key: "nightStatusSummary", Value: night},
	}}}, nil
}

type recentInvoice struct {
	ID       bson.ObjectID `bson:"_id"`
	DueDate  *time.Time    `bson:"dueDate"`
	Pending  bool          `bson:"hasPendingClaim"`
	Method   string        `bson:"method"`
	Paid     float64       `bson:"paidAmount"`
	PaidDate *time.Time    `bson:"paidDate"`
	Period   *string       `bson:"period"`
	Resident bson.ObjectID `bson:"residentId"`
	Status   string        `bson:"status"`
	Total    float64       `bson:"totalAmount"`
}

func (a *Admin) overview(c *gin.Context) {
	p, s, month, ok := a.staffQuery(c)
	if !ok {
		return
	}
	// Cached per user and hostel version, as the dashboard: ~25 reads, a lifetime
	// sum among them, re-ran on every view and saturated Mongo under load (P10-5).
	key := "overview"
	if raw := c.Request.URL.RawQuery; raw != "" {
		key += "?" + raw
	}
	cache.Respond(c, a.Cache, p.HostelIDs, p.UserID, key, "Reports overview loaded", func() (ordered.Map, error) {
		return a.buildOverview(c, s, month)
	})
}

func (a *Admin) buildOverview(c context.Context, s scope, month string) (ordered.Map, error) {
	now := time.Now()
	// A month the calendar cannot read reports this one, as the performance report does.
	if _, _, readable := bs.PeriodParts(month); !readable {
		month = ""
	}
	anchor := month
	if anchor == "" {
		var err error
		if anchor, err = bs.PeriodOf(now); err != nil {
			return nil, err
		}
	}
	months := make([]string, overviewMonths)
	for i := range months {
		key, err := bs.AddMonths(anchor, i-(overviewMonths-1))
		if err != nil {
			return nil, err
		}
		months[i] = key
	}
	l := ledgerOf(s)
	var (
		hostels                                                  []hostelBeds
		residentsBy, paidBy, methodBy, complaintBy, complaintCat ordered.Map
		repairBy, repairCat, night, inquiryBy, referralBy        ordered.Map
		residents, proofs, complaintTotal, breached, repairTotal int64
		repairDone, inquiryTotal, referralTotal                  int64
		all_, selected                                           totals
		points                                                   []monthPoint
		recent                                                   []recentInvoice
		resolution, averageRating                                any
		feedback                                                 int64
		approved, paidOut, rewardTotal                           float64
		views                                                    viewStats
	)
	err := all(c,
		a.hostels(&hostels, s.ids),
		countBy(&residentsBy, a.DB, "residents", s.live(), "status"),
		count(&residents, a.DB, "residents", s.live()),
		a.totals(&all_, l),
		a.totals(&selected, l.forPeriod(anchor)),
		a.byField(&paidBy, l, "status"),
		a.byField(&methodBy, l, "method"),
		count(&proofs, a.DB, "paymentevents", s.with(pendingClaims...)),
		a.series(&points, l, months),
		func(ctx context.Context) error {
			cur, err := a.invoices(ctx, l.recent(recentRows))
			recent, err = decodeAll[recentInvoice](ctx, cur, err)
			return err
		},
		countBy(&complaintBy, a.DB, "complaints", s.filter, "status"),
		countBy(&complaintCat, a.DB, "complaints", s.filter, "category"),
		count(&complaintTotal, a.DB, "complaints", s.filter),
		count(&breached, a.DB, "complaints", s.with(bson.E{Key: "slaDueAt", Value: bson.D{{Key: "$lt", Value: now}}}, bson.E{Key: "status", Value: openStatuses})),
		func(ctx context.Context) error {
			cur, err := a.DB.Collection("complaints").Aggregate(ctx, bson.A{
				bson.D{{Key: "$match", Value: s.with(bson.E{Key: "resolvedAt", Value: bson.D{{Key: "$ne", Value: nil}}})}},
				bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: nil}, {Key: "average", Value: bson.D{{Key: "$avg", Value: bson.D{{Key: "$subtract", Value: bson.A{"$resolvedAt", "$createdAt"}}}}}}}}},
			})
			rows, err := decodeAll[struct {
				Average float64 `bson:"average"`
			}](ctx, cur, err)
			if err == nil && len(rows) > 0 && rows[0].Average != 0 {
				resolution = fixed(rows[0].Average/dayMillis, 1)
			}
			return err
		},
		countBy(&repairBy, a.DB, "maintenancerequests", s.live(), "status"),
		countBy(&repairCat, a.DB, "maintenancerequests", s.live(), "category"),
		count(&repairTotal, a.DB, "maintenancerequests", s.live()),
		count(&repairDone, a.DB, "maintenancerequests", s.live(bson.E{Key: "status", Value: "COMPLETED"})),
		func(ctx context.Context) error {
			cur, err := a.DB.Collection("foodfeedbacks").Aggregate(ctx, bson.A{
				bson.D{{Key: "$match", Value: s.filter}},
				bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: nil}, {Key: "average", Value: bson.D{{Key: "$avg", Value: "$rating"}}}, {Key: "total", Value: bson.D{{Key: "$sum", Value: 1}}}}}},
			})
			rows, err := decodeAll[struct {
				Average float64 `bson:"average"`
				Total   int64   `bson:"total"`
			}](ctx, cur, err)
			if err == nil && len(rows) > 0 {
				feedback = rows[0].Total
				if rows[0].Average != 0 {
					averageRating = fixed(rows[0].Average, 2)
				}
			}
			return err
		},
		countBy(&night, a.DB, "nightstatuses", s.filter, "status"),
		countBy(&inquiryBy, a.DB, "inquiries", s.live(), "status"),
		count(&inquiryTotal, a.DB, "inquiries", s.live()),
		countBy(&referralBy, a.DB, "referrals", s.live(), "status"),
		count(&referralTotal, a.DB, "referrals", s.live()),
		func(ctx context.Context) error {
			when := func(status string) bson.D {
				return bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{bson.D{{Key: "$eq", Value: bson.A{"$status", status}}}, "$amount", 0}}}}}
			}
			cur, err := a.DB.Collection("referralrewards").Aggregate(ctx, bson.A{
				bson.D{{Key: "$match", Value: s.filter}},
				bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: nil}, {Key: "approved", Value: when("APPROVED")}, {Key: "paid", Value: when("PAID")}, {Key: "total", Value: bson.D{{Key: "$sum", Value: "$amount"}}}}}},
			})
			rows, err := decodeAll[struct {
				Approved float64 `bson:"approved"`
				Paid     float64 `bson:"paid"`
				Total    float64 `bson:"total"`
			}](ctx, cur, err)
			if err == nil && len(rows) > 0 {
				approved, paidOut, rewardTotal = rows[0].Approved, rows[0].Paid, rows[0].Total
			}
			return err
		},
		func(ctx context.Context) (err error) { views, err = a.viewStats(ctx, s.ids); return err },
	)
	if err != nil {
		return nil, err
	}
	names, err := a.residentNames(c, recent)
	if err != nil {
		return nil, err
	}
	totalBeds, vacant := bedsOf(hostels)
	occupied := math.Max(totalBeds-vacant, 0)
	converted := valueOf(inquiryBy, "CONVERTED")
	monthly := make([]ordered.Map, len(points))
	for i, p := range points {
		monthly[i] = ordered.Map{{Key: "collectionRate", Value: collectionRate(p.Due, p.Paid)}, {Key: "due", Value: p.Due}, {Key: "month", Value: p.Period}, {Key: "outstanding", Value: p.outstanding()}, {Key: "paid", Value: p.Paid}, {Key: "residents", Value: p.Residents}}
	}
	rows := make([]ordered.Map, len(recent))
	for i, r := range recent {
		who, known := names[r.Resident]
		if !known {
			who = residentName{"—", "—"}
		}
		var period any
		if r.Period != nil {
			period = *r.Period
		}
		rows[i] = ordered.Map{{Key: "dueAmount", Value: r.Total}, {Key: "dueDate", Value: isoOrNull(r.DueDate)}, {Key: "id", Value: r.ID.Hex()}, {Key: "method", Value: finance.LegacyMethodFor(r.Method)}, {Key: "month", Value: period},
			{Key: "paidAmount", Value: r.Paid}, {Key: "paidDate", Value: isoOrNull(r.PaidDate)}, {Key: "residentName", Value: who.name}, {Key: "roomType", Value: who.room}, {Key: "status", Value: finance.LegacyStatusFor(r.Status, r.Pending)}}
	}
	return ordered.Map{{Key: "overview", Value: ordered.Map{
		{Key: "complaints", Value: ordered.Map{{Key: "byCategory", Value: complaintCat}, {Key: "byStatus", Value: complaintBy}, {Key: "averageResolutionDays", Value: resolution},
			{Key: "open", Value: valueOf(complaintBy, "PENDING") + valueOf(complaintBy, "IN_PROGRESS")}, {Key: "resolved", Value: valueOf(complaintBy, "RESOLVED")}, {Key: "slaBreached", Value: breached}, {Key: "total", Value: complaintTotal}}},
		{Key: "food", Value: ordered.Map{{Key: "averageRating", Value: averageRating}, {Key: "feedbackCount", Value: feedback}}},
		{Key: "generatedAt", Value: httpx.ISO(now)},
		{Key: "inquiries", Value: ordered.Map{{Key: "byStatus", Value: inquiryBy}, {Key: "conversionRate", Value: collectionRate(float64(inquiryTotal), float64(converted))}, {Key: "converted", Value: converted}, {Key: "total", Value: inquiryTotal}}},
		{Key: "maintenance", Value: ordered.Map{{Key: "byCategory", Value: repairCat}, {Key: "byStatus", Value: repairBy}, {Key: "completed", Value: repairDone}, {Key: "open", Value: repairTotal - repairDone}, {Key: "total", Value: repairTotal}}},
		{Key: "months", Value: months},
		{Key: "nightStatus", Value: night},
		{Key: "occupancy", Value: ordered.Map{{Key: "byStatus", Value: residentsBy}, {Key: "occupancyRate", Value: collectionRate(totalBeds, occupied)}, {Key: "occupiedBeds", Value: occupied}, {Key: "residents", Value: residents}, {Key: "totalBeds", Value: totalBeds}, {Key: "vacantBeds", Value: vacant}}},
		{Key: "payments", Value: ordered.Map{{Key: "byMethod", Value: methodBy}, {Key: "byStatus", Value: paidBy}, {Key: "collectionRate", Value: collectionRate(all_.Due, all_.Paid)}, {Key: "monthly", Value: monthly}, {Key: "outstanding", Value: all_.outstanding()}, {Key: "pendingProofs", Value: proofs}, {Key: "recent", Value: rows},
			{Key: "selectedMonth", Value: ordered.Map{{Key: "collectionRate", Value: collectionRate(selected.Due, selected.Paid)}, {Key: "month", Value: anchor}, {Key: "outstanding", Value: selected.outstanding()}, {Key: "totalDue", Value: selected.Due}, {Key: "totalPaid", Value: selected.Paid}}},
			{Key: "totalDue", Value: all_.Due}, {Key: "totalPaid", Value: all_.Paid}}},
		{Key: "referrals", Value: ordered.Map{{Key: "byStatus", Value: referralBy}, {Key: "joined", Value: valueOf(referralBy, "JOINED") + valueOf(referralBy, "REWARDED")}, {Key: "rewardApprovedAmount", Value: approved}, {Key: "rewardPaidAmount", Value: paidOut}, {Key: "rewardTotalAmount", Value: rewardTotal}, {Key: "total", Value: referralTotal}}},
		{Key: "visibility", Value: ordered.Map{{Key: "publicViewsLast30Days", Value: views.last30}, {Key: "totalPublicViews", Value: views.total}, {Key: "uniquePublicVisitors", Value: views.unique}}},
	}}}, nil
}

type residentName struct{ name, room string }

func (a *Admin) residentNames(ctx context.Context, recent []recentInvoice) (map[bson.ObjectID]residentName, error) {
	ids := make([]bson.ObjectID, len(recent))
	for i, r := range recent {
		ids[i] = r.Resident
	}
	cur, err := a.DB.Collection("residents").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}, {Key: "roomType", Value: 1}}))
	rows, err := decodeAll[residentRow](ctx, cur, err)
	if err != nil {
		return nil, err
	}
	out := make(map[bson.ObjectID]residentName, len(rows))
	for _, r := range rows {
		name := strings.TrimSpace(r.First + " " + r.Last)
		if name == "" {
			name = "—"
		}
		room := "—"
		if r.Room != nil {
			room = *r.Room
		}
		out[r.ID] = residentName{name, room}
	}
	return out, nil
}

type residentRow struct {
	ID    bson.ObjectID `bson:"_id"`
	First string        `bson:"firstName"`
	Last  string        `bson:"lastName"`
	Room  *string       `bson:"roomType"`
}

// windowDays is the analytics window: days=abc reads as the default, never as an
// invalid date in the filter.
func windowDays(raw string) float64 {
	days := 30.0
	if raw != "" {
		if v, err := strconv.ParseFloat(strings.TrimSpace(raw), 64); err == nil {
			days = v
		}
	}
	return math.Min(math.Max(days, 1), 365)
}

func analyticsScope(p *authz.Principal, requested string) (bson.ObjectID, error) {
	return opsscope.HostelIDFor(p, requested, "A hostelId is required for this report.")
}

func jsRoundAvg(sum float64, n int) float64 { return plans.JSRound(sum / float64(n)) }

func (a *Admin) food(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "manageFood")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := analyticsScope(p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	days := windowDays(c.Query("days"))
	since := time.Now().Add(-time.Duration(days * float64(24*time.Hour)))
	cur, err := a.DB.Collection("foodreadylogs").Find(c, bson.D{{Key: "announcedAt", Value: bson.D{{Key: "$gte", Value: since}}}, {Key: "hostelId", Value: hostel}}, options.Find().SetSort(bson.D{{Key: "announcedAt", Value: -1}}).SetLimit(2000))
	logs, err := decodeAll[struct {
		At       time.Time `bson:"announcedAt"`
		Device   bson.M    `bson:"deviceInfo"`
		Meal     string    `bson:"mealType"`
		Notified float64   `bson:"notifiedCount"`
	}](c, cur, err)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var routine struct {
		Timings map[string]string `bson:"timings"`
	}
	if err := a.DB.Collection("foodroutines").FindOne(c, bson.D{{Key: "hostelId", Value: hostel}}).Decode(&routine); err != nil && err != mongo.ErrNoDocuments {
		httpx.Fail(c, err)
		return
	}
	byMeal := make([]ordered.Map, len(mealTypes))
	var measured, measuredSum float64
	var lateAll, onTimeAll int
	for i, meal := range mealTypes {
		target, hasTarget := 0, false
		timing, timed := routine.Timings[meal]
		if timed {
			target, hasTarget = food.MealStart(timing)
		}
		var announcements, late, onTime, delays int
		var notified, minuteSum, delaySum float64
		for _, l := range logs {
			if l.Meal != meal {
				continue
			}
			announcements++
			notified += l.Notified
			minutes := bs.NepalMinuteOfDay(l.At)
			minuteSum += float64(minutes)
			if hasTarget {
				d := minutes - target
				delays++
				delaySum += float64(d)
				if d > 15 {
					late++
				} else {
					onTime++
				}
			}
		}
		var averageDelay, averageReady, scheduled any
		if delays > 0 {
			v := jsRoundAvg(delaySum, delays)
			averageDelay = v
			measured++
			measuredSum += v
		}
		if announcements > 0 {
			averageReady = jsRoundAvg(minuteSum, announcements)
		}
		if timed {
			scheduled = timing
		}
		lateAll += late
		onTimeAll += onTime
		byMeal[i] = ordered.Map{{Key: "announcements", Value: announcements}, {Key: "averageDelayMinutes", Value: averageDelay}, {Key: "averageReadyMinutes", Value: averageReady}, {Key: "lateCount", Value: late}, {Key: "mealType", Value: meal}, {Key: "notified", Value: notified}, {Key: "onTimeCount", Value: onTime}, {Key: "scheduledTiming", Value: scheduled}}
	}
	// Cook credentials are shared, so "who announced" only means a device.
	type device struct {
		name          string
		announcements int
		last          time.Time
	}
	devices := []*device{}
	seen := map[string]*device{}
	for _, l := range logs {
		name, isText := l.Device["fingerprint"].(string)
		if !isText {
			name = "unidentified device"
		}
		d, known := seen[name]
		if !known {
			d = &device{name: name, last: l.At}
			seen[name] = d
			devices = append(devices, d)
		}
		d.announcements++
		if l.At.After(d.last) {
			d.last = l.At
		}
	}
	sortStable(devices, func(x, y *device) bool { return x.announcements > y.announcements })
	byDevice := make([]ordered.Map, len(devices))
	for i, d := range devices {
		byDevice[i] = ordered.Map{{Key: "announcements", Value: d.announcements}, {Key: "device", Value: d.name}, {Key: "lastAnnouncedAt", Value: httpx.ISO(d.last)}}
	}
	var averageDelay any
	if measured > 0 {
		averageDelay = plans.JSRound(measuredSum / measured)
	}
	httpx.OK(c, ordered.Map{{Key: "byDevice", Value: byDevice}, {Key: "byMeal", Value: byMeal}, {Key: "summary", Value: ordered.Map{{Key: "averageDelayMinutes", Value: averageDelay}, {Key: "lateAnnouncements", Value: lateAll}, {Key: "onTimeAnnouncements", Value: onTimeAll}, {Key: "totalAnnouncements", Value: len(logs)}, {Key: "windowDays", Value: days}}}}, "Food analytics loaded")
}

func (a *Admin) attendance(c *gin.Context) {
	p, err := a.Guards.RequireHostelStaff(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := analyticsScope(p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	days := windowDays(c.Query("days"))
	since := time.Now().Add(-time.Duration(days * float64(24*time.Hour)))
	cur, err := a.DB.Collection("attendancelogs").Aggregate(c, bson.A{
		bson.D{{Key: "$match", Value: bson.D{{Key: "day", Value: bson.D{{Key: "$gte", Value: since}}}, {Key: "hostelId", Value: hostel}}}},
		bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: bson.D{{Key: "residentId", Value: "$residentId"}, {Key: "zone", Value: "$zone"}}}, {Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}}}}},
		bson.D{{Key: "$sort", Value: bson.D{{Key: "_id.residentId", Value: 1}, {Key: "_id.zone", Value: 1}}}},
	})
	rows, err := decodeAll[struct {
		ID struct {
			Resident bson.ObjectID `bson:"residentId"`
			Zone     string        `bson:"zone"`
		} `bson:"_id"`
		Count int64 `bson:"count"`
	}](c, cur, err)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	type zones struct {
		id                                    bson.ObjectID
		inside, nearby, outside, total, other int64
	}
	var sum zones
	entries := []*zones{}
	index := map[bson.ObjectID]*zones{}
	ids := []bson.ObjectID{}
	for _, r := range rows {
		e, known := index[r.ID.Resident]
		if !known {
			e = &zones{id: r.ID.Resident}
			index[r.ID.Resident] = e
			entries = append(entries, e)
			ids = append(ids, r.ID.Resident)
		}
		e.total += r.Count
		sum.total += r.Count
		switch r.ID.Zone {
		case "INSIDE":
			e.inside += r.Count
			sum.inside += r.Count
		case "NEARBY":
			e.nearby += r.Count
			sum.nearby += r.Count
		case "OUTSIDE":
			e.outside += r.Count
			sum.outside += r.Count
		default:
			e.other += r.Count
			sum.other += r.Count
		}
	}
	cur, err = a.DB.Collection("residents").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}})
	people, err := decodeAll[residentRow](c, cur, err)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	who := make(map[bson.ObjectID]residentRow, len(people))
	for _, r := range people {
		who[r.ID] = r
	}
	// "Present" counts INSIDE and NEARBY: a resident at the gate is not absent.
	rate := func(e *zones) float64 {
		if e.total > 0 {
			return float64(e.inside+e.nearby) / float64(e.total)
		}
		return 0
	}
	sortStable(entries, func(x, y *zones) bool { return rate(x) < rate(y) })
	byResident := make([]ordered.Map, len(entries))
	absent := []ordered.Map{}
	for i, e := range entries {
		name, room := "Former resident", ""
		if r, known := who[e.id]; known {
			name = strings.TrimSpace(r.First + " " + r.Last)
			if r.Room != nil {
				room = *r.Room
			}
		}
		byResident[i] = ordered.Map{{Key: "attendanceRate", Value: rate(e)}, {Key: "inside", Value: e.inside}, {Key: "name", Value: name}, {Key: "nearby", Value: e.nearby}, {Key: "outside", Value: e.outside}, {Key: "residentId", Value: e.id.Hex()}, {Key: "roomType", Value: room}, {Key: "total", Value: e.total}, {Key: "unknown", Value: e.other}}
		if e.total >= 5 && rate(e) < 0.5 && len(absent) < 20 {
			absent = append(absent, byResident[i])
		}
	}
	httpx.OK(c, ordered.Map{{Key: "byResident", Value: byResident}, {Key: "frequentlyAbsent", Value: absent}, {Key: "summary", Value: ordered.Map{{Key: "averageAttendanceRate", Value: rate(&sum)}, {Key: "pings", Value: sum.total}, {Key: "residentsTracked", Value: len(entries)}, {Key: "windowDays", Value: days},
		{Key: "zones", Value: ordered.Map{{Key: "inside", Value: sum.inside}, {Key: "nearby", Value: sum.nearby}, {Key: "outside", Value: sum.outside}, {Key: "unknown", Value: sum.other}}}}}}, "Attendance analytics loaded")
}

func compare(current, previous int64) ordered.Map {
	var change any
	if previous > 0 {
		change = plans.JSRound(float64(current-previous) / float64(previous) * 100)
	}
	return ordered.Map{{Key: "change", Value: change}, {Key: "current", Value: current}, {Key: "previous", Value: previous}}
}

type viewSum struct {
	Views    int64 `bson:"views"`
	Visitors int64 `bson:"visitors"`
}

func (a *Admin) sumViews(out *viewSum, ids []bson.ObjectID, from, to time.Time) func(context.Context) error {
	return func(ctx context.Context) error {
		cur, err := a.DB.Collection("hostelpageviews").Aggregate(ctx, bson.A{
			bson.D{{Key: "$match", Value: bson.D{{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: from}, {Key: "$lte", Value: to}}}, {Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}}}}},
			bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$visitorKey"}, {Key: "views", Value: bson.D{{Key: "$sum", Value: 1}}}}}},
			bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: nil}, {Key: "views", Value: bson.D{{Key: "$sum", Value: "$views"}}}, {Key: "visitors", Value: bson.D{{Key: "$sum", Value: 1}}}}}},
		})
		rows, err := decodeAll[viewSum](ctx, cur, err)
		if err == nil && len(rows) > 0 {
			*out = rows[0]
		}
		return err
	}
}

func (a *Admin) appearances(out *int64, ids []bson.ObjectID, from, to time.Time) func(context.Context) error {
	return func(ctx context.Context) error {
		if len(ids) == 0 {
			return nil
		}
		cur, err := a.DB.Collection("hostellistingimpressions").Aggregate(ctx, bson.A{
			bson.D{{Key: "$match", Value: bson.D{{Key: "day", Value: bson.D{{Key: "$gte", Value: bs.NepalDayKey(from)}, {Key: "$lte", Value: bs.NepalDayKey(to)}}}, {Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}}}}},
			bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: nil}, {Key: "total", Value: bson.D{{Key: "$sum", Value: "$count"}}}}}},
		})
		rows, err := decodeAll[struct {
			Total int64 `bson:"total"`
		}](ctx, cur, err)
		if err == nil && len(rows) > 0 {
			*out = rows[0].Total
		}
		return err
	}
}

// moveOuts is countMoveOuts: the checklist or the status dropdown, a resident with
// a completed checklist only ever counted by it.
func (a *Admin) moveOuts(out *int64, s scope, from, to time.Time) func(context.Context) error {
	return func(ctx context.Context) error {
		var done []bson.ObjectID
		if err := a.DB.Collection("moveoutchecklists").Distinct(ctx, "residentId", s.with(bson.E{Key: "completedAt", Value: bson.D{{Key: "$ne", Value: nil}}})).Decode(&done); err != nil {
			return err
		}
		if done == nil {
			done = []bson.ObjectID{}
		}
		inside := bson.D{{Key: "$gte", Value: from}, {Key: "$lte", Value: to}}
		var byList, byStatus int64
		err := all(ctx, count(&byList, a.DB, "moveoutchecklists", s.with(bson.E{Key: "completedAt", Value: inside})),
			count(&byStatus, a.DB, "residents", s.live(bson.E{Key: "_id", Value: bson.D{{Key: "$nin", Value: done}}}, bson.E{Key: "status", Value: "MOVED_OUT"}, bson.E{Key: "updatedAt", Value: inside})))
		*out = byList + byStatus
		return err
	}
}

// Performance is getHostelPerformanceReport: the screen and its PDF read this one payload.
func (a *Admin) Performance(ctx context.Context, p *authz.Principal, s scope, month string) (ordered.Map, error) {
	now := time.Now().UTC().Truncate(time.Millisecond)
	current, err := bs.PeriodOf(now)
	if err != nil {
		return nil, err
	}
	// A future month has nothing to report, and one the calendar cannot bound would throw.
	if month == "" || !bs.IsBsPeriod(month) || month > current {
		month = current
	}
	previousMonth, err := bs.AddMonths(month, -1)
	if err != nil {
		return nil, err
	}
	window, err := bs.PeriodBounds(month)
	if err != nil {
		return nil, err
	}
	previous, err := bs.PeriodBounds(previousMonth)
	if err != nil {
		return nil, err
	}
	end := window.End
	if end.After(now) {
		end = now
	}
	trendKeys := make([]string, trendMonths)
	for i := range trendKeys {
		if trendKeys[i], err = bs.AddMonths(month, i-(trendMonths-1)); err != nil {
			return nil, err
		}
	}
	inWindow := bson.D{{Key: "$gte", Value: window.Start}, {Key: "$lte", Value: end}}
	inPrevious := bson.D{{Key: "$gte", Value: previous.Start}, {Key: "$lte", Value: previous.End}}
	reviewed := bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: s.ids}}}, {Key: "status", Value: "VISIBLE"}}
	tonight := bs.NightKey(now)
	l := ledgerOf(s)
	var (
		hostels []hostelBeds
		live    []struct {
			ID     bson.ObjectID `bson:"_id"`
			Status string        `bson:"status"`
		}
		monthTotals, allTime                            totals
		trend                                           []monthPoint
		methods                                         ordered.Map
		proofs, movedIn, movedOut, seenIn, seenPrev     int64
		inquiries, inquiriesPrev, converted, newReviews int64
		raised, resolved, open, pastSla                 int64
		repairsRaised, repairsDone, repairsOpen         int64
		views, viewsPrev                                viewSum
		ratingAverage                                   any
		ratingTotal                                     int64
	)
	err = all(ctx,
		a.hostels(&hostels, s.ids),
		func(ctx context.Context) error {
			cur, err := a.DB.Collection("residents").Find(ctx, s.live(bson.E{Key: "status", Value: bson.D{{Key: "$in", Value: liveStatuses}}}), options.Find().SetProjection(bson.D{{Key: "status", Value: 1}}))
			live, err = decodeAll[struct {
				ID     bson.ObjectID `bson:"_id"`
				Status string        `bson:"status"`
			}](ctx, cur, err)
			return err
		},
		a.totals(&monthTotals, l.forPeriod(month)),
		a.totals(&allTime, l),
		a.series(&trend, l, trendKeys),
		a.byField(&methods, l.forPeriod(month), "method"),
		count(&proofs, a.DB, "paymentevents", s.with(pendingClaims...)),
		count(&movedIn, a.DB, "residents", s.live(bson.E{Key: "moveInDate", Value: inWindow})),
		a.moveOuts(&movedOut, s, window.Start, end),
		a.sumViews(&views, s.ids, window.Start, end),
		a.sumViews(&viewsPrev, s.ids, previous.Start, previous.End),
		a.appearances(&seenIn, s.ids, window.Start, end),
		a.appearances(&seenPrev, s.ids, previous.Start, previous.End),
		count(&inquiries, a.DB, "inquiries", s.live(bson.E{Key: "createdAt", Value: inWindow})),
		count(&inquiriesPrev, a.DB, "inquiries", s.live(bson.E{Key: "createdAt", Value: inPrevious})),
		count(&converted, a.DB, "inquiries", s.live(bson.E{Key: "createdAt", Value: inWindow}, bson.E{Key: "status", Value: "CONVERTED"})),
		func(ctx context.Context) error {
			cur, err := a.DB.Collection("ratingreviews").Aggregate(ctx, bson.A{bson.D{{Key: "$match", Value: reviewed}},
				bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: nil}, {Key: "average", Value: bson.D{{Key: "$avg", Value: "$overallRating"}}}, {Key: "total", Value: bson.D{{Key: "$sum", Value: 1}}}}}}})
			rows, err := decodeAll[struct {
				Average float64 `bson:"average"`
				Total   int64   `bson:"total"`
			}](ctx, cur, err)
			if err == nil && len(rows) > 0 {
				ratingTotal = rows[0].Total
				if rows[0].Average != 0 {
					ratingAverage = fixed(rows[0].Average, 1)
				}
			}
			return err
		},
		count(&newReviews, a.DB, "ratingreviews", append(append(bson.D{}, reviewed...), bson.E{Key: "createdAt", Value: inWindow})),
		count(&raised, a.DB, "complaints", s.with(bson.E{Key: "createdAt", Value: inWindow})),
		count(&resolved, a.DB, "complaints", s.with(bson.E{Key: "resolvedAt", Value: inWindow})),
		count(&open, a.DB, "complaints", s.with(bson.E{Key: "status", Value: openStatuses})),
		count(&pastSla, a.DB, "complaints", s.with(bson.E{Key: "slaDueAt", Value: bson.D{{Key: "$lt", Value: now}}}, bson.E{Key: "status", Value: openStatuses})),
		count(&repairsRaised, a.DB, "maintenancerequests", s.live(bson.E{Key: "createdAt", Value: inWindow})),
		count(&repairsDone, a.DB, "maintenancerequests", s.live(bson.E{Key: "completedAt", Value: inWindow})),
		count(&repairsOpen, a.DB, "maintenancerequests", s.live(bson.E{Key: "status", Value: bson.D{{Key: "$nin", Value: bson.A{"COMPLETED", "CANCELLED"}}}})),
	)
	if err != nil {
		return nil, err
	}
	ids := make([]bson.ObjectID, len(live))
	var active, pending, suspended int64
	for i, r := range live {
		ids[i] = r.ID
		switch r.Status {
		case "ACTIVE":
			active++
		case "PENDING":
			pending++
		case "SUSPENDED":
			suspended++
		}
	}
	var inside, outside int64
	if err := all(ctx,
		count(&inside, a.DB, "nightstatuses", bson.D{{Key: "night", Value: tonight}, {Key: "residentId", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "status", Value: "INSIDE_HOSTEL"}}),
		count(&outside, a.DB, "nightstatuses", bson.D{{Key: "night", Value: tonight}, {Key: "residentId", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "status", Value: "OUTSIDE_HOSTEL"}}),
	); err != nil {
		return nil, err
	}
	total, vacant := bedsOf(hostels)
	occupied := math.Max(total-vacant, 0)
	// Money out is the owner's: a warden reading this report never sees the hostel's spending.
	var moneyOut any
	if p.Role == authz.HostelAdmin && len(s.ids) == 1 {
		if moneyOut, err = a.Spend.MonthMoneyOut(ctx, s.ids[0], month, p.UserID); err != nil {
			return nil, err
		}
	}
	name := strconv.Itoa(len(hostels)) + " hostels"
	if len(hostels) == 1 {
		name = hostels[0].Name
	}
	picker := make([]string, pickerMonths)
	for i := range picker {
		if picker[i], err = bs.AddMonths(current, -i); err != nil {
			return nil, err
		}
	}
	type method struct {
		name  string
		count int64
	}
	used := []method{}
	for _, e := range methods {
		if n, _ := e.Value.(int64); n > 0 && e.Key != "" && e.Key != "UNKNOWN" {
			used = append(used, method{e.Key, n})
		}
	}
	sortStable(used, func(x, y method) bool { return x.count > y.count })
	methodRows := make([]ordered.Map, len(used))
	for i, m := range used {
		methodRows[i] = ordered.Map{{Key: "count", Value: m.count}, {Key: "method", Value: m.name}}
	}
	trendRows := make([]ordered.Map, len(trend))
	for i, t := range trend {
		trendRows[i] = ordered.Map{{Key: "billed", Value: t.Due}, {Key: "collected", Value: t.Paid}, {Key: "collectionRate", Value: rateOrNull(t.Due, t.Paid)}, {Key: "month", Value: t.Period}}
	}
	last := trend[len(trend)-2]
	return ordered.Map{
		{Key: "moneyOut", Value: moneyOut},
		{Key: "generatedAt", Value: httpx.ISO(now)},
		{Key: "hostelName", Value: name},
		{Key: "period", Value: ordered.Map{{Key: "end", Value: httpx.ISO(end)}, {Key: "isCurrent", Value: month == current}, {Key: "month", Value: month}, {Key: "months", Value: picker}, {Key: "previousMonth", Value: previousMonth}, {Key: "start", Value: httpx.ISO(window.Start)}}},
		{Key: "finance", Value: ordered.Map{{Key: "billed", Value: monthTotals.Due}, {Key: "collected", Value: monthTotals.Paid}, {Key: "collectionRate", Value: rateOrNull(monthTotals.Due, monthTotals.Paid)}, {Key: "outstanding", Value: monthTotals.outstanding()}, {Key: "outstandingAllTime", Value: allTime.outstanding()}, {Key: "pendingProofs", Value: proofs},
			{Key: "previous", Value: ordered.Map{{Key: "billed", Value: last.Due}, {Key: "collected", Value: last.Paid}, {Key: "collectionRate", Value: rateOrNull(last.Due, last.Paid)}}},
			{Key: "methods", Value: methodRows}, {Key: "trend", Value: trendRows}}},
		{Key: "residents", Value: ordered.Map{{Key: "movedIn", Value: movedIn}, {Key: "movedOut", Value: movedOut},
			{Key: "now", Value: ordered.Map{{Key: "active", Value: active}, {Key: "pending", Value: pending}, {Key: "suspended", Value: suspended}, {Key: "total", Value: len(live)}}},
			{Key: "tonight", Value: ordered.Map{{Key: "inside", Value: inside}, {Key: "night", Value: tonight}, {Key: "notAnswered", Value: max(int64(len(live))-inside-outside, 0)}, {Key: "outside", Value: outside}}}}},
		{Key: "beds", Value: ordered.Map{{Key: "occupancyRate", Value: rateOrNull(total, occupied)}, {Key: "occupied", Value: occupied}, {Key: "total", Value: total}, {Key: "vacant", Value: vacant}}},
		{Key: "listing", Value: ordered.Map{{Key: "appearances", Value: compare(seenIn, seenPrev)}, {Key: "inquiries", Value: compare(inquiries, inquiriesPrev)}, {Key: "inquiriesConverted", Value: converted},
			{Key: "rating", Value: ordered.Map{{Key: "average", Value: ratingAverage}, {Key: "newThisMonth", Value: newReviews}, {Key: "total", Value: ratingTotal}}},
			{Key: "views", Value: compare(views.Views, viewsPrev.Views)}, {Key: "visitors", Value: compare(views.Visitors, viewsPrev.Visitors)}}},
		{Key: "operations", Value: ordered.Map{{Key: "complaints", Value: ordered.Map{{Key: "open", Value: open}, {Key: "pastSla", Value: pastSla}, {Key: "raised", Value: raised}, {Key: "resolved", Value: resolved}}},
			{Key: "repairs", Value: ordered.Map{{Key: "completed", Value: repairsDone}, {Key: "open", Value: repairsOpen}, {Key: "raised", Value: repairsRaised}}}}},
	}, nil
}

func (a *Admin) performance(c *gin.Context) {
	p, s, month, ok := a.staffQuery(c)
	if !ok {
		return
	}
	report, err := a.Performance(c, p, s, month)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "report", Value: report}}, "Performance report loaded")
}

type exportWindow struct {
	from       *time.Time
	fromPeriod string
	label      string
}

func exportWindowOf(months int) (exportWindow, error) {
	if months == 0 {
		return exportWindow{label: "Everything"}, nil
	}
	now := time.Now()
	current, err := bs.CurrentPeriod(now)
	if err != nil {
		return exportWindow{}, err
	}
	key, err := bs.AddMonths(current, -(months - 1))
	if err != nil {
		return exportWindow{}, err
	}
	b, err := bs.PeriodBounds(key)
	if err != nil {
		return exportWindow{}, err
	}
	label := "Last " + strconv.Itoa(months) + " months"
	switch months {
	case 1:
		label = "This month"
	case 12:
		label = "Last 1 year"
	}
	return exportWindow{from: &b.Start, fromPeriod: key, label: label}, nil
}

// exportQuery is hostelAdminReportExportSchema.
func exportQuery(c *gin.Context) (format string, months int, hostel, report string, err error) {
	q := valid.Query(c)
	var is valid.Issues
	format, months = exportFormatMonths(q, &is)
	hostel = opsscope.Hostel(q, &is)
	raw := q["report"]
	if raw != "residents" && raw != "payments" && raw != "complaints" && raw != "occupancy" {
		is.Add("report", `Invalid option: expected one of "residents"|"payments"|"complaints"|"occupancy"`)
	}
	return format, months, hostel, raw, is.Err()
}

// exportFormatMonths is reportExportFormatSchema and reportExportMonthsSchema.
func exportFormatMonths(q map[string]string, is *valid.Issues) (format string, months int) {
	format = "csv"
	if raw, ok := q["format"]; ok {
		format = raw
		if raw != "csv" && raw != "pdf" {
			is.Add("format", `Invalid option: expected one of "csv"|"pdf"`)
		}
	}
	if raw, ok := q["months"]; ok {
		v := 0.0
		if t := strings.TrimSpace(raw); t != "" {
			parsed, perr := strconv.ParseFloat(t, 64)
			v = parsed
			if perr != nil {
				is.Add("months", "Invalid input: expected number, received NaN")
				v = 0
			}
		}
		switch {
		case v != math.Trunc(v):
			is.Add("months", "Invalid input: expected int, received number")
		case v < 0:
			is.Add("months", "Choose how many months, or everything.")
		case v > 24:
			is.Add("months", "Up to 24 months, or everything.")
		}
		months = int(v)
	}
	return format, months
}

func (a *Admin) export(c *gin.Context) {
	p, err := a.Guards.RequireHostelStaff(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	format, months, hostel, report, err := exportQuery(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := a.buildExport(c, p, hostel, report, months)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := export.WriteReport(c.Writer, out, format, "", time.Now()); err != nil {
		httpx.Fail(c, err)
	}
}

func (a *Admin) buildExport(ctx context.Context, p *authz.Principal, hostel, report string, months int) (export.Report, error) {
	s, err := hostelScope(p, hostel)
	if err != nil {
		return export.Report{}, err
	}
	if len(s.ids) == 0 {
		return export.Report{}, httpx.NewError(422, "HOSTEL_SCOPE_REQUIRED", "This account is not linked to a hostel.", nil)
	}
	in := bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: s.ids}}}}
	window, err := exportWindowOf(months)
	if err != nil {
		return export.Report{}, err
	}
	rowCap := bson.D{{Key: "$limit", Value: exportRowCap}}
	switch report {
	case "residents":
		match := append(append(bson.D{}, in...), bson.E{Key: "isDeleted", Value: false})
		if window.from != nil {
			match = append(match, bson.E{Key: "moveInDate", Value: bson.D{{Key: "$gte", Value: *window.from}}})
		}
		cur, err := a.DB.Collection("residents").Aggregate(ctx, bson.A{bson.D{{Key: "$match", Value: match}},
			bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: bson.D{{Key: "$dateToString", Value: bson.D{{Key: "date", Value: "$moveInDate"}, {Key: "format", Value: "%Y-%m"}}}}}, {Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}}}}},
			bson.D{{Key: "$sort", Value: bson.D{{Key: "_id", Value: 1}}}}, rowCap})
		found, err := decodeAll[counted](ctx, cur, err)
		if err != nil {
			return export.Report{}, err
		}
		rows := make([]map[string]any, len(found))
		for i, r := range found {
			month := "Unknown"
			if r.ID != nil {
				month = *r.ID
			}
			rows[i] = map[string]any{"count": r.Count, "month": month}
		}
		return export.Report{Columns: []export.Column{{Key: "month", Label: "Move-in month"}, {Key: "count", Label: "Residents"}}, FilenamePrefix: "residents-over-time", Period: window.label, Rows: rows}, nil
	case "payments":
		cur, err := a.invoices(ctx, ledgerScope{hostel: in, joins: finance.JoinBalance}.stages(
			sumGroup(bson.D{{Key: "period", Value: "$period"}}, bson.E{Key: "invoiceCount", Value: bson.D{{Key: "$sum", Value: 1}}}),
			bson.D{{Key: "$sort", Value: bson.D{{Key: "_id.period", Value: -1}}}}, rowCap))
		found, err := decodeAll[struct {
			Totals `bson:",inline"`
			ID     struct {
				Period *string `bson:"period"`
			} `bson:"_id"`
			Invoices int64 `bson:"invoiceCount"`
		}](ctx, cur, err)
		if err != nil {
			return export.Report{}, err
		}
		rows := []map[string]any{}
		for _, r := range found {
			var month any
			if r.ID.Period != nil {
				month = *r.ID.Period
			}
			if window.fromPeriod != "" && (r.ID.Period == nil || *r.ID.Period < window.fromPeriod) {
				continue
			}
			rate := "0.0"
			if r.Due > 0 {
				rate = toFixedText(r.Paid/r.Due*100, 1)
			}
			rows = append(rows, map[string]any{"collectionRatePercent": rate, "dueAmount": r.Due, "month": month, "paidAmount": r.Paid, "payments": r.Invoices})
		}
		return export.Report{Columns: []export.Column{{Key: "month", Label: "Month"}, {Key: "payments", Label: "Payment records"}, {Key: "dueAmount", Label: "Billed (NPR)"}, {Key: "paidAmount", Label: "Collected (NPR)"}, {Key: "collectionRatePercent", Label: "Collection rate (%)"}}, FilenamePrefix: "payment-collection", Period: window.label, Rows: rows}, nil
	case "complaints":
		match := in
		if window.from != nil {
			match = append(append(bson.D{}, in...), bson.E{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: *window.from}}})
		}
		resolving := bson.D{{Key: "$cond", Value: bson.A{bson.D{{Key: "$ne", Value: bson.A{"$resolvedAt", nil}}}, bson.D{{Key: "$subtract", Value: bson.A{"$resolvedAt", "$createdAt"}}}, nil}}}
		cur, err := a.DB.Collection("complaints").Aggregate(ctx, bson.A{bson.D{{Key: "$match", Value: match}},
			bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: bson.D{{Key: "category", Value: "$category"}, {Key: "status", Value: "$status"}}}, {Key: "avg", Value: bson.D{{Key: "$avg", Value: resolving}}}, {Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}}}}},
			bson.D{{Key: "$sort", Value: bson.D{{Key: "count", Value: -1}}}}, rowCap})
		found, err := decodeAll[struct {
			ID struct {
				Category *string `bson:"category"`
				Status   *string `bson:"status"`
			} `bson:"_id"`
			Avg   *float64 `bson:"avg"`
			Count int64    `bson:"count"`
		}](ctx, cur, err)
		if err != nil {
			return export.Report{}, err
		}
		orUnknown := func(v *string) string {
			if v == nil {
				return "UNKNOWN"
			}
			return *v
		}
		rows := make([]map[string]any, len(found))
		for i, r := range found {
			days := "—"
			if r.Avg != nil && *r.Avg != 0 {
				days = toFixedText(*r.Avg/dayMillis, 1)
			}
			rows[i] = map[string]any{"avgResolutionDays": days, "category": orUnknown(r.ID.Category), "count": r.Count, "status": orUnknown(r.ID.Status)}
		}
		return export.Report{Columns: []export.Column{{Key: "category", Label: "Category"}, {Key: "status", Label: "Status"}, {Key: "count", Label: "Complaints"}, {Key: "avgResolutionDays", Label: "Avg resolution (days)"}}, FilenamePrefix: "complaint-resolution", Period: window.label, Rows: rows}, nil
	}
	var hostels []hostelBeds
	if err := a.hostels(&hostels, s.ids)(ctx); err != nil {
		return export.Report{}, err
	}
	rows := []map[string]any{}
	for _, h := range hostels {
		for _, r := range h.Rooms {
			beds := r.BedsPerRoom * r.Rooms
			occupied := math.Max(beds-r.VacantBeds, 0)
			rate := "0.0"
			if beds > 0 {
				rate = toFixedText(occupied/beds*100, 1)
			}
			room := "Unknown"
			if r.RoomType != nil {
				room = *r.RoomType
			}
			rows = append(rows, map[string]any{"hostel": h.Name, "occupancyRatePercent": rate, "occupiedBeds": occupied, "roomType": room, "totalBeds": beds})
		}
	}
	return export.Report{Columns: []export.Column{{Key: "hostel", Label: "Hostel"}, {Key: "roomType", Label: "Room type"}, {Key: "totalBeds", Label: "Total beds"}, {Key: "occupiedBeds", Label: "Occupied beds"}, {Key: "occupancyRatePercent", Label: "Occupancy rate (%)"}}, FilenamePrefix: "room-occupancy", Rows: rows}, nil
}

func sortStable[T any](rows []T, less func(a, b T) bool) {
	sort.SliceStable(rows, func(i, j int) bool { return less(rows[i], rows[j]) })
}

// PerformanceFor is getHostelPerformanceReport for a principal already narrowed to one
// hostel, as the all-branches document builds it.
func (a *Admin) PerformanceFor(ctx context.Context, p *authz.Principal, month string) (ordered.Map, error) {
	s, err := hostelScope(p, "")
	if err != nil {
		return nil, err
	}
	return a.Performance(ctx, p, s, month)
}
