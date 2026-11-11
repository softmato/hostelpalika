package ledger

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/push"
)

const platformName = "HostelPalika" // PLATFORM_NAME

// --- reference codes (reference-sequence.service.ts) ---

const refMaxSequence = 31*31*31*31 - 1

func validPrefix(p string) bool {
	if len(p) != 3 {
		return false
	}
	for i := 0; i < 3; i++ {
		if p[i] < 'A' || p[i] > 'Z' {
			return false
		}
	}
	return true
}

// derivePrefix is deriveHostelPrefix: the name's first three letters, the last one
// stepped through A-Z on a clash.
func derivePrefix(name string, attempt int) string {
	letters := strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r
		}
		return -1
	}, strings.ToUpper(name))
	base := letters
	if len(base) > 3 {
		base = base[:3]
	}
	if base == "" {
		base = "HST"
	}
	for len(base) < 3 {
		base += "X"
	}
	if attempt == 0 {
		return base
	}
	return base[:2] + string(rune('A'+(attempt-1)%26))
}

// ReferenceCode is generateReferenceCode: PRE-SSSS-C.
func ReferenceCode(prefix string, sequence int64) string {
	enc := make([]byte, 4)
	for i := 3; i >= 0; i-- {
		enc[i] = "0123456789ABCDEFGHJKMNPQRSTVWXY"[sequence%31]
		sequence /= 31
	}
	total, weight := 0, 1
	for i := 0; i < 3; i++ {
		total += int(prefix[i]-'A') * weight
		weight++
	}
	for _, c := range enc {
		total += strings.IndexByte("0123456789ABCDEFGHJKMNPQRSTVWXY", c) * weight
		weight++
	}
	return prefix + "-" + string(enc) + "-" + string("0123456789ABCDEFGHJKMNPQRSTVWXY"[total%31])
}

const refMaxPersonal = 31*31*31 - 1

// PersonalCode is generatePersonalCode: PRE-NNNC, a resident's fixed code.
func PersonalCode(prefix string, number int64) string {
	enc := make([]byte, 3)
	for i := 2; i >= 0; i-- {
		enc[i] = "0123456789ABCDEFGHJKMNPQRSTVWXY"[number%31]
		number /= 31
	}
	total, weight := 0, 1
	for i := 0; i < 3; i++ {
		total += int(prefix[i]-'A') * weight
		weight++
	}
	for _, c := range enc {
		total += strings.IndexByte("0123456789ABCDEFGHJKMNPQRSTVWXY", c) * weight
		weight++
	}
	return prefix + "-" + string(enc) + string("0123456789ABCDEFGHJKMNPQRSTVWXY"[total%31])
}

// MonthCode is generateMonthCode: RUP-482K + 2083-05 → RUP-482K-BHA83, "" when either is bad.
func MonthCode(personal, period string) string {
	p := finance.ParsePersonal(strings.ToUpper(strings.ReplaceAll(personal, "-", "")))
	y, m, ok := bs.PeriodParts(period)
	if p == "" || !ok {
		return ""
	}
	return p + "-" + finance.RefMonthTags[m-1] + strconv.Itoa(100 + y%100)[1:]
}

// EnsureResidentPaymentCode is ensureResidentPaymentCode: the stored code, or a new one
// from the hostel's RESIDENT_CODE counter. Lazy, so it is also the backfill.
func (e *Engine) EnsureResidentPaymentCode(ctx context.Context, hostel, resident bson.ObjectID, prefix string) (string, error) {
	col := e.DB.Collection("residents")
	var r struct {
		Code string `bson:"paymentCode"`
	}
	if err := col.FindOne(ctx, bson.D{{Key: "_id", Value: resident}}, options.FindOne().SetProjection(bson.D{{Key: "paymentCode", Value: 1}})).Decode(&r); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return "", err
	}
	if r.Code != "" {
		return r.Code, nil
	}
	if !validPrefix(prefix) {
		p, err := e.ensurePrefix(ctx, hostel)
		if err != nil {
			return "", err
		}
		prefix = p
	}
	at := now()
	var counter struct {
		Sequence int64 `bson:"sequence"`
	}
	err := e.DB.Collection("receiptcounters").FindOneAndUpdate(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "kind", Value: "RESIDENT_CODE"}, {Key: "period", Value: "LIFETIME"}},
		bson.D{{Key: "$inc", Value: bson.D{{Key: "sequence", Value: 1}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: at}}}, {Key: "$setOnInsert", Value: bson.D{{Key: "__v", Value: 0}, {Key: "createdAt", Value: at}}}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&counter)
	if err != nil {
		return "", err
	}
	if counter.Sequence > refMaxPersonal {
		return "", finance.Err("REFERENCE_PREFIX_MISSING", "This hostel has used all "+strconv.Itoa(refMaxPersonal)+" resident codes.")
	}
	code := PersonalCode(prefix, counter.Sequence)
	if _, err := col.UpdateOne(ctx, bson.D{{Key: "_id", Value: resident}, {Key: "paymentCode", Value: bson.D{{Key: "$in", Value: bson.A{nil, ""}}}}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "paymentCode", Value: code}}}}); err != nil {
		return "", err
	}
	if err := col.FindOne(ctx, bson.D{{Key: "_id", Value: resident}}, options.FindOne().SetProjection(bson.D{{Key: "paymentCode", Value: 1}})).Decode(&r); err != nil || r.Code == "" {
		return "", finance.Err("RESIDENT_NOT_FOUND", "Resident was not found.")
	}
	return r.Code, nil
}

