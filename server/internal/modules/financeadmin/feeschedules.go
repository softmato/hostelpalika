package financeadmin

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/modules/ledger"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

func (h *Handler) registerFeeSchedules(v1 *gin.RouterGroup) {
	v1.GET("/hostel-admin/finance/fee-schedules", httpx.ETag(), h.listFeeSchedules)
	v1.POST("/hostel-admin/finance/fee-schedules", h.createFeeSchedule)
	v1.POST("/hostel-admin/finance/fee-schedules/kyc", h.kycRates)
	v1.DELETE("/hostel-admin/finance/fee-schedules/:id", h.deleteFeeSchedule)
	v1.POST("/hostel-admin/finance/fee-schedules/:id/close", h.closeFeeSchedule)
}

type rateDoc struct {
	RoomType *string `bson:"roomType"`
	BedType  *string `bson:"bedType"`
	Monthly  int64   `bson:"monthlyAmount"`
	Currency *string `bson:"currency"`
}

type schedDoc struct {
	ID        bson.ObjectID `bson:"_id"`
	From      time.Time     `bson:"effectiveFrom"`
	To        *time.Time    `bson:"effectiveTo"`
	Rates     []rateDoc     `bson:"rates"`
	Admission *int64        `bson:"admissionFee"`
	Form      *int64        `bson:"formFee"`
	Referral  *int64        `bson:"referralAdmissionDiscount"`
	Deposit   *int64        `bson:"depositAmount"`
	Raw       bson.Raw      `bson:"-"`
}

func (r rateDoc) doc() bson.D {
	d := bson.D{}
	if r.RoomType != nil {
		d = append(d, bson.E{Key: "roomType", Value: *r.RoomType})
	}
	var bed any
	if r.BedType != nil {
		bed = *r.BedType
	}
	cur := "NPR"
	if r.Currency != nil {
		cur = *r.Currency
	}
	return append(d, bson.E{Key: "bedType", Value: bed}, bson.E{Key: "monthlyAmount", Value: ledger.JSInt(r.Monthly)}, bson.E{Key: "currency", Value: cur})
}

func rateKey(roomType *string) string {
	if roomType == nil {
		return ""
	}
	return finance.Key(*roomType)
}

func totalOfRates(rates []rateDoc) int64 {
	var t int64
	for _, r := range rates {
		t += r.Monthly
	}
	return t
}

func strp(s string) *string { return &s }

// loadSchedules reads feeschedules matching filter, decoded and raw, in order.
func (h *Handler) loadSchedules(ctx context.Context, filter bson.D, opts ...options.Lister[options.FindOptions]) ([]schedDoc, error) {
	cur, err := h.DB.Collection("feeschedules").Find(ctx, filter, opts...)
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)
	out := []schedDoc{}
	for cur.Next(ctx) {
		var s schedDoc
		if err := cur.Decode(&s); err != nil {
			return nil, err
		}
		s.Raw = append(bson.Raw(nil), cur.Current...)
		out = append(out, s)
	}
	return out, cur.Err()
}

func (h *Handler) loadSchedule(ctx context.Context, filter bson.D, opts ...options.Lister[options.FindOptions]) (*schedDoc, error) {
	rows, err := h.loadSchedules(ctx, filter, append(opts, options.Find().SetLimit(1))...)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return &rows[0], nil
}

// standings is labelSchedules: the newest card covering this BS month is
// current, later starts are upcoming, the rest past.
func standings(rows []schedDoc, now time.Time) ([]string, error) {
	monthStart, err := bs.MonthStart(now)
	if err != nil {
		return nil, err
	}
	period, err := bs.PeriodOf(now)
	if err != nil {
		return nil, err
	}
	b, err := bs.PeriodBounds(period)
	if err != nil {
		return nil, err
	}
	current := -1
	for i, s := range rows {
		if !s.From.After(b.End) && (s.To == nil || !s.To.Before(monthStart)) && (current < 0 || s.From.After(rows[current].From)) {
			current = i
		}
	}
	out := make([]string, len(rows))
	for i, s := range rows {
		switch {
		case i == current:
			out[i] = "current"
		case s.From.After(b.End):
			out[i] = "upcoming"
		default:
			out[i] = "past"
		}
	}
	return out, nil
}

