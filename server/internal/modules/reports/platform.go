package reports

import (
	"context"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/export"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

const (
	trendWindowDays  = 30
	seriesBuckets    = 5
	seriesBucketDays = 7
	day              = 24 * time.Hour
)

// RegisterPlatform is the platform portal's dashboard, payments tab and exports.
// A moderator reads; only a superadmin exports.
func (a *Admin) RegisterPlatform(v1 *gin.RouterGroup) {
	staff := authz.Use(a.Guards.RequirePlatform)
	v1.GET("/platform/reports/dashboard", staff, httpx.ETag(), a.platformDashboard)
	v1.GET("/platform/payments", staff, httpx.ETag(), a.platformPayments)
	v1.GET("/platform/reports/export", authz.Use(a.Guards.RequireSuperadmin), a.platformExport)
}

type trend struct {
	ChangePercent any     `json:"changePercent"`
	Current       float64 `json:"current"`
	Previous      float64 `json:"previous"`
}

func trendOf(current, previous float64) trend {
	var change any
	if previous > 0 {
		change = fixed((current-previous)/previous*100, 1)
	}
	return trend{change, current, previous}
}

type bucket struct{ start, end time.Time }

func bucketsOf(now time.Time) []bucket {
	out := make([]bucket, seriesBuckets)
	for i := range out {
		end := now.Add(-time.Duration(seriesBuckets-1-i) * seriesBucketDays * day)
		out[i] = bucket{end.Add(-seriesBucketDays * day), end}
	}
	return out
}

// countTrend is windowTrend's two counts plus, when weekly is set, the five weekly
// buckets. done turns the counts into the trend once the reads have run.
func (a *Admin) countTrend(coll string, filter bson.D, now time.Time, weekly *[]int64) (reads []func(context.Context) error, done func() trend) {
	currentStart, previousStart := now.Add(-trendWindowDays*day), now.Add(-2*trendWindowDays*day)
	with := func(r bson.D) bson.D { return append(append(bson.D{}, filter...), bson.E{Key: "createdAt", Value: r}) }
	var cur, prev int64
	reads = []func(context.Context) error{
		count(&cur, a.DB, coll, with(bson.D{{Key: "$gte", Value: currentStart}})),
		count(&prev, a.DB, coll, with(bson.D{{Key: "$gte", Value: previousStart}, {Key: "$lt", Value: currentStart}})),
	}
	if weekly != nil {
		*weekly = make([]int64, seriesBuckets)
		for i, b := range bucketsOf(now) {
			reads = append(reads, count(&(*weekly)[i], a.DB, coll, with(bson.D{{Key: "$gte", Value: b.start}, {Key: "$lt", Value: b.end}})))
		}
	}
	return reads, func() trend { return trendOf(float64(cur), float64(prev)) }
}

// platformDashboard is getPlatformDashboardReport. The ledger sums are one $facet
// over the invoices where TS ran the whole ledger pipeline eight times.
func (a *Admin) platformDashboard(c *gin.Context) {
	now := time.Now().UTC()
	live := bson.D{{Key: "isDeleted", Value: false}}
	pending := bson.D{{Key: "isDeleted", Value: false}, {Key: "status", Value: "PENDING_APPROVAL"}}
	activeRes := bson.D{{Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}}
	var totalHostels, pendingApprovals, activeResidents, inquiries, providers, complaints, reviews, openFlags int64
	var tHostels, tPending, tResidents, tInquiries, tProviders, tComplaints trend
	var wHostels, wInquiries []int64
	reads := []func(context.Context) error{
		count(&totalHostels, a.DB, "hostels", live), count(&pendingApprovals, a.DB, "hostels", pending), count(&activeResidents, a.DB, "residents", activeRes),
		count(&inquiries, a.DB, "inquiries", live), count(&providers, a.DB, "serviceproviders", live), count(&complaints, a.DB, "complaints", bson.D{}),
		count(&reviews, a.DB, "ratingreviews", bson.D{}), count(&openFlags, a.DB, "listingflags", bson.D{{Key: "isDeleted", Value: false}, {Key: "status", Value: "OPEN"}}),
	}
	var finals []func()
	for _, t := range []struct {
		coll   string
		filter bson.D
		out    *trend
		weekly *[]int64
	}{{"hostels", live, &tHostels, &wHostels}, {"hostels", pending, &tPending, nil}, {"residents", activeRes, &tResidents, nil}, {"inquiries", live, &tInquiries, &wInquiries},
		{"serviceproviders", live, &tProviders, nil}, {"complaints", bson.D{}, &tComplaints, nil}} {
		more, done := a.countTrend(t.coll, t.filter, now, t.weekly)
		reads = append(reads, more...)
		out := t.out
		finals = append(finals, func() { *out = done() })
	}
	paid := func(from, to *time.Time) bson.A {
		w := bson.D{}
		if from != nil {
			w = append(w, bson.E{Key: "$gte", Value: *from})
		}
		if to != nil {
			w = append(w, bson.E{Key: "$lt", Value: *to})
		}
		return bson.A{bson.D{{Key: "$match", Value: bson.D{{Key: "paidDate", Value: w}}}}, sumGroup(nil)}
	}
	cs, ps := now.Add(-trendWindowDays*day), now.Add(-2*trendWindowDays*day)
	facet := bson.D{{Key: "all", Value: bson.A{sumGroup(nil)}}, {Key: "current", Value: paid(&cs, nil)}, {Key: "previous", Value: paid(&ps, &cs)}}
	buckets := bucketsOf(now)
	for i, b := range buckets {
		facet = append(facet, bson.E{Key: "w" + string(rune('0'+i)), Value: paid(&b.start, &b.end)})
	}
	var sums map[string][]totals
	reads = append(reads, func(ctx context.Context) error {
		cur, err := a.invoices(ctx, ledgerScope{joins: finance.JoinBalance | finance.JoinSettled}.stages(bson.D{{Key: "$facet", Value: facet}}))
		rows, err := decodeAll[map[string][]totals](ctx, cur, err)
		if err == nil && len(rows) > 0 {
			sums = rows[0]
		}
		return err
	})
	if err := all(c, reads...); err != nil {
		httpx.Fail(c, err)
		return
	}
	for _, f := range finals {
		f()
	}
	first := func(k string) totals {
		if r := sums[k]; len(r) > 0 {
			return r[0]
		}
		return totals{}
	}
	whole := first("all")
	revenue := make([]float64, len(buckets))
	labels := make([]string, len(buckets))
	for i, b := range buckets {
		revenue[i] = first("w" + string(rune('0'+i))).Paid
		labels[i] = httpx.ISO(b.end)
	}
	httpx.OK(c, ordered.Map{{Key: "report", Value: ordered.Map{
		{Key: "activeResidents", Value: activeResidents}, {Key: "complaints", Value: complaints}, {Key: "inquiries", Value: inquiries}, {Key: "openListingFlags", Value: openFlags},
		{Key: "outstandingPayments", Value: whole.outstanding()}, {Key: "pendingApprovals", Value: pendingApprovals}, {Key: "platformPayments", Value: whole.Paid},
		{Key: "reviews", Value: reviews}, {Key: "serviceProviders", Value: providers},
		{Key: "series", Value: ordered.Map{{Key: "bucketDays", Value: seriesBucketDays}, {Key: "hostels", Value: wHostels}, {Key: "inquiries", Value: wInquiries}, {Key: "labels", Value: labels}, {Key: "revenue", Value: revenue}}},
		{Key: "totalHostels", Value: totalHostels},
		{Key: "trends", Value: ordered.Map{{Key: "activeResidents", Value: tResidents}, {Key: "complaints", Value: tComplaints}, {Key: "inquiries", Value: tInquiries}, {Key: "pendingApprovals", Value: tPending},
			{Key: "platformPayments", Value: trendOf(first("current").Paid, first("previous").Paid)}, {Key: "serviceProviders", Value: tProviders}, {Key: "totalHostels", Value: tHostels}}},
		{Key: "windowDays", Value: trendWindowDays},
	}}}, "Platform report loaded")
}

type namedHostel struct {
	ID   bson.ObjectID `bson:"_id"`
	Name *string       `bson:"name"`
}

func (a *Admin) liveHostels(ctx context.Context) ([]namedHostel, bson.A, error) {
	cur, err := a.DB.Collection("hostels").Find(ctx, bson.D{{Key: "isDeleted", Value: false}}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}))
	rows, err := decodeAll[namedHostel](ctx, cur, err)
	ids := make(bson.A, len(rows))
	for i, h := range rows {
		ids[i] = h.ID
	}
	return rows, ids, err
}