// AllocateMonthCode is allocateMonthCode: the resident's fixed code + BS month.
func (e *Engine) AllocateMonthCode(ctx context.Context, hostel, resident bson.ObjectID, period, prefix string) (string, error) {
	personal, err := e.EnsureResidentPaymentCode(ctx, hostel, resident, prefix)
	if err != nil {
		return "", err
	}
	code := MonthCode(personal, period)
	if code == "" {
		return "", finance.Err("REFERENCE_PREFIX_MISSING", "Cannot make a month code from "+personal+" and "+period+".")
	}
	return code, nil
}

// AllocateReferenceCode is allocateReferenceCode: the hostel's next lifetime code.
func (e *Engine) AllocateReferenceCode(ctx context.Context, hostel bson.ObjectID, prefix string) (string, error) {
	if !validPrefix(prefix) {
		p, err := e.ensurePrefix(ctx, hostel)
		if err != nil {
			return "", err
		}
		prefix = p
	}
	at := now()
	var counter struct {
		Sequence int64 `bson:"sequence"`
	}
	err := e.DB.Collection("receiptcounters").FindOneAndUpdate(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "kind", Value: "REFERENCE"}, {Key: "period", Value: "LIFETIME"}},
		bson.D{{Key: "$inc", Value: bson.D{{Key: "sequence", Value: 1}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: at}}}, {Key: "$setOnInsert", Value: bson.D{{Key: "__v", Value: 0}, {Key: "createdAt", Value: at}}}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&counter)
	if err != nil {
		return "", err
	}
	if counter.Sequence > refMaxSequence {
		return "", finance.Err("REFERENCE_PREFIX_MISSING", "This hostel has exhausted its reference sequence at "+strconv.Itoa(refMaxSequence)+".")
	}
	return ReferenceCode(prefix, counter.Sequence), nil
}

func (e *Engine) ensurePrefix(ctx context.Context, hostel bson.ObjectID) (string, error) {
	var h struct {
		Name   string `bson:"name"`
		Prefix string `bson:"referencePrefix"`
	}
	col := e.DB.Collection("hostels")
	err := col.FindOne(ctx, bson.D{{Key: "_id", Value: hostel}}).Decode(&h)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return "", finance.Err("HOSTEL_SCOPE_REQUIRED", "Hostel was not found.")
	}
	if err != nil {
		return "", err
	}
	if validPrefix(h.Prefix) {
		return h.Prefix, nil
	}
	for attempt := 0; attempt <= 26; attempt++ {
		candidate := derivePrefix(h.Name, attempt)
		res, err := col.UpdateOne(ctx, bson.D{{Key: "_id", Value: hostel}, {Key: "referencePrefix", Value: bson.D{{Key: "$in", Value: bson.A{nil, ""}}}}}, bson.D{{Key: "$set", Value: bson.D{{Key: "referencePrefix", Value: candidate}}}})
		if err != nil && !mongo.IsDuplicateKeyError(err) {
			return "", err
		}
		if err == nil && res.ModifiedCount > 0 {
			return candidate, nil
		}
		if err == nil {
			if col.FindOne(ctx, bson.D{{Key: "_id", Value: hostel}}).Decode(&h) == nil && validPrefix(h.Prefix) {
				return h.Prefix, nil
			}
		}
	}
	return "", finance.Err("REFERENCE_PREFIX_MISSING", "Could not find a free reference prefix for this hostel.")
}

// --- adjustments (invoice-adjust.ts) ---

func lineField(l bson.D, key string) any {
	for _, e := range l {
		if e.Key == key {
			return e.Value
		}
	}
	return nil
}

func lineAmount(l bson.D) int64 {
	switch n := lineField(l, "amount").(type) {
	case int32:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	}
	return 0
}

// SetAdjustment is setAdjustment: one taking-off line per kind (LEAVE, MOVE_OUT,
// WRITE_OFF) on a bill, replaced on re-run; paid money above the new total becomes credit.
func (e *Engine) SetAdjustment(ctx context.Context, invoiceID bson.ObjectID, kind, description string, takeOff int64, p *authz.Principal) (after, before, taken int64, ok bool, err error) {
	var inv struct {
		HostelID   bson.ObjectID `bson:"hostelId"`
		ResidentID bson.ObjectID `bson:"residentId"`
		Lines      []bson.D      `bson:"lines"`
		Status     string        `bson:"status"`
		Total      int64         `bson:"totalAmount"`
	}
	err = e.DB.Collection("invoices").FindOne(ctx, bson.D{{Key: "_id", Value: invoiceID}}).Decode(&inv)
	if errors.Is(err, mongo.ErrNoDocuments) || (err == nil && inv.Status == "VOID") {
		return 0, 0, 0, false, nil
	}
	if err != nil {
		return 0, 0, 0, false, err
	}
	before = inv.Total
	lines := bson.A{}
	var rest int64
	for _, l := range inv.Lines {
		if s, _ := lineField(l, "adjust").(string); s == kind {
			continue
		}
		lines = append(lines, l)
		rest += lineAmount(l)
	}
	taken = max(0, min(takeOff, rest))
	if taken > 0 {
		lines = append(lines, bson.D{{Key: "description", Value: description}, {Key: "bedType", Value: nil}, {Key: "amount", Value: JSInt(-taken)}, {Key: "basis", Value: "CREDIT"}, {Key: "adjust", Value: kind}})
	}
	after = rest - taken
	if after == before {
		return after, before, taken, true, nil
	}
	if _, err = e.DB.Collection("invoices").UpdateOne(ctx, bson.D{{Key: "_id", Value: invoiceID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "lines", Value: lines}, {Key: "totalAmount", Value: JSInt(after)}, {Key: "updatedAt", Value: now()}}},
		{Key: "$inc", Value: bson.D{{Key: "__v", Value: 1}}}}); err != nil {
		return
	}
	bal, err := e.RecomputeInvoiceBalance(ctx, invoiceID)
	if err != nil {
		return
	}
	if _, err = e.SetConcessionCredit(ctx, inv.HostelID, inv.ResidentID, invoiceID, max(bal.SettledAmount-after, 0), strings.ToLower(kind), description+", already paid"); err != nil {
		return
	}
	if p != nil && e.Audit != nil {
		me, _ := bson.ObjectIDFromHex(p.UserID)
		err = e.Audit.WriteFinance(ctx, me, string(p.Role), audit.Finance{Action: "INVOICE_ADJUSTED", AmountAfter: after, AmountBefore: before, EntityID: invoiceID.Hex(), EntityType: "Invoice",
			HostelID: inv.HostelID, InvoiceID: invoiceID.Hex(), Reason: description, Source: kind})
	}
	return after, before, taken, true, err
}