func (h *Handler) listFeeSchedules(c *gin.Context) {
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
	rows, err := h.loadSchedules(c, bson.D{{Key: "hostelId", Value: hostel}}, options.Find().SetSort(bson.D{{Key: "effectiveFrom", Value: -1}}))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	labels, err := standings(rows, time.Now())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	schedules := make([]any, len(rows))
	for i, s := range rows {
		m, _ := ordered.Raw(s.Raw).(ordered.Map)
		schedules[i] = m.Set("standing", labels[i])
	}
	roomTypes, err := (&hostelrooms.Capacity{DB: h.DB}).ListAll(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, struct {
		RoomTypes []hostelrooms.Listed `json:"roomTypes"`
		Schedules []any                `json:"schedules"`
	}{roomTypes, schedules}, "Fee schedules")
}

type scheduleInput struct {
	Admission, Form, Deposit, Referral *int64
	From                               time.Time
	Rates                              []rateDoc
}

var (
	errMonthLocked = finance.Err("FEE_SCHEDULE_MONTH_LOCKED", "Rates can only change from the start of a future month. This month's residents are already being billed at the current rates.")
	errNoSchedule  = finance.Err("FEE_SCHEDULE_MISSING", "Fee schedule was not found.")
)

// createSchedule is createFeeSchedule. Retiring the open card and inserting its
// successor is one transaction: TS deleted or closed the old card first, so a
// failed insert left the hostel with no rate card at all (FIN-7).
func (h *Handler) createSchedule(ctx context.Context, hostel bson.ObjectID, in scheduleInput, p *authz.Principal) (bson.Raw, error) {
	now := time.Now()
	from, err := bs.MonthStart(in.From)
	if err != nil {
		return nil, err
	}
	thisMonth, err := bs.MonthStart(now)
	if err != nil {
		return nil, err
	}
	current, err := h.loadSchedule(ctx, bson.D{{Key: "effectiveTo", Value: nil}, {Key: "hostelId", Value: hostel}})
	if err != nil {
		return nil, err
	}
	period, err := bs.PeriodOf(now)
	if err != nil {
		return nil, err
	}
	inEffect, err := finance.EffectiveSchedule(ctx, h.DB, hostel, period)
	if err != nil {
		return nil, err
	}
	var retire bson.D // nil: nothing; else the write on current
	replace := false
	if current != nil {
		curStart, err := bs.MonthStart(current.From)
		if err != nil {
			return nil, err
		}
		switch {
		case !from.After(thisMonth):
			return nil, errMonthLocked
		case from.Equal(curStart):
			replace = true
		case from.Before(current.From):
			label := bs.FormatPeriod(mustPeriod(current.From))
			if label == "" {
				label = current.From.UTC().Format("2006-01-02")
			}
			return nil, finance.Err("FEE_SCHEDULE_MISSING", "The rate card already changes in "+label+". Replace that one, or pick a later month.")
		default:
			retire = bson.D{{Key: "$set", Value: bson.D{{Key: "effectiveTo", Value: from.Add(-24 * time.Hour)}, {Key: "updatedAt", Value: nowMS()}}}}
		}
	}
	rates := bson.A{}
	for _, r := range in.Rates {
		rates = append(rates, r.doc())
	}
	id := bson.NewObjectID()
	at := nowMS()
	doc := bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: hostel}, {Key: "effectiveFrom", Value: from}, {Key: "effectiveTo", Value: nil}, {Key: "rates", Value: rates}}
	if in.Admission != nil {
		doc = append(doc, bson.E{Key: "admissionFee", Value: ledger.JSInt(*in.Admission)})
	}
	form := int64(0)
	if in.Form != nil {
		form = *in.Form
	}
	doc = append(doc, bson.E{Key: "formFee", Value: ledger.JSInt(form)})
	if in.Referral != nil {
		doc = append(doc, bson.E{Key: "referralAdmissionDiscount", Value: ledger.JSInt(*in.Referral)})
	}
	if in.Deposit != nil {
		doc = append(doc, bson.E{Key: "depositAmount", Value: ledger.JSInt(*in.Deposit)})
	}
	if me, err := bson.ObjectIDFromHex(p.UserID); err == nil {
		doc = append(doc, bson.E{Key: "createdBy", Value: me})
	}
	doc = append(doc, bson.E{Key: "createdAt", Value: at}, bson.E{Key: "updatedAt", Value: at}, bson.E{Key: "__v", Value: 0})
	err = appmongo.InTx(ctx, h.DB, func(ctx context.Context) error {
		col := h.DB.Collection("feeschedules")
		if replace {
			if _, err := col.DeleteOne(ctx, bson.D{{Key: "_id", Value: current.ID}}); err != nil {
				return err
			}
		} else if retire != nil {
			if _, err := col.UpdateOne(ctx, bson.D{{Key: "_id", Value: current.ID}}, retire); err != nil {
				return err
			}
		}
		_, err := col.InsertOne(ctx, doc)
		return err
	})
	if err != nil {
		return nil, err
	}
	h.projectOntoListing(ctx, hostel, in.Admission, &form, in.Rates)
	if inEffect != nil {
		h.notifyRateCard(ctx, hostel, from, inEffect.Rates, in.Rates)
	}
	before := int64(0)
	if current != nil {
		before = totalOfRates(current.Rates)
	}
	if err := h.auditSchedule(ctx, p, audit.Finance{Action: "FEE_SCHEDULE_CREATED", AmountAfter: totalOfRates(in.Rates), AmountBefore: before, EntityID: id.Hex(), EntityType: "FeeSchedule", HostelID: hostel, Source: "FEE_SCHEDULE_EDITOR"}); err != nil {
		return nil, err
	}
	return h.DB.Collection("feeschedules").FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Raw()
}