// platformPayments is getPlatformPaymentsOverview, or with view=recent getRecentPlatformPayments.
// Archived hostels are out of the book: they wait to be erased and nobody can act on them.
func (a *Admin) platformPayments(c *gin.Context) {
	q := valid.Query(c)
	if q["view"] == "recent" {
		a.recentPayments(c, q)
		return
	}
	hostels, ids, err := a.liveHostels(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	scope := ledgerScope{hostel: bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}}}}
	claims := bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "source", Value: "RESIDENT_CLAIM"}, {Key: "status", Value: "PENDING"}}
	var sum totals
	statusCounts := ordered.Map{}
	var pendingProofs int64
	type invoiceRow struct {
		ID       bson.ObjectID `bson:"_id"`
		DueDate  *time.Time    `bson:"dueDate"`
		HostelID bson.ObjectID `bson:"hostelId"`
		Paid     float64       `bson:"paidAmount"`
		Pending  bool          `bson:"hasPendingClaim"`
		Period   *string       `bson:"period"`
		Status   string        `bson:"status"`
		Total    float64       `bson:"totalAmount"`
	}
	type proofRow struct {
		ID         bson.ObjectID  `bson:"_id"`
		Amount     float64        `bson:"amount"`
		Evidence   *bson.ObjectID `bson:"evidenceAssetId"`
		HostelID   bson.ObjectID  `bson:"hostelId"`
		InvoiceID  *bson.ObjectID `bson:"invoiceId"`
		OccurredAt *time.Time     `bson:"occurredAt"`
		Raw        struct {
			Code *string `bson:"transactionCode"`
		} `bson:"rawPayload"`
		ResidentID bson.ObjectID `bson:"residentId"`
		Status     string        `bson:"status"`
	}
	var recent []invoiceRow
	var proofs []proofRow
	err = all(c, a.totals(&sum, scope), a.byField(&statusCounts, scope, "status"), count(&pendingProofs, a.DB, "paymentevents", claims),
		func(ctx context.Context) error {
			cur, err := a.invoices(ctx, scope.recent(25))
			recent, err = decodeAll[invoiceRow](ctx, cur, err)
			return err
		},
		func(ctx context.Context) error {
			cur, err := a.DB.Collection("paymentevents").Find(ctx, claims, options.Find().SetSort(bson.D{{Key: "occurredAt", Value: -1}}).SetLimit(10))
			proofs, err = decodeAll[proofRow](ctx, cur, err)
			return err
		})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	names := map[bson.ObjectID]string{}
	for _, h := range hostels {
		n := "—"
		if h.Name != nil {
			n = *h.Name
		}
		names[h.ID] = n
	}
	nameOf := func(id bson.ObjectID) string {
		if n, ok := names[id]; ok {
			return n
		}
		return "—"
	}
	periods := map[bson.ObjectID]*string{}
	invIDs := bson.A{}
	for _, p := range proofs {
		if p.InvoiceID != nil {
			invIDs = append(invIDs, *p.InvoiceID)
		}
	}
	if len(invIDs) > 0 {
		cur, err := a.DB.Collection("invoices").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: invIDs}}}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "VOID"}}}},
			options.Find().SetProjection(bson.D{{Key: "period", Value: 1}}))
		rows, err := decodeAll[invoiceRow](c, cur, err)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		for _, r := range rows {
			periods[r.ID] = r.Period
		}
	}
	proofsOut := make([]ordered.Map, len(proofs))
	for i, p := range proofs {
		var month any = "—"
		invoice, asset, code := "", "", ""
		if p.InvoiceID != nil {
			invoice = p.InvoiceID.Hex()
			if per, ok := periods[*p.InvoiceID]; ok {
				month = per
				if per == nil {
					month = nil
				}
			}
		}
		if p.Evidence != nil {
			asset = p.Evidence.Hex()
		}
		if p.Raw.Code != nil {
			code = *p.Raw.Code
		}
		proofsOut[i] = ordered.Map{{Key: "amount", Value: p.Amount}, {Key: "hostelName", Value: nameOf(p.HostelID)}, {Key: "id", Value: p.ID.Hex()}, {Key: "month", Value: month},
			{Key: "paymentId", Value: invoice}, {Key: "proofImageAssetId", Value: asset}, {Key: "residentId", Value: p.ResidentID.Hex()}, {Key: "status", Value: p.Status},
			{Key: "submittedAt", Value: isoOrNull(p.OccurredAt)}, {Key: "transactionCode", Value: code}}
	}
	recentOut := make([]ordered.Map, len(recent))
	for i, r := range recent {
		var month any
		if r.Period != nil {
			month = *r.Period
		}
		recentOut[i] = ordered.Map{{Key: "dueAmount", Value: r.Total}, {Key: "dueDate", Value: isoOrNull(r.DueDate)}, {Key: "hostelName", Value: nameOf(r.HostelID)}, {Key: "id", Value: r.ID.Hex()},
			{Key: "month", Value: month}, {Key: "paidAmount", Value: r.Paid}, {Key: "status", Value: finance.LegacyStatusFor(r.Status, r.Pending)}}
	}
	httpx.OK(c, ordered.Map{{Key: "overview", Value: ordered.Map{{Key: "outstanding", Value: sum.outstanding()}, {Key: "pendingProofs", Value: pendingProofs}, {Key: "statusCounts", Value: statusCounts},
		{Key: "totalDue", Value: sum.Due}, {Key: "totalPaid", Value: sum.Paid}}}, {Key: "proofs", Value: proofsOut}, {Key: "recent", Value: recentOut}}, "Platform payments loaded")
}