// ApplyLeaveToBill is applyLeaveToBill: the month's ACTIVE leaves as one LEAVE line
// on its rent bill. Returns the bill, nil when the month is not billed yet.
func (e *Engine) ApplyLeaveToBill(ctx context.Context, hostel, resident bson.ObjectID, period string, p *authz.Principal) (*bson.ObjectID, error) {
	var bill struct {
		ID bson.ObjectID `bson:"_id"`
	}
	err := e.DB.Collection("invoices").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "kind", Value: "MONTHLY_RENT"}, {Key: "period", Value: period}, {Key: "residentId", Value: resident}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "VOID"}}}}).Decode(&bill)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	cur, err := e.DB.Collection("residentleaves").Find(ctx, bson.D{{Key: "period", Value: period}, {Key: "residentId", Value: resident}, {Key: "status", Value: "ACTIVE"}})
	if err != nil {
		return nil, err
	}
	var leaves []struct {
		ID     bson.ObjectID `bson:"_id"`
		Amount int64         `bson:"amount"`
		Days   int64         `bson:"days"`
	}
	if err := cur.All(ctx, &leaves); err != nil {
		return nil, err
	}
	var total, days int64
	ids := bson.A{}
	for _, l := range leaves {
		total, days = total+l.Amount, days+l.Days
		ids = append(ids, l.ID)
	}
	unit := "days"
	if days == 1 {
		unit = "day"
	}
	month := bs.FormatPeriod(period)
	if month == "" {
		month = period
	}
	if _, _, _, _, err := e.SetAdjustment(ctx, bill.ID, "LEAVE", "Days away — "+strconv.FormatInt(days, 10)+" "+unit+" in "+month, total, p); err != nil {
		return nil, err
	}
	if _, err := e.DB.Collection("residentleaves").UpdateMany(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, bson.D{{Key: "$set", Value: bson.D{{Key: "invoiceId", Value: bill.ID}, {Key: "updatedAt", Value: now()}}}}); err != nil {
		return nil, err
	}
	return &bill.ID, nil
}

// ApplyPendingFeeOffs is applyPendingFeeOffsQuietly: each FEE_OFF award the
// resident is waiting on goes onto their oldest open rent bill, as a settled
// OFFER_PROGRAM payment. Failures are logged, never thrown.
func (e *Engine) ApplyPendingFeeOffs(ctx context.Context, resident bson.ObjectID) {
	warn := func(err error) {
		slog.WarnContext(ctx, "offer_fee_off_apply_failed", "residentId", resident.Hex(), "error", err)
	}
	cur, err := e.DB.Collection("offerawards").Find(ctx, bson.D{{Key: "kind", Value: "FEE_OFF"}, {Key: "residentId", Value: resident}, {Key: "status", Value: "AWARDED"}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: 1}}))
	if err != nil {
		warn(err)
		return
	}
	var awards []struct {
		ID         bson.ObjectID `bson:"_id"`
		HostelID   bson.ObjectID `bson:"hostelId"`
		PercentOff float64       `bson:"percentOff"`
		Title      string        `bson:"title"`
	}
	if err := cur.All(ctx, &awards); err != nil {
		warn(err)
		return
	}
	hostels := map[string]bool{}
	for _, a := range awards {
		var inv struct {
			ID    bson.ObjectID `bson:"_id"`
			Total int64         `bson:"totalAmount"`
		}
		err := e.DB.Collection("invoices").FindOne(ctx, bson.D{{Key: "hostelId", Value: a.HostelID}, {Key: "kind", Value: "MONTHLY_RENT"}, {Key: "residentId", Value: resident},
			{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"OPEN", "PARTIAL", "OVERDUE"}}}}, {Key: "totalAmount", Value: bson.D{{Key: "$gt", Value: 0}}}},
			options.FindOne().SetSort(bson.D{{Key: "period", Value: 1}})).Decode(&inv)
		if errors.Is(err, mongo.ErrNoDocuments) {
			break
		}
		if err != nil {
			warn(err)
			return
		}
		amount := int64(jsRound(float64(inv.Total) * a.PercentOff / 100))
		if amount < 1 {
			continue
		}
		id := inv.ID
		ev, _, err := e.AppendEvent(ctx, AppendInput{Amount: amount, Confirmation: "MANUAL_REVIEW", HostelID: a.HostelID, IdempotencyKey: "offer-award:" + a.ID.Hex(), InvoiceID: &id,
			RawPayload: bson.D{{Key: "awardId", Value: a.ID.Hex()}, {Key: "fundedBy", Value: platformName}, {Key: "perk", Value: a.Title}}, ResidentID: &resident, Source: "OFFER_PROGRAM", Status: "PENDING"})
		if err != nil {
			warn(err)
			return
		}
		if ev.Status == "PENDING" {
			if _, err := e.SettleEvent(ctx, ev.ID, SettleOptions{Confirmation: "MANUAL_REVIEW"}); err != nil {
				var he *httpx.Error
				if !errors.As(err, &he) || he.ErrorCode != "SETTLED_EVENT_IMMUTABLE" {
					warn(err)
					return
				}
			}
		}
		applied := id
		if ev.InvoiceID != nil {
			applied = *ev.InvoiceID
		}
		if _, err := e.DB.Collection("offerawards").UpdateOne(ctx, bson.D{{Key: "_id", Value: a.ID}, {Key: "status", Value: "AWARDED"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "appliedAmount", Value: JSInt(ev.Amount)},
			{Key: "appliedAt", Value: now()}, {Key: "appliedEventId", Value: ev.ID}, {Key: "appliedInvoiceId", Value: applied}, {Key: "status", Value: "APPLIED"}, {Key: "updatedAt", Value: now()}}}}); err != nil {
			warn(err)
			return
		}
		hostels[a.HostelID.Hex()] = true
	}
	if e.Bump != nil {
		for h := range hostels {
			e.Bump.Bump(ctx, h)
		}
	}
}