func mustPeriod(t time.Time) string { p, _ := bs.PeriodOf(t); return p }

func (h *Handler) auditSchedule(ctx context.Context, p *authz.Principal, f audit.Finance) error {
	if h.Audit == nil {
		return nil
	}
	me, _ := bson.ObjectIDFromHex(p.UserID)
	return h.Audit.WriteFinance(ctx, me, string(p.Role), f)
}

// projectOntoListing is projectScheduleOntoListing: the rate card's prices onto
// the public listing's rooms and pricing band. A failure is logged, never thrown.
func (h *Handler) projectOntoListing(ctx context.Context, hostel bson.ObjectID, admission, form *int64, rates []rateDoc) {
	var doc struct {
		Rooms []bson.D `bson:"roomConfigurations"`
	}
	err := h.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "roomConfigurations", Value: 1}})).Decode(&doc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return
	}
	if err != nil {
		slog.ErrorContext(ctx, "Could not project the rate card onto the public listing.", "error", err, "hostelId", hostel.Hex())
		return
	}
	byKey := map[string]int64{}
	for _, r := range rates {
		if r.RoomType != nil && *r.RoomType != "" {
			byKey[rateKey(r.RoomType)] = r.Monthly
		}
	}
	matched := map[string]bool{}
	var lo, hi int64 = math.MaxInt64, 0
	configs := bson.A{}
	for _, cfg := range doc.Rooms {
		var rt string
		for _, e := range cfg {
			if e.Key == "roomType" {
				rt, _ = e.Value.(string)
			}
		}
		if rate, ok := byKey[rateKey(&rt)]; ok {
			matched[rateKey(&rt)] = true
			found := false
			for i := range cfg {
				if cfg[i].Key == "monthlyRent" {
					cfg[i].Value, found = ledger.JSInt(rate), true
				}
			}
			if !found {
				cfg = append(cfg, bson.E{Key: "monthlyRent", Value: ledger.JSInt(rate)})
			}
		}
		for _, e := range cfg {
			if e.Key == "monthlyRent" {
				if n, ok := numberOf(e.Value); ok && n > 0 {
					lo, hi = min(lo, n), max(hi, n)
				}
			}
		}
		configs = append(configs, cfg)
	}
	set := bson.D{{Key: "roomConfigurations", Value: configs}}
	if form != nil {
		set = append(set, bson.E{Key: "pricing.formFee", Value: ledger.JSInt(*form)})
	}
	if admission != nil {
		set = append(set, bson.E{Key: "pricing.admissionFee", Value: ledger.JSInt(*admission)})
	}
	if hi > 0 {
		set = append(set, bson.E{Key: "pricing.monthlyRentMax", Value: ledger.JSInt(hi)}, bson.E{Key: "pricing.monthlyRentMin", Value: ledger.JSInt(lo)})
	}
	if _, err := h.DB.Collection("hostels").UpdateOne(ctx, bson.D{{Key: "_id", Value: hostel}}, bson.D{{Key: "$set", Value: set}}); err != nil {
		slog.ErrorContext(ctx, "Could not project the rate card onto the public listing.", "error", err, "hostelId", hostel.Hex())
		return
	}
	h.Cache.PublicChanged(ctx)
	var onCardOnly []string
	for _, r := range rates {
		if r.RoomType != nil && *r.RoomType != "" && !matched[rateKey(r.RoomType)] {
			onCardOnly = append(onCardOnly, *r.RoomType)
		}
	}
	if len(onCardOnly) > 0 {
		slog.WarnContext(ctx, "Rate card prices room types this hostel does not list.", "hostelId", hostel.Hex(), "roomTypes", onCardOnly)
	}
}

