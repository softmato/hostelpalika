package hostelresidents

import (
	"context"
	"errors"
	"math"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/ledger"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// Quote is IntakeQuote with the numbers the rest of registering needs.
type Quote struct {
	AdmissionFee, AdmissionPayable, FormFee, DepositAmount float64
	BedType, Currency, RoomType                            string
	FeeScheduleID                                          string
	MonthlyRent                                            *float64
	RentBasis                                              string
	ReferralCode                                           string
	ReferralDiscount                                       float64
	ReferralReason                                         *string
	StdAdmission, StdDeposit, StdForm                      float64
	StdRent                                                *float64
	StandardRent                                           *float64 // standardRent: only when a special fee is set
	FirstMonth                                             *FirstMonth
}

// FirstMonth is FirstMonthCharge.
type FirstMonth struct {
	Amount       int64
	BillableDays int
	DaysInMonth  int
	DayRange     string
	Period       string
	Prorated     bool
}

// QuoteIn is QuoteInput; nil overrides mean "the rate card's".
type QuoteIn struct {
	AdmissionFee, DepositAmount, FormFee, MonthlyFee *float64
	BillingCycle                                     *string
	MoveInDate                                       time.Time
	ReferralCode                                     string
	RoomType                                         string
}

// JSON is the quote as TS returns it, key for key.
func (q *Quote) JSON() ordered.Map {
	var fm any
	if q.FirstMonth != nil {
		var rng any
		if q.FirstMonth.DayRange != "" {
			rng = q.FirstMonth.DayRange
		}
		fm = ordered.Map{{Key: "amount", Value: q.FirstMonth.Amount}, {Key: "billableDays", Value: q.FirstMonth.BillableDays}, {Key: "daysInMonth", Value: q.FirstMonth.DaysInMonth},
			{Key: "dayRange", Value: rng}, {Key: "period", Value: q.FirstMonth.Period}, {Key: "prorated", Value: q.FirstMonth.Prorated}}
	}
	var bed, sched, code any
	if q.BedType != "" {
		bed = q.BedType
	}
	if q.FeeScheduleID != "" {
		sched = q.FeeScheduleID
	}
	if q.ReferralCode != "" {
		code = q.ReferralCode
	}
	return ordered.Map{
		{Key: "admissionFee", Value: q.AdmissionFee}, {Key: "admissionPayable", Value: q.AdmissionPayable}, {Key: "formFee", Value: q.FormFee},
		{Key: "bedType", Value: bed}, {Key: "currency", Value: q.Currency}, {Key: "depositAmount", Value: q.DepositAmount}, {Key: "feeScheduleId", Value: sched},
		{Key: "firstMonth", Value: fm}, {Key: "monthlyRent", Value: nullable(q.MonthlyRent)},
		{Key: "referral", Value: ordered.Map{{Key: "applied", Value: q.ReferralDiscount > 0}, {Key: "code", Value: code}, {Key: "discount", Value: q.ReferralDiscount}, {Key: "reason", Value: nullable(q.ReferralReason)}}},
		{Key: "rentBasis", Value: q.RentBasis}, {Key: "roomType", Value: q.RoomType},
		{Key: "standard", Value: ordered.Map{{Key: "admissionFee", Value: q.StdAdmission}, {Key: "depositAmount", Value: q.StdDeposit}, {Key: "formFee", Value: q.StdForm}, {Key: "monthlyRent", Value: nullable(q.StdRent)}}},
		{Key: "standardRent", Value: nullable(q.StandardRent)},
	}
}

// Payable is joiningPayable: admission after discount, deposit and form fee.
func (q *Quote) Payable() float64 {
	return math.Max(q.AdmissionPayable, 0) + math.Max(q.DepositAmount, 0) + math.Max(q.FormFee, 0)
}

type hostelPricing struct {
	Pricing struct {
		FormFee      *float64 `bson:"formFee"`
		AdmissionFee *float64 `bson:"admissionFee"`
		Currency     *string  `bson:"currency"`
	} `bson:"pricing"`
	ReferencePrefix    string `bson:"referencePrefix"`
	RoomConfigurations []struct {
		RoomType    string   `bson:"roomType"`
		MonthlyRent *float64 `bson:"monthlyRent"`
	} `bson:"roomConfigurations"`
}

func firstNonNil(ps ...*float64) float64 {
	for _, p := range ps {
		if p != nil {
			return *p
		}
	}
	return 0
}

// Quote is getIntakeQuote: what registering this resident costs.
func (s *Service) Quote(ctx context.Context, hostel bson.ObjectID, in QuoteIn) (*Quote, error) {
	moveIn := bs.CalendarDay(in.MoveInDate)
	if in.MoveInDate.IsZero() {
		moveIn = bs.Today(now())
	}
	period, err := bs.PeriodOf(moveIn)
	if err != nil {
		return nil, err
	}
	var h hostelPricing
	err = s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}},
		options.FindOne().SetProjection(bson.D{{Key: "pricing", Value: 1}, {Key: "roomConfigurations", Value: 1}, {Key: "referencePrefix", Value: 1}})).Decode(&h)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	sched, err := finance.EffectiveSchedule(ctx, s.DB, hostel, period)
	if err != nil {
		return nil, err
	}
	var conc struct {
		PercentOff int64 `bson:"percentOff"`
	}
	if err := s.DB.Collection("rentconcessions").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "period", Value: period}}).Decode(&conc); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	code := strings.ToUpper(strings.TrimSpace(in.ReferralCode))
	active := false
	if code != "" {
		active, err = s.activeReferral(ctx, hostel, code)
		if err != nil {
			return nil, err
		}
	}

	q := &Quote{RoomType: in.RoomType, Currency: "NPR", ReferralCode: code}
	q.BedType = finance.NormalizeBedType(in.RoomType)
	if h.Pricing.Currency != nil {
		q.Currency = *h.Pricing.Currency
	}
	var std *float64
	q.RentBasis = "UNPRICED"
	if rate := finance.RateForRoomType(sched, in.RoomType); rate != nil && rate.MonthlyAmount != nil {
		std, q.RentBasis = rate.MonthlyAmount, "SCHEDULE"
	} else {
		for _, c := range h.RoomConfigurations {
			if c.RoomType == in.RoomType && c.MonthlyRent != nil && *c.MonthlyRent != 0 {
				std, q.RentBasis = c.MonthlyRent, "ROOM_CONFIGURATION"
				break
			}
		}
	}
	q.StdRent = std
	q.MonthlyRent = std
	if in.MonthlyFee != nil {
		q.MonthlyRent, q.RentBasis, q.StandardRent = in.MonthlyFee, "OVERRIDE", std
	}
	var schedAdmission, schedForm, schedDeposit, schedRef *float64
	if sched != nil {
		q.FeeScheduleID = sched.ID.Hex()
		schedAdmission, schedForm, schedDeposit, schedRef = sched.AdmissionFee, sched.FormFee, sched.DepositAmount, sched.ReferralAdmissionDiscount
	}
	q.StdAdmission = firstNonNil(schedAdmission, h.Pricing.AdmissionFee)
	if sched != nil {
		q.StdForm = firstNonNil(schedForm)
	} else {
		q.StdForm = firstNonNil(h.Pricing.FormFee)
	}
	q.StdDeposit = firstNonNil(schedDeposit)
	q.AdmissionFee = firstNonNil(in.AdmissionFee, &q.StdAdmission)
	q.FormFee = firstNonNil(in.FormFee, &q.StdForm)
	q.DepositAmount = firstNonNil(in.DepositAmount, &q.StdDeposit)
	offered := firstNonNil(schedRef)
	if code != "" && active {
		q.ReferralDiscount = math.Min(offered, q.AdmissionFee)
	}
	q.AdmissionPayable = q.AdmissionFee - q.ReferralDiscount
	q.ReferralReason = referralReason(active, q.AdmissionFee, code, offered)
	if q.MonthlyRent != nil {
		q.FirstMonth = firstMonthOf(int64(ledger.DiscountRent(int64(*q.MonthlyRent), conc.PercentOff)), moveIn, in.BillingCycle)
	}
	return q, nil
}