// jsRound is Math.round: halves go up, toward +∞.
func jsRound(f float64) float64 {
	r := float64(int64(f))
	if f-r >= 0.5 {
		r++
	} else if f < 0 && r-f > 0.5 {
		r--
	}
	return r
}

// --- billing runs (billing.service.ts) ---

// BilledInvoice is one invoice a run issued.
type BilledInvoice struct {
	Amount        int64  `json:"amount"`
	CreditApplied int64  `json:"creditApplied"`
	DueDate       string `json:"dueDate"`
	InvoiceID     string `json:"invoiceId"`
	ReferenceCode string `json:"referenceCode"`
	ResidentID    string `json:"residentId"`
}

// BillingSkip is a resident a run passed over, and why.
type BillingSkip struct {
	Detail     *string `json:"detail,omitempty"`
	Reason     string  `json:"reason"`
	ResidentID string  `json:"residentId"`
}

// BillingFailure is a resident a run could not price.
type BillingFailure struct {
	ErrorCode  string `json:"errorCode"`
	Message    string `json:"message"`
	ResidentID string `json:"residentId"`
}

// BillingResult is BillingCycleResult.
type BillingResult struct {
	Billed      []BilledInvoice  `json:"billed"`
	Failures    []BillingFailure `json:"failures"`
	Period      string           `json:"period"`
	Skipped     []BillingSkip    `json:"skipped"`
	TotalBilled int64            `json:"totalBilled"`
}

type billableRow struct {
	finance.Billable `bson:",inline"`
	LastMonthCharge  *string `bson:"lastMonthCharge"`
	PaidTill         *string `bson:"paidTill"`
}

// BillableResidents is findBillableResidents: living here this month, or moved out inside it.
func (e *Engine) BillableResidents(ctx context.Context, hostel bson.ObjectID, period string, ids bson.A) ([]billableRow, error) {
	b, err := bs.PeriodBounds(period)
	if err != nil {
		return nil, finance.Err("FEE_SCHEDULE_MISSING", err.Error())
	}
	filter := bson.D{{Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "stayEndsAt", Value: nil},
		{Key: "$or", Value: bson.A{bson.D{{Key: "status", Value: "ACTIVE"}}, bson.D{{Key: "moveOutDate", Value: bson.D{{Key: "$gte", Value: b.Start}}}, {Key: "status", Value: "MOVED_OUT"}}}}}
	if len(ids) > 0 {
		filter = append(filter, bson.E{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}})
	}
	cur, err := e.DB.Collection("residents").Find(ctx, filter)
	if err != nil {
		return nil, err
	}
	var rows []billableRow
	return rows, cur.All(ctx, &rows)
}

// billedMoveOut is billedMoveOut: FULL_MONTH bills the leaving month whole.
func billedMoveOut(r *billableRow, period string) (*time.Time, error) {
	if r.LastMonthCharge == nil || *r.LastMonthCharge != "FULL_MONTH" || r.MoveOutDate == nil {
		return r.MoveOutDate, nil
	}
	b, err := finance.ResidentBounds(&r.Billable, period)
	if err != nil {
		return nil, err
	}
	if !r.MoveOutDate.Before(b.Start) {
		return nil, nil
	}
	return r.MoveOutDate, nil
}

func ordinalDay(day int) string {
	suffix := "th"
	if t := day % 100; t < 11 || t > 13 {
		switch day % 10 {
		case 1:
			suffix = "st"
		case 2:
			suffix = "nd"
		case 3:
			suffix = "rd"
		}
	}
	return strconv.Itoa(day) + suffix
}