func numberOf(v any) (int64, bool) {
	switch n := v.(type) {
	case int32:
		return int64(n), true
	case int64:
		return n, true
	case float64:
		return int64(n), n == math.Trunc(n)
	}
	return 0, false
}

// notifyRateCard is notifyRateCardChanged: each live resident whose room type's
// rent moves hears the new figure. Failures are logged, never thrown.
func (h *Handler) notifyRateCard(ctx context.Context, hostel bson.ObjectID, from time.Time, previous []finance.Rate, rates []rateDoc) {
	if h.Ledger == nil || h.Ledger.Notify == nil {
		return
	}
	before := map[string]int64{}
	for _, r := range previous {
		if r.RoomType != nil && *r.RoomType != "" && r.MonthlyAmount != nil {
			before[*r.RoomType] = int64(*r.MonthlyAmount)
		}
	}
	after := map[string]int64{}
	changed := false
	for _, r := range rates {
		if r.RoomType != nil && *r.RoomType != "" {
			after[*r.RoomType] = r.Monthly
		}
	}
	for rt, amt := range after {
		if b, ok := before[rt]; !ok || b != amt {
			changed = true
		}
	}
	if !changed {
		return
	}
	warn := func(err error) {
		slog.WarnContext(ctx, "rate_card_notification_failed", "hostelId", hostel.Hex(), "error", err)
	}
	cur, err := h.DB.Collection("residents").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}, {Key: "userId", Value: bson.D{{Key: "$ne", Value: nil}}}},
		options.Find().SetProjection(bson.D{{Key: "roomType", Value: 1}, {Key: "userId", Value: 1}}))
	if err != nil {
		warn(err)
		return
	}
	var rows []struct {
		RoomType string         `bson:"roomType"`
		UserID   *bson.ObjectID `bson:"userId"`
	}
	if err := cur.All(ctx, &rows); err != nil || len(rows) == 0 {
		if err != nil {
			warn(err)
		}
		return
	}
	ids := bson.A{}
	for _, r := range rows {
		if r.UserID != nil {
			ids = append(ids, *r.UserID)
		}
	}
	ucur, err := h.DB.Collection("users").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}, options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		warn(err)
		return
	}
	var users []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := ucur.All(ctx, &users); err != nil || len(users) == 0 {
		if err != nil {
			warn(err)
		}
		return
	}
	live := map[bson.ObjectID]bool{}
	for _, u := range users {
		live[u.ID] = true
	}
	name, _ := residents.HostelName(ctx, h.DB, hostel)
	month := bs.FormatPeriod(mustPeriod(from))
	if month == "" {
		month = from.UTC().Format("2006-01-02")
	}
	for _, r := range rows {
		if r.UserID == nil || r.RoomType == "" || !live[*r.UserID] {
			continue
		}
		next, ok := after[r.RoomType]
		current, had := before[r.RoomType]
		if !ok || (had && next == current) {
			continue
		}
		body := "From " + month + ", " + residents.RoomTypeLabel(r.RoomType) + " at " + name + " is NPR " + money.GroupUS(next) + " a month."
		if had {
			way := "falls"
			if next > current {
				way = "rises"
			}
			body = "From " + month + ", your rent " + way + " from NPR " + money.GroupUS(current) + " to NPR " + money.GroupUS(next) + " a month."
		}
		title := "Your rent is changing"
		if next > current {
			title = "Your rent is going up"
		}
		if _, err := h.Ledger.Notify.CreateInApp(ctx, notifications.Input{Body: body, Category: "PAYMENT", Data: ordered.Map{{Key: "effectiveFrom", Value: httpx.ISO(from)}, {Key: "roomType", Value: r.RoomType}},
			HostelID: hostel.Hex(), Priority: "NORMAL", Title: title, UserID: r.UserID.Hex()}); err != nil {
			warn(err)
		}
	}
}

