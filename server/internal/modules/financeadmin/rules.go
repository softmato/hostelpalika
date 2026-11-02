package financeadmin

import (
	"context"
	"errors"
	"math"
	"regexp"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Late fine, money rules and waiving a fine: late-fine.service and money-rules.service.

func (h *Handler) registerRules(v1 *gin.RouterGroup) {
	v1.GET("/hostel-admin/finance/late-fine", h.getLateFine)
	v1.PUT("/hostel-admin/finance/late-fine", h.putLateFine)
	v1.GET("/hostel-admin/finance/money-rules", h.getMoneyRules)
	v1.PUT("/hostel-admin/finance/money-rules", h.putMoneyRules)
	v1.POST("/hostel-admin/finance/invoices/:id/waive-fine", h.waiveFine)
}

type lateFine struct {
	Enabled   bool    `json:"enabled"`
	EnabledAt *string `json:"enabledAt"`
	GraceDays int     `json:"graceDays"`
	Mode      string  `json:"mode"`
	Rate      float64 `json:"rate"`
}

type storedSettings struct {
	LateFine *struct {
		Enabled   *bool      `bson:"enabled"`
		EnabledAt *time.Time `bson:"enabledAt"`
		GraceDays *int       `bson:"graceDays"`
		Mode      *string    `bson:"mode"`
		Rate      *float64   `bson:"rate"`
	} `bson:"lateFine"`
	Leave *struct {
		Enabled    *bool   `bson:"enabled"`
		FoodPerDay *int64  `bson:"foodPerDay"`
		MinDays    *int64  `bson:"minDays"`
		Mode       *string `bson:"mode"`
	} `bson:"leave"`
	MoveOutCharge     *string `bson:"moveOutCharge"`
	MoveOutNoticeDays *int64  `bson:"moveOutNoticeDays"`
	OpeningBalance    *struct {
		Amount int64     `bson:"amount"`
		AsOf   time.Time `bson:"asOf"`
	} `bson:"openingBalance"`
}

func (h *Handler) settings(ctx context.Context, hostel bson.ObjectID) (*storedSettings, error) {
	var s storedSettings
	err := h.DB.Collection("hostelsettings").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}},
		options.FindOne().SetProjection(bson.D{{Key: "lateFine", Value: 1}, {Key: "leave", Value: 1}, {Key: "moveOutCharge", Value: 1}, {Key: "moveOutNoticeDays", Value: 1}, {Key: "openingBalance", Value: 1}})).Decode(&s)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return &s, nil
	}
	return &s, err
}

// readLateFine is readSettings: the stored rule over DEFAULTS, enabledAt as a time.
func readLateFine(s *storedSettings) (lateFine, *time.Time) {
	out := lateFine{GraceDays: 5, Mode: "PER_DAY_AMOUNT"}
	var at *time.Time
	if l := s.LateFine; l != nil {
		if l.Enabled != nil {
			out.Enabled = *l.Enabled
		}
		at = l.EnabledAt
		if l.GraceDays != nil {
			out.GraceDays = *l.GraceDays
		}
		if l.Mode != nil {
			out.Mode = *l.Mode
		}
		if l.Rate != nil {
			out.Rate = *l.Rate
		}
	}
	if at != nil {
		s := httpx.ISO(*at)
		out.EnabledAt = &s
	}
	return out, at
}

// upsertSettings is HostelSettingsModel.updateOne(..., {upsert: true}) with its timestamps.
func (h *Handler) upsertSettings(ctx context.Context, hostel, actor bson.ObjectID, set, unset bson.D) error {
	now := nowMS()
	update := bson.D{{Key: "$set", Value: append(set, bson.E{Key: "updatedBy", Value: actor}, bson.E{Key: "updatedAt", Value: now})}}
	if len(unset) > 0 {
		update = append(update, bson.E{Key: "$unset", Value: unset})
	}
	update = append(update, bson.E{Key: "$setOnInsert", Value: bson.D{{Key: "createdBy", Value: actor}, {Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}})
	_, err := h.DB.Collection("hostelsettings").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}, update, options.UpdateOne().SetUpsert(true))
	return err
}