type billingPlan struct {
	amount         int64
	bedType        string
	basis          string
	bounds         bs.Bounds
	concessionNote string
	// FIN-9: amount is the full rent; a month discount is its own CREDIT line keyed
	// by concessionPercent, so a later edit of the discount replaces it, never stacks.
	concession, discount int64
	scheduleID           *bson.ObjectID
	proration            *string
	resident             *billableRow
}

func planBilling(rows []billableRow, s *finance.Schedule, period string, listed map[string]float64, percentOff int64, reason string, today time.Time) ([]billingPlan, []BillingSkip, []BillingFailure, error) {
	plans, skipped, failures := []billingPlan{}, []BillingSkip{}, []BillingFailure{}
	for i := range rows {
		r := &rows[i]
		id := r.ID.Hex()
		if finance.PaidBeforeJoining(r.PaidTill, period) {
			skipped = append(skipped, BillingSkip{Reason: "PAID_BEFORE_JOINING", ResidentID: id})
			continue
		}
		plan, skip, err := func() (*billingPlan, *BillingSkip, error) {
			b, err := finance.ResidentBounds(&r.Billable, period)
			if err != nil {
				return nil, nil, err
			}
			if finance.NotYetDue(&r.Billable, b, today) {
				return nil, &BillingSkip{Reason: "NOT_YET_DUE", ResidentID: id}, nil
			}
			ch, err := finance.MonthlyCharge(&r.Billable, s, listed, percentOff)
			if err != nil {
				return nil, nil, err
			}
			out, err := billedMoveOut(r, period)
			if err != nil {
				return nil, nil, err
			}
			amt, err := finance.ComputeInvoiceAmount(ch.Amount, r.MoveInDate, out, b)
			if err != nil {
				return nil, nil, err
			}
			if amt.Amount <= 0 {
				reason := "NO_BILLABLE_DAYS"
				switch {
				case amt.NotResident:
					reason = "NOT_YET_RESIDENT"
				case amt.MovedOut:
					reason = "ALREADY_MOVED_OUT"
				case amt.Proration != nil && *amt.Proration == "no billable days":
				case ch.Amount == 0:
					reason = "ZERO_CHARGE"
				}
				return nil, &BillingSkip{Detail: amt.Proration, Reason: reason, ResidentID: id}, nil
			}
			full := amt
			if ch.ConcessionPercent > 0 {
				if full, err = finance.ComputeInvoiceAmount(ch.FullAmount, r.MoveInDate, out, b); err != nil {
					return nil, nil, err
				}
			}
			note := ""
			if ch.ConcessionPercent > 0 {
				note = strconv.FormatInt(ch.ConcessionPercent, 10) + "% off"
				if reason != "" {
					note = reason + " · " + note
				}
			}
			return &billingPlan{amount: full.Amount, bedType: ch.BedType, basis: ch.Basis, bounds: b, concessionNote: note, concession: ch.ConcessionPercent,
				discount: full.Amount - amt.Amount, scheduleID: ch.FeeScheduleID, proration: amt.Proration, resident: r}, nil, nil
		}()
		var he *httpx.Error
		switch {
		case err != nil && errors.As(err, &he):
			failures = append(failures, BillingFailure{he.ErrorCode, he.Message, id})
		case err != nil:
			return nil, nil, nil, err
		case skip != nil:
			skipped = append(skipped, *skip)
		default:
			plans = append(plans, *plan)
		}
	}
	return plans, skipped, failures, nil
}

type khataLine struct {
	amount      int64
	description string
	ids         bson.A
}