var bedTypes = []string{"SINGLE", "DOUBLE_SHARING", "TRIPLE_SHARING", "FOUR_SHARING", "DORMITORY"}

// wholeRupees is wholeRupeeSchema; extraMin is a further .min(1, msg).
func wholeRupees(f *valid.Form, key string, opt bool, extraMin string) (*int64, bool) {
	n, ok := f.Num(key, valid.N{Opt: opt, Int: true, IntMsg: "Amount must be a whole number of rupees.", Min: valid.P(0), Max: valid.P(9007199254740991)})
	if extraMin != "" && ok && n < 1 {
		f.Is.Add(key, extraMin)
		ok = false
	} else if extraMin != "" && !ok && f.M[key] != nil {
		if v, isNum := f.M[key].(float64); isNum && v < 0 && v == math.Trunc(v) {
			f.Is.Add(key, extraMin)
		}
	}
	if !ok {
		return nil, false
	}
	v := int64(n)
	return &v, true
}

func (h *Handler) createFeeSchedule(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "manageFeeSchedule")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	var in scheduleInput
	in.Admission, _ = wholeRupees(f, "admissionFee", true, "")
	in.Form, _ = wholeRupees(f, "formFee", true, "")
	in.Deposit, _ = wholeRupees(f, "depositAmount", true, "")
	from, fromOK := valid.CoerceDate(f.M["effectiveFrom"])
	if !fromOK {
		f.Is.Add("effectiveFrom", valid.Type("date", "Date"))
	}
	in.From = from
	requested, _ := f.Str("hostelId", valid.S{Opt: true, Re: hex24, ReMsg: "Invalid object id."})
	in.Referral, _ = wholeRupees(f, "referralAdmissionDiscount", true, "")
	list, listOK := f.Array("rates", false, false)
	ratesOK := listOK
	seen := map[string]bool{}
	unique := true
	for i, raw := range list {
		sub := valid.NewForm(raw)
		if sub.M == nil {
			f.Hard = true
			f.Is.Add("rates."+itoa(i), valid.Type("object", valid.Received(raw, false)))
			ratesOK = false
			continue
		}
		var r rateDoc
		if bed, ok := sub.Enum("bedType", true, nil, bedTypes...); ok {
			r.BedType = strp(bed)
		}
		if cur, ok := sub.Str("currency", valid.S{Opt: true, Trim: true, Max: 8}); ok {
			r.Currency = strp(cur)
		}
		amt, _ := wholeRupees(sub, "monthlyAmount", false, "")
		if amt != nil {
			r.Monthly = *amt
		}
		if rt, ok := sub.Str("roomType", valid.S{Opt: true, Trim: true, Min: 1, Max: 80}); ok {
			r.RoomType = strp(rt)
		}
		if len(sub.Is) == 0 && r.RoomType == nil && r.BedType == nil {
			sub.Is.Add("roomType", "A rate needs a room type.")
		}
		if len(sub.Is) > 0 {
			ratesOK = false
		}
		f.Join("rates."+itoa(i), sub)
		k := ""
		if r.RoomType != nil {
			k = finance.Key(*r.RoomType)
		} else if r.BedType != nil {
			k = finance.Key(*r.BedType)
		}
		if seen[k] {
			unique = false
		}
		seen[k] = true
		if r.RoomType != nil {
			if b := finance.NormalizeBedType(*r.RoomType); b != "" {
				r.BedType = strp(b)
			} else {
				r.BedType = nil
			}
		}
		in.Rates = append(in.Rates, r)
	}
	if listOK {
		f.Size("rates", len(list), 1, 30, "A schedule needs at least one rate.", false)
		if ratesOK && len(list) >= 1 && len(list) <= 30 && !unique {
			f.Is.Add("rates", "Each room type may appear once.")
		}
	}
	if len(f.Is) == 0 {
		var ref, adm int64
		if in.Referral != nil {
			ref = *in.Referral
		}
		if in.Admission != nil {
			adm = *in.Admission
		}
		if ref > adm {
			f.Is.Add("referralAdmissionDiscount", "A referral discount cannot exceed the admission fee.")
		}
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, requested)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	created, err := h.createSchedule(c, hostel, in, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusCreated, ordered.Map{{Key: "schedule", Value: createdOut(created)}}, "Rate card updated")
}