func referralReason(active bool, admission float64, code string, offered float64) *string {
	var r string
	switch {
	case code == "":
		return nil
	case !active:
		r = "That code is not active in this hostel."
	case admission <= 0:
		r = "This hostel charges no admission fee, so there is nothing to discount. The referrer is still credited."
	case offered <= 0:
		r = "This hostel offers no referral discount. The referrer is still credited."
	default:
		return nil
	}
	return &r
}

func firstMonthOf(rent int64, start time.Time, cycle *string) *FirstMonth {
	period, err := bs.PeriodOf(start)
	if err != nil {
		return nil
	}
	b, err := finance.ResidentBounds(&finance.Billable{BillingCycle: cycle, MoveInDate: &start}, period)
	if err != nil {
		return nil
	}
	ch, err := finance.ComputeInvoiceAmount(rent, &start, nil, b)
	if err != nil {
		return nil
	}
	fm := &FirstMonth{Amount: ch.Amount, BillableDays: ch.Days, DaysInMonth: b.DaysInMonth, Period: period, Prorated: ch.Proration != nil}
	if r, err := bs.FormatDayRange(start, b.LastDay); err == nil {
		fm.DayRange = r
	}
	return fm
}

// activeReferral is isActiveReferralCode (code already upper-cased).
func (s *Service) activeReferral(ctx context.Context, hostel bson.ObjectID, code string) (bool, error) {
	err := s.DB.Collection("referralcodes").FindOne(ctx, bson.D{{Key: "code", Value: code}, {Key: "hostelId", Value: hostel}, {Key: "status", Value: "ACTIVE"}},
		options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Err()
	if errors.Is(err, mongo.ErrNoDocuments) {
		return false, nil
	}
	return err == nil, err
}

// Admission is AdmissionInvoiceResult.
type Admission struct {
	Raised        bool
	Reason        string
	Amount        float64
	InvoiceID     string
	ReferenceCode string
}

func (a Admission) JSON() ordered.Map {
	if !a.Raised {
		return ordered.Map{{Key: "raised", Value: false}, {Key: "reason", Value: a.Reason}}
	}
	return ordered.Map{{Key: "amount", Value: a.Amount}, {Key: "invoiceId", Value: a.InvoiceID}, {Key: "raised", Value: true}, {Key: "referenceCode", Value: a.ReferenceCode}}
}

// RaiseAdmission is raiseAdmissionInvoice: one joining invoice, never twice. A
// failure is a result, not an error: the resident is already registered.
func (s *Service) RaiseAdmission(ctx context.Context, hostel, resident bson.ObjectID, due time.Time, q *Quote, reason string, p *authz.Principal) Admission {
	payable := q.Payable()
	if payable <= 0 {
		return Admission{Reason: "NO_ADMISSION_FEE"}
	}
	fail := func(err error) Admission { return Admission{Reason: err.Error()} }
	var existing struct {
		ID            bson.ObjectID `bson:"_id"`
		ReferenceCode string        `bson:"referenceCode"`
		Total         float64       `bson:"totalAmount"`
	}
	err := s.DB.Collection("invoices").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "kind", Value: "ADMISSION_FEE"}, {Key: "residentId", Value: resident}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "VOID"}}}}).Decode(&existing)
	if err == nil {
		return Admission{Raised: true, Amount: existing.Total, InvoiceID: existing.ID.Hex(), ReferenceCode: existing.ReferenceCode}
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		return fail(err)
	}
	var h hostelPricing
	_ = s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "referencePrefix", Value: 1}})).Decode(&h)
	ref, err := s.Ledger.AllocateReferenceCode(ctx, hostel, h.ReferencePrefix)
	if err != nil {
		return fail(err)
	}
	basis := "MANUAL"
	var schedID any
	if q.FeeScheduleID != "" {
		basis = "SCHEDULE"
		schedID, _ = bson.ObjectIDFromHex(q.FeeScheduleID)
	}
	line := func(desc string, amount, rateCard float64) bson.D {
		if amount != rateCard {
			if reason != "" {
				desc += " · " + reason
			}
			return bson.D{{Key: "description", Value: desc}, {Key: "bedType", Value: nil}, {Key: "amount", Value: ledger.JSInt(int64(amount))}, {Key: "basis", Value: "MANUAL"}}
		}
		l := bson.D{{Key: "description", Value: desc}, {Key: "bedType", Value: nil}, {Key: "amount", Value: ledger.JSInt(int64(amount))}, {Key: "basis", Value: basis}}
		if schedID != nil {
			l = append(l, bson.E{Key: "feeScheduleId", Value: schedID})
		}
		return l
	}
	lines := bson.A{}
	if q.FormFee > 0 {
		lines = append(lines, line("Form fee", q.FormFee, q.StdForm))
	}
	if q.AdmissionFee > 0 {
		lines = append(lines, line("Admission fee", q.AdmissionFee, q.StdAdmission))
	}
	if q.ReferralDiscount > 0 {
		lines = append(lines, bson.D{{Key: "description", Value: "Referral discount — code " + q.ReferralCode}, {Key: "bedType", Value: nil}, {Key: "amount", Value: ledger.JSInt(-int64(q.ReferralDiscount))}, {Key: "basis", Value: "CREDIT"}})
	}
	if dep := math.Max(q.DepositAmount, 0); dep > 0 {
		lines = append(lines, line("Security deposit", dep, q.StdDeposit))
	}
	id := bson.NewObjectID()
	at := now()
	doc := bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: hostel}, {Key: "residentId", Value: resident}, {Key: "period", Value: nil}, {Key: "kind", Value: "ADMISSION_FEE"},
		{Key: "lines", Value: lines}, {Key: "totalAmount", Value: ledger.JSInt(int64(payable))}, {Key: "currency", Value: q.Currency}, {Key: "dueDate", Value: due}, {Key: "issuedAt", Value: at},
		{Key: "status", Value: "OPEN"}, {Key: "referenceCode", Value: strings.ToUpper(ref)}, {Key: "legacyPaymentId", Value: nil},
		{Key: "dunning", Value: bson.D{{Key: "lastNotifiedAt", Value: nil}, {Key: "chaseCount", Value: 0}, {Key: "stage", Value: "NONE"}}}, {Key: "fineWaived", Value: false},
		{Key: "createdBy", Value: bsonUser(p)}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}
	if _, err := s.DB.Collection("invoices").InsertOne(ctx, doc); err != nil {
		return fail(err)
	}
	return Admission{Raised: true, Amount: payable, InvoiceID: id.Hex(), ReferenceCode: ref}
}

func bsonUser(p *authz.Principal) bson.ObjectID {
	id, _ := bson.ObjectIDFromHex(p.UserID)
	return id
}