// unbilledKhata is unbilledKhata: GIVEN, unbilled entries decided before the month, per resident.
func (e *Engine) unbilledKhata(ctx context.Context, residents bson.A, before time.Time) (map[string]*khataLine, error) {
	cur, err := e.DB.Collection("khataentries").Find(ctx, bson.D{{Key: "decidedAt", Value: bson.D{{Key: "$lt", Value: before}}}, {Key: "invoiceId", Value: nil}, {Key: "residentId", Value: bson.D{{Key: "$in", Value: residents}}}, {Key: "status", Value: "GIVEN"}},
		options.Find().SetProjection(bson.D{{Key: "amount", Value: 1}, {Key: "name", Value: 1}, {Key: "quantity", Value: 1}, {Key: "residentId", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID       bson.ObjectID `bson:"_id"`
		Amount   int64         `bson:"amount"`
		Name     string        `bson:"name"`
		Quantity int64         `bson:"quantity"`
		Resident bson.ObjectID `bson:"residentId"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	type count struct {
		name string
		qty  int64
	}
	counts := map[string][]count{}
	out := map[string]*khataLine{}
	for _, r := range rows {
		k := r.Resident.Hex()
		if out[k] == nil {
			out[k] = &khataLine{ids: bson.A{}}
		}
		out[k].amount += r.Amount
		out[k].ids = append(out[k].ids, r.ID)
		found := false
		for i := range counts[k] {
			if counts[k][i].name == r.Name {
				counts[k][i].qty += r.Quantity
				found = true
			}
		}
		if !found {
			counts[k] = append(counts[k], count{r.Name, r.Quantity})
		}
	}
	for k, line := range out {
		parts := make([]string, len(counts[k]))
		for i, c := range counts[k] {
			parts[i] = c.name + " ×" + strconv.FormatInt(c.qty, 10)
		}
		summary := strings.Join(parts, ", ")
		if u := []rune(summary); len(u) > 90 {
			summary = string(u[:87]) + "…"
		}
		line.description = "Khata — " + summary
	}
	return out, nil
}

// BillingInput is BillingCycleInput.
type BillingInput struct {
	DueDate     *time.Time
	HostelID    bson.ObjectID
	Period      string
	ResidentIDs bson.A
}

// RunBillingCycle is runBillingCycle: one MONTHLY_RENT invoice per billable
// resident, khata and credit folded in. Each invoice, its khata mark and its credit
// line are one transaction (R28): TS wrote them in three steps, so a crash between
// them left khata billed twice or credit spent on a bill that never showed it.
func (e *Engine) RunBillingCycle(ctx context.Context, in BillingInput, p *authz.Principal) (*BillingResult, error) {
	b, err := bs.PeriodBounds(in.Period)
	if err != nil {
		return nil, finance.Err("FEE_SCHEDULE_MISSING", err.Error())
	}
	var settings struct {
		LateFine *struct {
			Enabled   *bool `bson:"enabled"`
			GraceDays *int  `bson:"graceDays"`
		} `bson:"lateFine"`
	}
	if err := e.DB.Collection("hostelsettings").FindOne(ctx, bson.D{{Key: "hostelId", Value: in.HostelID}}).Decode(&settings); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	fineOn, grace := false, 5
	if l := settings.LateFine; l != nil {
		fineOn = l.Enabled != nil && *l.Enabled
		if l.GraceDays != nil {
			grace = *l.GraceDays
		}
	}
	today := bs.Today(time.Now())
	dueFor := func(bounds bs.Bounds) time.Time {
		if in.DueDate != nil {
			return *in.DueDate
		}
		if !fineOn {
			return bounds.LastDay
		}
		fine := func(t time.Time) time.Time { return t.Add(time.Duration(grace-1) * 24 * time.Hour) }
		if a, t := fine(bounds.Start), fine(today); a.After(t) {
			return a
		} else {
			return t
		}
	}
	var hostel struct {
		Prefix string   `bson:"referencePrefix"`
		Rooms  []bson.D `bson:"roomConfigurations"`
	}
	err = e.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: in.HostelID}}).Decode(&hostel)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, finance.Err("HOSTEL_SCOPE_REQUIRED", "Hostel was not found.")
	}
	if err != nil {
		return nil, err
	}
	rows, err := e.BillableResidents(ctx, in.HostelID, in.Period, in.ResidentIDs)
	if err != nil {
		return nil, err
	}
	schedule, err := finance.EffectiveSchedule(ctx, e.DB, in.HostelID, in.Period)
	if err != nil {
		return nil, err
	}
	var concession struct {
		PercentOff int64  `bson:"percentOff"`
		Reason     string `bson:"reason"`
	}
	if err := e.DB.Collection("rentconcessions").FindOne(ctx, bson.D{{Key: "hostelId", Value: in.HostelID}, {Key: "period", Value: in.Period}}).Decode(&concession); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	listed := finance.ListedRates(hostel.Rooms)
	plans, skipped, failures, err := planBilling(rows, schedule, in.Period, listed, concession.PercentOff, concession.Reason, today)
	if err != nil {
		return nil, err
	}
	month := bs.FormatPeriod(in.Period)
	if month == "" {
		month = in.Period
	}
	if len(listed) == 0 {
		for _, f := range failures {
			if f.ErrorCode == "FEE_SCHEDULE_MISSING" {
				return nil, finance.Err("FEE_SCHEDULE_MISSING", "No fee schedule covers "+month+", and no room type has a listed rent. No invoices were issued.")
			}
		}
	}
	planned := bson.A{}
	for _, pl := range plans {
		planned = append(planned, pl.resident.ID)
	}
	cur, err := e.DB.Collection("invoices").Find(ctx, bson.D{{Key: "hostelId", Value: in.HostelID}, {Key: "kind", Value: "MONTHLY_RENT"}, {Key: "period", Value: in.Period},
		{Key: "residentId", Value: bson.D{{Key: "$in", Value: planned}}}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "VOID"}}}}, options.Find().SetProjection(bson.D{{Key: "residentId", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var existing []struct {
		Resident bson.ObjectID `bson:"residentId"`
	}
	if err := cur.All(ctx, &existing); err != nil {
		return nil, err
	}
	already := map[string]bool{}
	for _, x := range existing {
		already[x.Resident.Hex()] = true
	}
	khata, err := e.unbilledKhata(ctx, planned, b.Start)
	if err != nil {
		return nil, err
	}
	billed := []BilledInvoice{}
	for _, pl := range plans {
		rid := pl.resident.ID
		if already[rid.Hex()] {
			skipped = append(skipped, BillingSkip{Reason: "ALREADY_BILLED", ResidentID: rid.Hex()})
			continue
		}
		ref, err := e.AllocateMonthCode(ctx, in.HostelID, rid, in.Period, hostel.Prefix)
		if err != nil {
			return nil, err
		}
		kh := khata[rid.Hex()]
		total := pl.amount - pl.discount
		if kh != nil {
			total += kh.amount
		}
		due := dueFor(pl.bounds)
		covers := month
		if day := finance.BillDay(&pl.resident.Billable); day > 0 {
			span, _ := bs.FormatDayRange(pl.bounds.Start, pl.bounds.LastDay)
			if span == "" {
				span = bs.FormatPeriod(in.Period)
			}
			covers = span + " · bills on the " + ordinalDay(day)
		}
		desc := "Monthly rent — " + covers
		var bed, schedID any
		if pl.bedType != "" {
			bed = pl.bedType
		}
		if pl.scheduleID != nil {
			schedID = *pl.scheduleID
		}
		rent := bson.D{{Key: "description", Value: desc}, {Key: "bedType", Value: bed}, {Key: "amount", Value: JSInt(pl.amount)}, {Key: "basis", Value: pl.basis}, {Key: "feeScheduleId", Value: schedID}}
		if pl.proration != nil {
			rent = append(rent, bson.E{Key: "prorationBasis", Value: *pl.proration})
		}
		lines := bson.A{rent}
		if pl.discount > 0 {
			monthName := bs.FormatPeriod(in.Period)
			if monthName == "" {
				monthName = in.Period
			}
			lines = append(lines, bson.D{{Key: "description", Value: pl.concessionNote + " — " + monthName}, {Key: "bedType", Value: nil}, {Key: "amount", Value: JSInt(-pl.discount)},
				{Key: "basis", Value: "CREDIT"}, {Key: "concessionPercent", Value: JSInt(pl.concession)}})
		}
		if kh != nil {
			lines = append(lines, bson.D{{Key: "description", Value: kh.description}, {Key: "bedType", Value: nil}, {Key: "amount", Value: JSInt(kh.amount)}, {Key: "basis", Value: "KHATA"}})
		}
		id := bson.NewObjectID()
		at := now()
		doc := bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: in.HostelID}, {Key: "residentId", Value: rid}, {Key: "period", Value: in.Period}, {Key: "kind", Value: "MONTHLY_RENT"},
			{Key: "lines", Value: lines}, {Key: "totalAmount", Value: JSInt(total)}, {Key: "currency", Value: "NPR"}, {Key: "dueDate", Value: due}, {Key: "coversFrom", Value: pl.bounds.Start},
			{Key: "coversTo", Value: pl.bounds.LastDay}, {Key: "issuedAt", Value: at}, {Key: "status", Value: "OPEN"}, {Key: "referenceCode", Value: strings.ToUpper(ref)}, {Key: "legacyPaymentId", Value: nil},
			{Key: "dunning", Value: bson.D{{Key: "lastNotifiedAt", Value: nil}, {Key: "chaseCount", Value: 0}, {Key: "stage", Value: "NONE"}}}, {Key: "fineWaived", Value: false}}
		if p != nil {
			if me, err := bson.ObjectIDFromHex(p.UserID); err == nil {
				doc = append(doc, bson.E{Key: "createdBy", Value: me})
			}
		}
		doc = append(doc, bson.E{Key: "createdAt", Value: at}, bson.E{Key: "updatedAt", Value: at}, bson.E{Key: "__v", Value: 0})
		var credit int64
		err = appmongo.InTx(ctx, e.DB, func(ctx context.Context) error {
			credit = 0
			if _, err := e.DB.Collection("invoices").InsertOne(ctx, doc); err != nil {
				return err
			}
			if kh != nil && len(kh.ids) > 0 {
				if _, err := e.DB.Collection("khataentries").UpdateMany(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: kh.ids}}}, {Key: "invoiceId", Value: nil}},
					bson.D{{Key: "$set", Value: bson.D{{Key: "invoiceId", Value: id}, {Key: "updatedAt", Value: at}}}}); err != nil {
					return err
				}
			}
			applied, err := e.ApplyCredit(ctx, in.HostelID, rid, id, total)
			if err != nil || applied <= 0 {
				return err
			}
			credit = applied
			_, err = e.DB.Collection("invoices").UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$push", Value: bson.D{{Key: "lines", Value: bson.D{{Key: "description", Value: "Credit from earlier overpayment"},
				{Key: "bedType", Value: nil}, {Key: "amount", Value: JSInt(-applied)}, {Key: "basis", Value: "CREDIT"}}}}}, {Key: "$set", Value: bson.D{{Key: "totalAmount", Value: JSInt(total - applied)}, {Key: "updatedAt", Value: now()}}}})
			return err
		})
		if mongo.IsDuplicateKeyError(err) {
			skipped = append(skipped, BillingSkip{Reason: "ALREADY_BILLED", ResidentID: rid.Hex()})
			continue
		}
		if err != nil {
			return nil, err
		}
		billed = append(billed, BilledInvoice{total - credit, credit, httpx.ISO(due), id.Hex(), ref, rid.Hex()})
	}
	if len(billed) > 0 {
		ids := bson.A{}
		for _, x := range billed {
			oid, _ := bson.ObjectIDFromHex(x.ResidentID)
			ids = append(ids, oid)
		}
		var waiting []bson.ObjectID
		if err := e.DB.Collection("residentleaves").Distinct(ctx, "residentId", bson.D{{Key: "hostelId", Value: in.HostelID}, {Key: "period", Value: in.Period}, {Key: "residentId", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "status", Value: "ACTIVE"}}).Decode(&waiting); err != nil {
			return nil, err
		}
		for _, r := range waiting {
			if _, err := e.ApplyLeaveToBill(ctx, in.HostelID, r, in.Period, nil); err != nil {
				return nil, err
			}
		}
		var offers []bson.ObjectID
		if err := e.DB.Collection("offerawards").Distinct(ctx, "residentId", bson.D{{Key: "kind", Value: "FEE_OFF"}, {Key: "residentId", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "status", Value: "AWARDED"}}).Decode(&offers); err != nil {
			return nil, err
		}
		for _, r := range offers {
			e.ApplyPendingFeeOffs(ctx, r)
		}
	}
	amounts := make([]int64, len(billed))
	for i, x := range billed {
		amounts[i] = x.Amount
	}
	totalBilled, err := money.Sum(amounts)
	if err != nil {
		return nil, err
	}
	if p != nil && e.Audit != nil {
		me, _ := bson.ObjectIDFromHex(p.UserID)
		if err := e.Audit.WriteFinance(ctx, me, string(p.Role), audit.Finance{Action: "BILLING_CYCLE_RUN", AmountAfter: totalBilled, EntityID: in.HostelID.Hex(), EntityType: "Hostel", HostelID: in.HostelID,
			Reason: strconv.Itoa(len(billed)) + " issued, " + strconv.Itoa(len(skipped)) + " skipped, " + strconv.Itoa(len(failures)) + " failed", Source: "BILLING_CYCLE"}); err != nil {
			return nil, err
		}
	}
	return &BillingResult{billed, failures, in.Period, skipped, totalBilled}, nil
}

// NotifyInvoicesRaised is notifyInvoicesRaised: each billed resident with an
// account gets the amount in the bell, and one push says the bill is ready.
func (e *Engine) NotifyInvoicesRaised(ctx context.Context, hostel bson.ObjectID, period string, billed []BilledInvoice) {
	if e.Notify == nil {
		return
	}
	month := bs.FormatPeriod(period)
	if month == "" {
		month = period
	}
	ids := bson.A{}
	for _, b := range billed {
		if b.Amount > 0 {
			oid, _ := bson.ObjectIDFromHex(b.ResidentID)
			ids = append(ids, oid)
		}
	}
	if len(ids) == 0 {
		return
	}
	cur, err := e.DB.Collection("residents").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "userId", Value: 1}}))
	if err != nil {
		e.warn(ctx, "invoice raised notification", err)
		return
	}
	var rows []struct {
		ID   bson.ObjectID  `bson:"_id"`
		User *bson.ObjectID `bson:"userId"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		e.warn(ctx, "invoice raised notification", err)
		return
	}
	userOf := map[string]string{}
	for _, r := range rows {
		if r.User != nil {
			userOf[r.ID.Hex()] = r.User.Hex()
		}
	}
	var users []string
	dataByUser := map[string]map[string]any{}
	for _, b := range billed {
		user, ok := userOf[b.ResidentID]
		if b.Amount <= 0 || !ok {
			continue
		}
		data := ordered.Map{{Key: "invoiceId", Value: b.InvoiceID}, {Key: "type", Value: "INVOICE_RAISED"}}
		if _, err := e.Notify.CreateInApp(ctx, notifications.Input{Body: "Your rent for " + month + " is NPR " + money.GroupUS(b.Amount) + ".", Category: "PAYMENT", Data: data,
			HostelID: hostel.Hex(), NoPush: true, Title: "Rent bill ready", UserID: user}); err != nil {
			e.warn(ctx, "invoice raised notification", err)
		}
		users = append(users, user)
		dataByUser[user] = map[string]any{"invoiceId": b.InvoiceID, "type": "INVOICE_RAISED"}
	}
	if len(users) > 0 && e.Notify.Push != nil {
		e.Notify.Push.ToUsers(ctx, users, push.Payload{Body: "Your rent for " + month + " is ready. Tap to view and pay.", Category: "PAYMENT", DataByUser: dataByUser, HostelID: hostel.Hex(), Title: "Rent bill ready"})
	}
}

// BillingSummary is getBillingPeriodSummary.
func (e *Engine) BillingSummary(ctx context.Context, hostel bson.ObjectID, period string) (ordered.Map, error) {
	cur, err := e.DB.Collection("invoices").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "kind", Value: "MONTHLY_RENT"}, {Key: "period", Value: period}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "VOID"}}}})
	if err != nil {
		return nil, err
	}
	var invoices []struct {
		Resident bson.ObjectID `bson:"residentId"`
		Total    int64         `bson:"totalAmount"`
	}
	if err := cur.All(ctx, &invoices); err != nil {
		return nil, err
	}
	rows, err := e.BillableResidents(ctx, hostel, period, nil)
	if err != nil {
		return nil, err
	}
	billed := map[string]bool{}
	amounts := make([]int64, len(invoices))
	for i, x := range invoices {
		billed[x.Resident.Hex()] = true
		amounts[i] = x.Total
	}
	today := bs.Today(time.Now())
	not := []string{}
	for i := range rows {
		b, err := finance.ResidentBounds(&rows[i].Billable, period)
		if err != nil {
			return nil, err
		}
		if !finance.NotYetDue(&rows[i].Billable, b, today) && !billed[rows[i].ID.Hex()] {
			not = append(not, rows[i].ID.Hex())
		}
	}
	total, err := money.Sum(amounts)
	if err != nil {
		return nil, err
	}
	return ordered.Map{{Key: "invoiceCount", Value: len(invoices)}, {Key: "notBilledResidentIds", Value: not}, {Key: "period", Value: period}, {Key: "totalBilled", Value: total}}, nil
}

// OrdinalDay is ordinalDay: 1st, 2nd, 3rd, 4th.
func OrdinalDay(day int) string { return ordinalDay(day) }