func (h *Handler) getLateFine(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "viewPayments")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cache.Respond(c, h.Cache, p.HostelIDs, p.UserID, "late-fine:"+hostel.Hex(), "Late fine", func() (any, error) {
		s, err := h.settings(c, hostel)
		if err != nil {
			return nil, err
		}
		out, _ := readLateFine(s)
		return ordered.Map{{Key: "lateFine", Value: out}}, nil
	})
}

func (h *Handler) putLateFine(c *gin.Context) {
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
	enabled, _ := f.Bool("enabled", false, nil)
	grace, _ := f.Num("graceDays", valid.N{Int: true, Min: valid.P(1), Max: valid.P(28)})
	requested, _ := f.Str("hostelId", valid.S{Opt: true})
	mode, _ := f.Enum("mode", false, nil, "PER_DAY_AMOUNT", "PER_DAY_PERCENT")
	rate, rateOK := f.Num("rate", valid.N{Min: valid.P(0)})
	if !f.Hard && rateOK && enabled {
		ok := rate == math.Trunc(rate) && rate >= 1 && rate <= 5000
		msg := "Fine a day must be whole rupees, 1 to 5,000."
		if mode == "PER_DAY_PERCENT" {
			ok = rate >= 0.1 && rate <= 10 && math.Round(rate*100) == rate*100
			msg = "Percent a day must be 0.1 to 10."
		}
		if !ok {
			f.Is.Add("rate", msg)
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
	actor, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	s, err := h.settings(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	before, at := readLateFine(s)
	if enabled && !before.Enabled {
		now := nowMS()
		at = &now
	}
	var stored any
	if at != nil {
		stored = *at
	}
	if err := h.upsertSettings(c, hostel, actor, bson.D{{Key: "lateFine", Value: bson.D{{Key: "enabled", Value: enabled}, {Key: "enabledAt", Value: stored},
		{Key: "graceDays", Value: int(grace)}, {Key: "mode", Value: mode}, {Key: "rate", Value: rate}}}}, nil); err != nil {
		httpx.Fail(c, err)
		return
	}
	realtime.PublishResourceChange(c, h.RT, h.Cache, realtime.Change{HostelIDs: []string{hostel.Hex()}, Topics: []realtime.Topic{realtime.Payments}})
	var atOut any
	if at != nil {
		atOut = httpx.ISO(*at)
	}
	httpx.OK(c, ordered.Map{{Key: "lateFine", Value: ordered.Map{{Key: "enabled", Value: enabled}, {Key: "graceDays", Value: int(grace)}, {Key: "mode", Value: mode},
		{Key: "rate", Value: rate}, {Key: "enabledAt", Value: atOut}}}}, "Late fine saved")
}

type moneyRules struct {
	Leave struct {
		Enabled    bool   `json:"enabled"`
		FoodPerDay int64  `json:"foodPerDay"`
		MinDays    int64  `json:"minDays"`
		Mode       string `json:"mode"`
	} `json:"leave"`
	MoveOutCharge     string `json:"moveOutCharge"`
	MoveOutNoticeDays int64  `json:"moveOutNoticeDays"`
	OpeningBalance    *struct {
		Amount int64  `json:"amount"`
		AsOf   string `json:"asOf"`
	} `json:"openingBalance"`
}

func readMoneyRules(s *storedSettings) moneyRules {
	var r moneyRules
	r.Leave.MinDays, r.Leave.Mode, r.MoveOutCharge = 3, "FOOD", "TILL_DAY"
	if l := s.Leave; l != nil {
		if l.Enabled != nil {
			r.Leave.Enabled = *l.Enabled
		}
		if l.FoodPerDay != nil {
			r.Leave.FoodPerDay = *l.FoodPerDay
		}
		if l.MinDays != nil {
			r.Leave.MinDays = *l.MinDays
		}
		if l.Mode != nil {
			r.Leave.Mode = *l.Mode
		}
	}
	if s.MoveOutCharge != nil {
		r.MoveOutCharge = *s.MoveOutCharge
	}
	if s.MoveOutNoticeDays != nil {
		r.MoveOutNoticeDays = *s.MoveOutNoticeDays
	}
	if o := s.OpeningBalance; o != nil {
		r.OpeningBalance = &struct {
			Amount int64  `json:"amount"`
			AsOf   string `json:"asOf"`
		}{o.Amount, o.AsOf.UTC().Format("2006-01-02")}
	}
	return r
}

func (h *Handler) getMoneyRules(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "viewPayments")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cache.Respond(c, h.Cache, p.HostelIDs, p.UserID, "money-rules:"+hostel.Hex(), "Money rules", func() (any, error) {
		s, err := h.settings(c, hostel)
		if err != nil {
			return nil, err
		}
		return ordered.Map{{Key: "rules", Value: readMoneyRules(s)}}, nil
	})
}

var dayRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func (h *Handler) putMoneyRules(c *gin.Context) {
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
	requested, _ := f.Str("hostelId", valid.S{Opt: true})
	var leave bson.D
	f.Nest("leave", true, func(sub *valid.Form) {
		enabled, _ := sub.Bool("enabled", false, nil)
		food, _ := sub.Num("foodPerDay", valid.N{Coerce: true, Int: true, Min: valid.P(0), Max: valid.P(100_000)})
		minDays, _ := sub.Num("minDays", valid.N{Coerce: true, Int: true, Min: valid.P(1), Max: valid.P(31)})
		mode, _ := sub.Enum("mode", false, nil, "FOOD", "FULL_DAY")
		leave = bson.D{{Key: "enabled", Value: enabled}, {Key: "foodPerDay", Value: int64(food)}, {Key: "minDays", Value: int64(minDays)}, {Key: "mode", Value: mode}}
	})
	charge, chargeOK := f.Enum("moveOutCharge", true, nil, "FULL_MONTH", "TILL_DAY")
	notice, noticeOK := f.Num("moveOutNoticeDays", valid.N{Opt: true, Coerce: true, Int: true, Min: valid.P(0), Max: valid.P(90)})
	raw, opening := f.M["openingBalance"]
	clearOpening := opening && raw == nil
	var amount int64
	var asOf string
	if opening && raw != nil {
		f.Nest("openingBalance", false, func(sub *valid.Form) {
			n, _ := sub.Num("amount", valid.N{Coerce: true, Int: true, Min: valid.P(-1_000_000_000), Max: valid.P(1_000_000_000)})
			amount = int64(n)
			asOf, _ = sub.Str("asOf", valid.S{Re: dayRe, ReSrc: `/^\d{4}-\d{2}-\d{2}$/`})
		})
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
	actor, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	set, unset := bson.D{}, bson.D{}
	if leave != nil {
		set = append(set, bson.E{Key: "leave", Value: leave})
	}
	if chargeOK {
		set = append(set, bson.E{Key: "moveOutCharge", Value: charge})
	}
	if noticeOK {
		set = append(set, bson.E{Key: "moveOutNoticeDays", Value: int64(notice)})
	}
	var day time.Time
	if clearOpening {
		unset = append(unset, bson.E{Key: "openingBalance", Value: ""})
	} else if opening {
		parsed, err := time.Parse("2006-01-02", asOf)
		if err != nil {
			// The regex passed a day that does not exist (2026-02-31): new Date() is Invalid Date in TS.
			httpx.Fail(c, httpx.NewError(422, "VALIDATION_ERROR", "Validation failed", nil))
			return
		}
		day = bs.CalendarDay(parsed)
		set = append(set, bson.E{Key: "openingBalance", Value: bson.D{{Key: "amount", Value: amount}, {Key: "asOf", Value: day}, {Key: "setAt", Value: nowMS()}, {Key: "setBy", Value: actor}}})
	}
	var before *int64
	if opening {
		s, err := h.settings(c, hostel)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		if s.OpeningBalance != nil {
			before = &s.OpeningBalance.Amount
		}
	}
	if err := h.upsertSettings(c, hostel, actor, set, unset); err != nil {
		httpx.Fail(c, err)
		return
	}
	// The starting figure of the hostel's own books is money: on the trail.
	if opening {
		in := audit.Finance{Action: "OPENING_BALANCE_SET", EntityID: hostel.Hex(), EntityType: "Hostel", HostelID: hostel, Source: "MONEY_RULES", Reason: "Opening balance cleared"}
		if before != nil {
			in.AmountBefore = *before
		}
		if !clearOpening {
			in.AmountAfter, in.Reason = amount, "Bank balance on "+asOf
		}
		if err := h.Audit.WriteFinance(c, actor, string(p.Role), in); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	s, err := h.settings(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "rules", Value: readMoneyRules(s)}}, "Saved")
}

// waiveFine takes the fine off one bill for good. Refused once the bill is paid:
// that money is real, and the honest correction then is a reversal.
func (h *Handler) waiveFine(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "manageFeeSchedule")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		httpx.Fail(c, httpx.NewError(404, "NOT_FOUND", "Not found", nil))
		return
	}
	var inv struct {
		ID         bson.ObjectID `bson:"_id"`
		HostelID   bson.ObjectID `bson:"hostelId"`
		ResidentID bson.ObjectID `bson:"residentId"`
		Status     string        `bson:"status"`
		Lines      []bson.Raw    `bson:"lines"`
	}
	err = h.DB.Collection("invoices").FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: bson.D{{Key: "$in", Value: scopeOf(p)}}}}).Decode(&inv)
	if errors.Is(err, mongo.ErrNoDocuments) {
		err = finance.Err("INVOICE_NOT_FOUND", "Invoice was not found.")
	} else if err == nil && inv.Status == "PAID" {
		err = finance.Err("INVOICE_ALREADY_PAID", "This bill is already paid, fine included.")
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	others := bson.A{}
	var total float64
	for _, l := range inv.Lines {
		if basis, _ := l.Lookup("basis").StringValueOK(); basis == "FINE" {
			continue
		}
		others = append(others, l)
		if v, ok := l.Lookup("amount").AsFloat64OK(); ok {
			total += v
		}
	}
	actor, _ := bson.ObjectIDFromHex(p.UserID)
	if _, err := h.DB.Collection("invoices").UpdateOne(c, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: bson.D{{Key: "fineWaived", Value: true},
		{Key: "lines", Value: others}, {Key: "totalAmount", Value: jsNumber(total)}, {Key: "updatedBy", Value: actor}, {Key: "updatedAt", Value: nowMS()}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	// Money already in may now cover the smaller bill.
	if _, err := h.Ledger.RecomputeInvoiceBalance(c, id); err != nil {
		httpx.Fail(c, err)
		return
	}
	realtime.PublishResourceChange(c, h.RT, h.Cache, realtime.Change{HostelIDs: []string{inv.HostelID.Hex()}, Topics: []realtime.Topic{realtime.Payments}})
	h.Ledger.NotifyResident(c, inv.HostelID, inv.ResidentID, "Late fine waived", "The late fine on your bill was waived.",
		ordered.Map{{Key: "invoiceId", Value: id.Hex()}, {Key: "type", Value: "LATE_FINE_WAIVED"}})
	httpx.OK(c, ordered.Map{{Key: "invoiceId", Value: id.Hex()}}, "Fine waived")
}

// jsNumber stores a whole figure as an integer, as the node driver does.
func jsNumber(f float64) any {
	if f == math.Trunc(f) && math.Abs(f) < 1<<53 {
		return int64(f)
	}
	return f
}

// MoneyRules is getMoneyRules's answer, for the modules that read the rules.
type MoneyRules = moneyRules

// MoneyRulesOf is getMoneyRules: the hostel's stored rules over their defaults.
func MoneyRulesOf(ctx context.Context, db *mongo.Database, hostel bson.ObjectID) (MoneyRules, error) {
	s, err := (&Handler{DB: db}).settings(ctx, hostel)
	if err != nil {
		return MoneyRules{}, err
	}
	return readMoneyRules(s), nil
}