// recentPayments is getRecentPlatformPayments: settled receipts, not invoices.
func (a *Admin) recentPayments(c *gin.Context, q map[string]string) {
	var is valid.Issues
	page := valid.Page(q, &is)
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostels, ids, err := a.liveHostels(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	filter := bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "status", Value: "SETTLED"}, {Key: "direction", Value: "CREDIT"}}
	r := pagination.RangeOf(page)
	var total int64
	var events []struct {
		ID         bson.ObjectID `bson:"_id"`
		Amount     float64       `bson:"amount"`
		HostelID   bson.ObjectID `bson:"hostelId"`
		OccurredAt *time.Time    `bson:"occurredAt"`
		Provider   any           `bson:"provider"`
		SettledAt  *time.Time    `bson:"settledAt"`
	}
	err = all(c, count(&total, a.DB, "paymentevents", filter), func(ctx context.Context) error {
		cur, err := a.DB.Collection("paymentevents").Find(ctx, filter, options.Find().SetSort(bson.D{{Key: "settledAt", Value: -1}, {Key: "_id", Value: -1}}).SetSkip(int64(r.Skip)).SetLimit(int64(r.Limit)))
		if err != nil {
			return err
		}
		return cur.All(ctx, &events)
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	names := map[bson.ObjectID]any{}
	for _, h := range hostels {
		if h.Name != nil {
			names[h.ID] = *h.Name
		} else {
			names[h.ID] = nil
		}
	}
	out := make([]ordered.Map, len(events))
	for i, e := range events {
		name, ok := names[e.HostelID]
		if !ok {
			name = "—"
		}
		at := e.SettledAt
		if at == nil {
			at = e.OccurredAt
		}
		out[i] = ordered.Map{{Key: "id", Value: e.ID.Hex()}, {Key: "hostelName", Value: name}, {Key: "paidAmount", Value: e.Amount}, {Key: "provider", Value: e.Provider},
			{Key: "status", Value: "SETTLED"}, {Key: "paidAt", Value: isoOrNull(at)}}
	}
	httpx.OK(c, ordered.Map{{Key: "pagination", Value: pagination.MetaOf(page, int(total))}, {Key: "recent", Value: out}}, "Platform payments loaded")
}

// platformExport is buildPlatformReportExport. Grouped counts only, never row
// dumps: a list of every resident has no business in a downloaded file.
func (a *Admin) platformExport(c *gin.Context) {
	format, months, report, err := platformExportQuery(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	window, err := exportWindowOf(months)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var out export.Report
	rowCap := bson.D{{Key: "$limit", Value: exportRowCap}}
	type byHostelStatus struct {
		ID struct {
			HostelID *bson.ObjectID `bson:"hostelId"`
			Status   *string        `bson:"status"`
		} `bson:"_id"`
		Count int64 `bson:"count"`
	}
	statusOf := func(s *string) string {
		if s == nil {
			return "UNKNOWN"
		}
		return *s
	}
	hostelRows := func(coll string, match bson.A, label string) ([]map[string]any, error) {
		stages := append(match, bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: bson.D{{Key: "hostelId", Value: "$hostelId"}, {Key: "status", Value: "$status"}}}, {Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}}}}},
			bson.D{{Key: "$sort", Value: bson.D{{Key: "count", Value: -1}}}}, rowCap)
		cur, err := a.DB.Collection(coll).Aggregate(c, stages)
		found, err := decodeAll[byHostelStatus](c, cur, err)
		if err != nil {
			return nil, err
		}
		ids := []bson.ObjectID{}
		for _, r := range found {
			if r.ID.HostelID != nil {
				ids = append(ids, *r.ID.HostelID)
			}
		}
		names, err := a.hostelNames(c, ids)
		if err != nil {
			return nil, err
		}
		rows := make([]map[string]any, len(found))
		for i, r := range found {
			name := "Unknown hostel"
			if r.ID.HostelID != nil {
				if n, ok := names[*r.ID.HostelID]; ok {
					name = n
				}
			}
			rows[i] = map[string]any{"count": r.Count, "hostel": name, "status": statusOf(r.ID.Status)}
		}
		return rows, nil
	}
	switch report {
	case "hostels":
		cur, err := a.DB.Collection("hostels").Aggregate(c, bson.A{bson.D{{Key: "$match", Value: bson.D{{Key: "isDeleted", Value: false}}}},
			bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$status"}, {Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}}}}}, bson.D{{Key: "$sort", Value: bson.D{{Key: "count", Value: -1}}}}})
		found, err := decodeAll[counted](c, cur, err)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		rows := make([]map[string]any, len(found))
		for i, r := range found {
			rows[i] = map[string]any{"count": r.Count, "status": statusOf(r.ID)}
		}
		out = export.Report{Columns: []export.Column{{Key: "status", Label: "Status"}, {Key: "count", Label: "Hostels"}}, FilenamePrefix: "hostels-by-status", Rows: rows}
	case "residents":
		rows, err := hostelRows("residents", bson.A{bson.D{{Key: "$match", Value: bson.D{{Key: "isDeleted", Value: false}}}}}, "Residents")
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		out = export.Report{Columns: []export.Column{{Key: "hostel", Label: "Hostel"}, {Key: "status", Label: "Status"}, {Key: "count", Label: "Residents"}}, FilenamePrefix: "residents-by-status", Rows: rows}
	case "complaints":
		match := bson.A{}
		if window.from != nil {
			match = append(match, bson.D{{Key: "$match", Value: bson.D{{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: *window.from}}}}}})
		}
		rows, err := hostelRows("complaints", match, "Complaints")
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		out = export.Report{Columns: []export.Column{{Key: "hostel", Label: "Hostel"}, {Key: "status", Label: "Status"}, {Key: "count", Label: "Complaints"}}, FilenamePrefix: "complaint-volume", Period: window.label, Rows: rows}
	default: // payments: billed against what residents actually settled
		cur, err := a.invoices(c, ledgerScope{joins: finance.JoinBalance}.stages(
			sumGroup(bson.D{{Key: "hostelId", Value: "$hostelId"}, {Key: "period", Value: "$period"}}, bson.E{Key: "invoiceCount", Value: bson.D{{Key: "$sum", Value: 1}}}),
			bson.D{{Key: "$sort", Value: bson.D{{Key: "_id.period", Value: -1}, {Key: "_id.hostelId", Value: 1}}}}, rowCap))
		found, err := decodeAll[struct {
			Totals `bson:",inline"`
			ID     struct {
				HostelID *bson.ObjectID `bson:"hostelId"`
				Period   *string        `bson:"period"`
			} `bson:"_id"`
			Invoices int64 `bson:"invoiceCount"`
		}](c, cur, err)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		ids := []bson.ObjectID{}
		for _, r := range found {
			if r.ID.HostelID != nil {
				ids = append(ids, *r.ID.HostelID)
			}
		}
		names, err := a.hostelNames(c, ids)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		rows := []map[string]any{}
		for _, r := range found {
			if window.fromPeriod != "" && (r.ID.Period == nil || *r.ID.Period < window.fromPeriod) {
				continue
			}
			var month any
			if r.ID.Period != nil {
				month = *r.ID.Period
			}
			name := "Unknown hostel"
			if r.ID.HostelID != nil {
				if n, ok := names[*r.ID.HostelID]; ok {
					name = n
				}
			}
			rate := "0.0"
			if r.Due > 0 {
				rate = toFixedText(r.Paid/r.Due*100, 1)
			}
			rows = append(rows, map[string]any{"collectionRatePercent": rate, "dueAmount": r.Due, "hostel": name, "month": month, "paidAmount": r.Paid, "payments": r.Invoices})
		}
		out = export.Report{Columns: []export.Column{{Key: "month", Label: "Month"}, {Key: "hostel", Label: "Hostel"}, {Key: "payments", Label: "Payment records"}, {Key: "dueAmount", Label: "Billed (NPR)"},
			{Key: "paidAmount", Label: "Collected (NPR)"}, {Key: "collectionRatePercent", Label: "Collection rate (%)"}}, FilenamePrefix: "payment-volume", Period: window.label, Rows: rows}
	}
	if err := export.WriteReport(c.Writer, out, format, "", time.Now()); err != nil {
		httpx.Fail(c, err)
	}
}

func (a *Admin) hostelNames(ctx context.Context, ids []bson.ObjectID) (map[bson.ObjectID]string, error) {
	out := map[bson.ObjectID]string{}
	if len(ids) == 0 {
		return out, nil
	}
	cur, err := a.DB.Collection("hostels").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}))
	rows, err := decodeAll[namedHostel](ctx, cur, err)
	for _, h := range rows {
		if h.Name != nil {
			out[h.ID] = *h.Name
		}
	}
	return out, err
}

// platformExportQuery is platformReportExportSchema.
func platformExportQuery(c *gin.Context) (format string, months int, report string, err error) {
	q := valid.Query(c)
	var is valid.Issues
	format, months = exportFormatMonths(q, &is)
	report = q["report"]
	if report != "hostels" && report != "residents" && report != "payments" && report != "complaints" {
		is.Add("report", `Invalid option: expected one of "hostels"|"residents"|"payments"|"complaints"`)
	}
	return format, months, report, is.Err()
}