func (h *Handler) scheduleOf(c *gin.Context, hostel bson.ObjectID) (*schedDoc, error) {
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		return nil, err // CastError → 404, as TS
	}
	s, err := h.loadSchedule(c, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: hostel}})
	if err == nil && s == nil {
		err = errNoSchedule
	}
	return s, err
}

func (h *Handler) deleteFeeSchedule(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "manageFeeSchedule")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	s, err := h.scheduleOf(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	label, err := standings([]schedDoc{*s}, time.Now())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if label[0] != "upcoming" {
		httpx.Fail(c, finance.Err("FEE_SCHEDULE_MONTH_LOCKED", "Only rates that have not started yet can be deleted. These are already billing residents."))
		return
	}
	invoiced, err := h.DB.Collection("invoices").CountDocuments(c, bson.D{{Key: "lines.feeScheduleId", Value: s.ID}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if invoiced > 0 {
		httpx.Fail(c, finance.Err("FEE_SCHEDULE_IN_USE", "These rates have already priced "+itoa(int(invoiced))+" invoice(s) and cannot be deleted."))
		return
	}
	var previous *schedDoc
	// One transaction: TS deleted the card and then reopened its predecessor, so a
	// failure between them left the hostel with no open card (FIN-7).
	err = appmongo.InTx(c, h.DB, func(ctx context.Context) error {
		col := h.DB.Collection("feeschedules")
		if _, err := col.DeleteOne(ctx, bson.D{{Key: "_id", Value: s.ID}}); err != nil {
			return err
		}
		prev, err := h.loadSchedule(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$ne", Value: s.ID}}}, {Key: "effectiveFrom", Value: bson.D{{Key: "$lt", Value: s.From}}}, {Key: "hostelId", Value: hostel}},
			options.Find().SetSort(bson.D{{Key: "effectiveFrom", Value: -1}}))
		if err != nil {
			return err
		}
		previous = prev
		if prev == nil {
			return nil
		}
		_, err = col.UpdateOne(ctx, bson.D{{Key: "_id", Value: prev.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "effectiveTo", Value: nil}, {Key: "updatedAt", Value: nowMS()}}}})
		return err
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var restored any
	after := int64(0)
	if previous != nil {
		h.projectOntoListing(c, hostel, previous.Admission, previous.Form, previous.Rates)
		restored, after = previous.ID.Hex(), totalOfRates(previous.Rates)
	}
	if err := h.auditSchedule(c, p, audit.Finance{Action: "FEE_SCHEDULE_CLOSED", AmountAfter: after, AmountBefore: totalOfRates(s.Rates), EntityID: s.ID.Hex(), EntityType: "FeeSchedule", HostelID: hostel,
		Reason: "Upcoming rates deleted before they took effect.", Source: "FEE_SCHEDULE_EDITOR"}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "deletedId", Value: s.ID.Hex()}, {Key: "restoredId", Value: restored}}, "Upcoming rates deleted")
}

