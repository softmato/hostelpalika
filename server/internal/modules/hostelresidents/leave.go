package hostelresidents

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
	"github.com/softmato/hostelpalika/server/internal/modules/financeadmin"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

const dayMs = 24 * 60 * 60 * 1000

type leaveRow struct {
	ID     bson.ObjectID `bson:"_id"`
	Amount int64         `bson:"amount"`
	Days   int64         `bson:"days"`
	From   time.Time     `bson:"from"`
	Mode   string        `bson:"mode"`
	Note   *string       `bson:"note"`
	Period string        `bson:"period"`
	Status string        `bson:"status"`
	To     time.Time     `bson:"to"`
}

func (r leaveRow) json() ordered.Map {
	label, err := bs.FormatDayRange(r.From, r.To)
	if err != nil || label == "" {
		label = strconv.FormatInt(r.Days, 10) + " days"
	}
	period := bs.FormatPeriod(r.Period)
	if period == "" {
		period = r.Period
	}
	return ordered.Map{{Key: "amount", Value: r.Amount}, {Key: "days", Value: r.Days}, {Key: "from", Value: r.From.UTC().Format("2006-01-02")}, {Key: "id", Value: r.ID.Hex()},
		{Key: "label", Value: label}, {Key: "mode", Value: r.Mode}, {Key: "note", Value: nullable(r.Note)}, {Key: "period", Value: r.Period}, {Key: "periodLabel", Value: period},
		{Key: "status", Value: r.Status}, {Key: "to", Value: r.To.UTC().Format("2006-01-02")}}
}

type leaveResident struct {
	ID           bson.ObjectID `bson:"_id"`
	BillingCycle *string       `bson:"billingCycle"`
	MoveInDate   *time.Time    `bson:"moveInDate"`
}

func (r *leaveResident) billable() *finance.Billable {
	return &finance.Billable{ID: r.ID, BillingCycle: r.BillingCycle, MoveInDate: r.MoveInDate}
}

// periodOf is residentPeriodOf.
func (r *leaveResident) periodOf(t time.Time) (string, error) {
	if d := finance.BillDay(r.billable()); d > 0 {
		return bs.CyclePeriodOf(t, d)
	}
	return bs.PeriodOf(t)
}

// leaveResident loads the hostel's resident; a malformed id reads as a miss (RES-15: TS threw a 500).
func (s *Service) leaveResident(ctx context.Context, hostel bson.ObjectID, id string) (*leaveResident, error) {
	rid, err := bson.ObjectIDFromHex(id)
	if err != nil || len(id) != 24 {
		return nil, finance.Err("RESIDENT_NOT_FOUND", "Resident was not found.")
	}
	var r leaveResident
	err = s.DB.Collection("residents").FindOne(ctx, bson.D{{Key: "_id", Value: rid}, {Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
		options.FindOne().SetProjection(bson.D{{Key: "billingCycle", Value: 1}, {Key: "hostelId", Value: 1}, {Key: "moveInDate", Value: 1}, {Key: "status", Value: 1}})).Decode(&r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, finance.Err("RESIDENT_NOT_FOUND", "Resident was not found.")
	}
	return &r, err
}

// Leaves is listLeaves.
func (s *Service) Leaves(ctx context.Context, hostel bson.ObjectID, residentID string) (ordered.Map, error) {
	r, err := s.leaveResident(ctx, hostel, residentID)
	if err != nil {
		return nil, err
	}
	cur, err := s.DB.Collection("residentleaves").Find(ctx, bson.D{{Key: "residentId", Value: r.ID}, {Key: "status", Value: "ACTIVE"}}, options.Find().SetSort(bson.D{{Key: "from", Value: -1}}).SetLimit(500))
	if err != nil {
		return nil, err
	}
	var rows []leaveRow
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	rules, err := financeadmin.MoneyRulesOf(ctx, s.DB, hostel)
	if err != nil {
		return nil, err
	}
	out := make([]ordered.Map, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.json())
	}
	return ordered.Map{{Key: "leaves", Value: out}, {Key: "rule", Value: rules.Leave}}, nil
}

type rentBillRow struct {
	ID    bson.ObjectID `bson:"_id"`
	Lines []struct {
		Adjust string  `bson:"adjust"`
		Amount float64 `bson:"amount"`
		Basis  string  `bson:"basis"`
	} `bson:"lines"`
}

func (s *Service) rentBill(ctx context.Context, hostel, resident bson.ObjectID, period string) (*rentBillRow, error) {
	var b rentBillRow
	err := s.DB.Collection("invoices").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "kind", Value: "MONTHLY_RENT"}, {Key: "period", Value: period}, {Key: "residentId", Value: resident}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "VOID"}}}}).Decode(&b)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return &b, err
}