func (h *Handler) closeFeeSchedule(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "manageFeeSchedule")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	to, ok := valid.CoerceDate(f.M["effectiveTo"])
	if !ok {
		f.Is.Add("effectiveTo", valid.Type("date", "Date"))
	}
	requested, _ := f.Str("hostelId", valid.S{Opt: true, Re: hex24, ReMsg: "Invalid object id."})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, requested)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	s, err := h.scheduleOf(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if to.Before(s.From) {
		httpx.Fail(c, finance.Err("FEE_SCHEDULE_MISSING", "A schedule cannot close before it starts."))
		return
	}
	if _, err := h.DB.Collection("feeschedules").UpdateOne(c, bson.D{{Key: "_id", Value: s.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "effectiveTo", Value: to}, {Key: "updatedAt", Value: nowMS()}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.auditSchedule(c, p, audit.Finance{Action: "FEE_SCHEDULE_CLOSED", AmountBefore: totalOfRates(s.Rates), EntityID: s.ID.Hex(), EntityType: "FeeSchedule", HostelID: hostel, Source: "FEE_SCHEDULE_EDITOR"}); err != nil {
		httpx.Fail(c, err)
		return
	}
	m, _ := ordered.Raw(s.Raw).(ordered.Map)
	httpx.OK(c, ordered.Map{{Key: "schedule", Value: m.Set("effectiveTo", httpx.ISO(to))}}, "Rate card closed")
}

// kycRates is saveKycRates: the rents typed on Hostel KYC. No card → one from this
// month; an upcoming card → replaced; the current one → edited in place while no
// invoice has used it, else the changed prices start next month.
func (h *Handler) kycRates(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "manageFeeSchedule")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	admission, _ := wholeRupees(f, "admissionFee", true, "")
	deposit, _ := wholeRupees(f, "depositAmount", true, "")
	form, _ := wholeRupees(f, "formFee", true, "")
	requested, _ := f.Str("hostelId", valid.S{Opt: true, Re: hex24, ReMsg: "Invalid object id."})
	list, listOK := f.Array("rates", false, false)
	var typed []rateDoc
	for i, raw := range list {
		sub := valid.NewForm(raw)
		if sub.M == nil {
			f.Hard = true
			f.Is.Add("rates."+itoa(i), valid.Type("object", valid.Received(raw, false)))
			continue
		}
		amt, _ := wholeRupees(sub, "monthlyAmount", false, "Enter a rent above 0.")
		rt, _ := sub.Str("roomType", valid.S{Trim: true, Min: 1, Max: 80})
		f.Join("rates."+itoa(i), sub)
		if amt != nil {
			typed = append(typed, rateDoc{RoomType: strp(rt), Monthly: *amt})
		}
	}
	if listOK {
		f.Size("rates", len(list), 1, 30, "Enter at least one rent.", false)
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, requested)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.saveKycRates(c, hostel, admission, deposit, form, typed, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Rents saved")
}

func firstOf(a, b *int64) *int64 {
	if a != nil {
		return a
	}
	return b
}

func (h *Handler) saveKycRates(ctx context.Context, hostel bson.ObjectID, admission, deposit, form *int64, typed []rateDoc, p *authz.Principal) (ordered.Map, error) {
	open, err := h.loadSchedule(ctx, bson.D{{Key: "effectiveTo", Value: nil}, {Key: "hostelId", Value: hostel}})
	if err != nil {
		return nil, err
	}
	isTyped := func(rt *string) *rateDoc {
		for i := range typed {
			if rateKey(typed[i].RoomType) == rateKey(rt) {
				return &typed[i]
			}
		}
		return nil
	}
	withBed := func(r rateDoc) rateDoc {
		r.BedType = nil
		if r.RoomType != nil {
			if b := finance.NormalizeBedType(*r.RoomType); b != "" {
				r.BedType = strp(b)
			}
		}
		return r
	}
	createFrom := func(from time.Time, base *schedDoc) (ordered.Map, error) {
		in := scheduleInput{From: from, Admission: admission, Deposit: deposit, Form: form}
		zero := int64(0)
		if base != nil {
			in.Admission, in.Deposit, in.Form = firstOf(admission, base.Admission), firstOf(deposit, base.Deposit), firstOf(form, base.Form)
			for _, r := range base.Rates {
				if isTyped(r.RoomType) == nil {
					in.Rates = append(in.Rates, withBed(rateDoc{RoomType: r.RoomType, Monthly: r.Monthly}))
				}
			}
			ref := int64(0)
			if base.Referral != nil {
				ref = *base.Referral
			}
			if a := firstOf(in.Admission, nil); a != nil {
				ref = min(ref, *a)
			} else {
				ref = min(ref, 0)
			}
			if ref != 0 {
				in.Referral = &ref
			}
		}
		if in.Form == nil {
			in.Form = &zero
		}
		for _, r := range typed {
			in.Rates = append(in.Rates, withBed(r))
		}
		raw, err := h.createSchedule(ctx, hostel, in, p)
		if err != nil {
			return nil, err
		}
		return ordered.Map{{Key: "nextMonth", Value: false}, {Key: "schedule", Value: createdOut(raw)}}, nil
	}
	if open == nil {
		return createFrom(time.Now(), nil)
	}
	label, err := standings([]schedDoc{*open}, time.Now())
	if err != nil {
		return nil, err
	}
	if label[0] == "upcoming" {
		return createFrom(open.From, open)
	}
	invoiced, err := h.DB.Collection("invoices").CountDocuments(ctx, bson.D{{Key: "lines.feeScheduleId", Value: open.ID}})
	if err != nil {
		return nil, err
	}
	priced := map[string]int64{}
	for _, r := range open.Rates {
		priced[rateKey(r.RoomType)] = r.Monthly
	}
	differs := func(in, cur *int64) bool { return in != nil && cur != nil && *cur != 0 && *in != *cur }
	changed := false
	if invoiced > 0 {
		for _, r := range typed {
			if amt, ok := priced[rateKey(r.RoomType)]; ok && amt != r.Monthly {
				changed = true
			}
		}
		changed = changed || differs(admission, open.Admission) || differs(deposit, open.Deposit) || differs(form, open.Form)
	}
	rates := []rateDoc{}
	for _, r := range open.Rates {
		if t := isTyped(r.RoomType); invoiced == 0 && t != nil {
			r.Monthly = t.Monthly
		}
		rates = append(rates, r)
	}
	for _, r := range typed {
		if _, ok := priced[rateKey(r.RoomType)]; !ok {
			rates = append(rates, withBed(r))
		}
	}
	keep := func(in, cur *int64) *int64 {
		if invoiced == 0 || cur == nil || *cur == 0 {
			return firstOf(in, cur)
		}
		return cur
	}
	adm, dep, frm := keep(admission, open.Admission), keep(deposit, open.Deposit), keep(form, open.Form)
	zero := int64(0)
	if frm == nil {
		frm = &zero
	}
	ref := int64(0)
	if open.Referral != nil {
		ref = *open.Referral
	}
	if adm != nil {
		ref = min(ref, *adm)
	} else {
		ref = min(ref, 0)
	}
	docs := bson.A{}
	for _, r := range rates {
		docs = append(docs, r.doc())
	}
	set := bson.D{}
	if adm != nil {
		set = append(set, bson.E{Key: "admissionFee", Value: ledger.JSInt(*adm)})
	}
	if dep != nil {
		set = append(set, bson.E{Key: "depositAmount", Value: ledger.JSInt(*dep)})
	}
	set = append(set, bson.E{Key: "formFee", Value: ledger.JSInt(*frm)}, bson.E{Key: "rates", Value: docs}, bson.E{Key: "referralAdmissionDiscount", Value: ledger.JSInt(ref)}, bson.E{Key: "updatedAt", Value: nowMS()})
	if _, err := h.DB.Collection("feeschedules").UpdateOne(ctx, bson.D{{Key: "_id", Value: open.ID}}, bson.D{{Key: "$set", Value: set}}); err != nil {
		return nil, err
	}
	h.projectOntoListing(ctx, hostel, adm, frm, rates)
	if err := h.auditSchedule(ctx, p, audit.Finance{Action: "FEE_SCHEDULE_CREATED", AmountAfter: totalOfRates(rates), AmountBefore: totalOfRates(open.Rates), EntityID: open.ID.Hex(), EntityType: "FeeSchedule", HostelID: hostel,
		Reason: "Rates set on Hostel KYC.", Source: "FEE_SCHEDULE_EDITOR"}); err != nil {
		return nil, err
	}
	if !changed {
		return ordered.Map{{Key: "nextMonth", Value: false}, {Key: "schedule", Value: open.ID.Hex()}}, nil
	}
	updated := *open
	updated.Admission, updated.Deposit, updated.Form, updated.Rates = adm, dep, frm, rates
	period, err := bs.PeriodOf(time.Now())
	if err != nil {
		return nil, err
	}
	nextPeriod, err := bs.AddMonths(period, 1)
	if err != nil {
		return nil, err
	}
	b, err := bs.PeriodBounds(nextPeriod)
	if err != nil {
		return nil, err
	}
	out, err := createFrom(b.Start, &updated)
	if err != nil {
		return nil, err
	}
	return out.Set("nextMonth", true), nil
}

func itoa(n int) string { return strconv.Itoa(n) }

var hex24 = regexp.MustCompile(`(?i)^[a-f\d]{24}$`)

// createdOut is a Model.create() result as JSON: the hydrated document puts _id
// after the schema's own paths, just before the timestamps.
func createdOut(raw bson.Raw) ordered.Map {
	m, _ := ordered.Raw(raw).(ordered.Map)
	id, _ := m.Get("_id")
	out := ordered.Map{}
	for _, p := range m.Delete("_id") {
		if p.Key == "createdAt" {
			out = append(out, ordered.Pair{Key: "_id", Value: id})
		}
		out = append(out, p)
	}
	return out
}