func orStr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// AddLeave is addLeave: days away, taken off that month's rent bill.
func (s *Service) AddLeave(ctx context.Context, hostel bson.ObjectID, residentID, fromS, toS, note string, p *authz.Principal) (ordered.Map, error) {
	r, err := s.leaveResident(ctx, hostel, residentID)
	if err != nil {
		return nil, err
	}
	rules, err := financeadmin.MoneyRulesOf(ctx, s.DB, hostel)
	if err != nil {
		return nil, err
	}
	rule := rules.Leave
	if !rule.Enabled {
		return nil, finance.Err("LEAVE_OFF", "Turn on Days away in Money rules first.")
	}
	day := func(v string) time.Time { t, _ := time.Parse("2006-01-02", v); return bs.CalendarDay(t) }
	from, to := day(fromS), day(toS)
	if to.Before(from) {
		return nil, finance.Err("LEAVE_DATES", "The last day is before the first.")
	}
	period, err := r.periodOf(from)
	if err != nil {
		return nil, err
	}
	if end, err := r.periodOf(to); err != nil || end != period {
		return nil, finance.Err("LEAVE_CROSSES_MONTH", "Keep one entry inside "+orStr(bs.FormatPeriod(period), "one month")+". Add the days in the next month as a second entry.")
	}
	days := int64(math.Round(float64(to.Sub(from).Milliseconds())/dayMs)) + 1
	if days < rule.MinDays {
		return nil, finance.Err("LEAVE_TOO_SHORT", "Fewer than "+strconv.FormatInt(rule.MinDays, 10)+" days away earn nothing in this hostel.")
	}
	coll := s.DB.Collection("residentleaves")
	err = coll.FindOne(ctx, bson.D{{Key: "from", Value: bson.D{{Key: "$lte", Value: to}}}, {Key: "residentId", Value: r.ID}, {Key: "status", Value: "ACTIVE"}, {Key: "to", Value: bson.D{{Key: "$gte", Value: from}}}},
		options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Err()
	if err == nil {
		return nil, finance.Err("LEAVE_OVERLAP", "Those days overlap days already entered.")
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	bill, err := s.rentBill(ctx, hostel, r.ID, period)
	if err != nil {
		return nil, err
	}
	b, err := finance.ResidentBounds(r.billable(), period)
	if err != nil {
		return nil, err
	}
	billedFrom := b.Start
	if r.MoveInDate != nil {
		if j := bs.CalendarDay(*r.MoveInDate); j.After(b.Start) {
			billedFrom = j
		}
	}
	billedDays := int64(math.Round(float64(b.LastDay.Sub(billedFrom).Milliseconds())/dayMs)) + 1
	var rent float64
	if bill != nil {
		for _, l := range bill.Lines {
			if (l.Basis == "SCHEDULE" || l.Basis == "OVERRIDE" || l.Basis == "MANUAL") && l.Adjust == "" {
				rent += l.Amount
			}
		}
	}
	if rule.Mode == "FULL_DAY" && bill == nil {
		return nil, finance.Err("LEAVE_MONTH_NOT_BILLED", orStr(bs.FormatPeriod(period), "That month")+" is not billed yet. Add these days once its bill is out.")
	}
	var perDay float64
	if rule.Mode == "FOOD" {
		perDay = float64(rule.FoodPerDay)
	} else {
		dd := float64(b.DaysInMonth)
		if bill != nil {
			dd = float64(billedDays)
		}
		if dd > 0 {
			perDay = rent / dd
		}
	}
	amount := int64(math.Floor(perDay*float64(days) + 0.5))
	at := now()
	doc := bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "hostelId", Value: hostel}, {Key: "residentId", Value: r.ID}, {Key: "from", Value: from}, {Key: "to", Value: to}, {Key: "days", Value: days},
		{Key: "period", Value: period}, {Key: "mode", Value: rule.Mode}, {Key: "amount", Value: amount}}
	if note != "" {
		doc = append(doc, bson.E{Key: "note", Value: note})
	}
	doc = append(doc, bson.E{Key: "status", Value: "ACTIVE"}, bson.E{Key: "invoiceId", Value: nil}, bson.E{Key: "createdBy", Value: bsonUser(p)},
		bson.E{Key: "createdAt", Value: at}, bson.E{Key: "updatedAt", Value: at}, bson.E{Key: "__v", Value: 0})
	if _, err := coll.InsertOne(ctx, doc); err != nil {
		return nil, err
	}
	if _, err := s.Ledger.ApplyLeaveToBill(ctx, hostel, r.ID, period, p); err != nil {
		return nil, err
	}
	return s.Leaves(ctx, hostel, residentID)
}

// CancelLeave is cancelLeave.
func (s *Service) CancelLeave(ctx context.Context, hostel bson.ObjectID, residentID, leaveID string, p *authz.Principal) (ordered.Map, error) {
	r, err := s.leaveResident(ctx, hostel, residentID)
	if err != nil {
		return nil, err
	}
	gone := finance.Err("LEAVE_NOT_FOUND", "That entry is already gone.")
	lid, err := bson.ObjectIDFromHex(leaveID)
	if err != nil || len(leaveID) != 24 {
		return nil, gone
	}
	var leave leaveRow
	err = s.DB.Collection("residentleaves").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: lid}, {Key: "residentId", Value: r.ID}, {Key: "status", Value: "ACTIVE"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "cancelledAt", Value: now()}, {Key: "cancelledBy", Value: bsonUser(p)}, {Key: "status", Value: "CANCELLED"}, {Key: "updatedAt", Value: now()}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&leave)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, gone
	}
	if err != nil {
		return nil, err
	}
	if _, err := s.Ledger.ApplyLeaveToBill(ctx, hostel, r.ID, leave.Period, p); err != nil {
		return nil, err
	}
	return s.Leaves(ctx, hostel, residentID)
}
