package hostelreferrals

import (
	"context"
	"errors"
	"math/rand/v2"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Platform is /platform/hostel-referrals: program rewards, partner codes and every referral.
type Platform struct {
	Service *Service
	Guards  *authz.Guards
	Audit   *audit.Log
	AppURL  func(path string) string
}

func (p *Platform) Register(v1 *gin.RouterGroup) {
	g := v1.Group("/platform/hostel-referrals", authz.Use(p.Guards.RequireSuperadmin))
	g.GET("", httpx.ETag(), p.overview)
	g.PUT("", p.saveSettings)
	g.PATCH("/:referralId", p.markPaid)
	g.POST("/codes", p.createCode)
	g.PATCH("/codes/:codeId", p.updateCode)
}

func (p *Platform) col(name string) *mongo.Collection { return p.Service.db.Collection(name) }

func (s Settings) out() ordered.Map {
	return ordered.Map{{Key: "enabled", Value: s.Enabled}, {Key: "referee", Value: s.Referee}, {Key: "referrer", Value: s.Referrer}}
}

func notFound(label string) error {
	return httpx.NewError(http.StatusNotFound, "NOT_FOUND", "That "+label+" was not found.", nil)
}

func referralErr(msg string) error { return err422("HOSTEL_REFERRAL_ERROR", msg) }

type codeRecord struct {
	ID              bson.ObjectID `bson:"_id"`
	Code            string        `bson:"code"`
	CommissionType  string        `bson:"commissionType"`
	CommissionValue float64       `bson:"commissionValue"`
	Contact         string        `bson:"contact"`
	CreatedAt       time.Time     `bson:"createdAt"`
	Name            string        `bson:"name"`
	Note            string        `bson:"note"`
	OfferDays       float64       `bson:"offerDays"`
	OfferMonths     float64       `bson:"offerMonths"`
	Status          string        `bson:"status"`
}

type codeStats struct {
	Commission float64 `bson:"commission" json:"commission"`
	Live       int     `bson:"live" json:"live"`
	Paid       float64 `bson:"paid" json:"paid"`
	Registered int     `bson:"registered" json:"registered"`
}

func (p *Platform) serializeCode(r *codeRecord, stats *codeStats) ordered.Map {
	if stats == nil {
		stats = &codeStats{}
	}
	return ordered.Map{{Key: "code", Value: r.Code}, {Key: "commissionType", Value: r.CommissionType}, {Key: "commissionValue", Value: r.CommissionValue}, {Key: "contact", Value: r.Contact},
		{Key: "createdAt", Value: httpx.ISO(r.CreatedAt)}, {Key: "id", Value: r.ID.Hex()}, {Key: "link", Value: p.AppURL("/register-hostel?ref=" + httpx.EncodeURIComponent(r.Code))},
		{Key: "name", Value: r.Name}, {Key: "note", Value: r.Note}, {Key: "offerDays", Value: r.OfferDays}, {Key: "offerMonths", Value: r.OfferMonths}, {Key: "stats", Value: stats}, {Key: "status", Value: r.Status}}
}

func isoOrNil(t *time.Time) any {
	if t == nil {
		return nil
	}
	return httpx.ISO(*t)
}

// overview is getPlatformReferralOverview.
func (p *Platform) overview(c *gin.Context) {
	settings := p.Service.Settings(c)
	cur, err := p.col("hostelreferralcodes").Find(c, bson.D{{Key: "kind", Value: "PARTNER"}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var codes []codeRecord
	if err := cur.All(c, &codes); err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err = p.col("hostelreferrals").Aggregate(c, bson.A{bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$codeId"},
		{Key: "commission", Value: bson.D{{Key: "$sum", Value: "$commission.amount"}}},
		{Key: "live", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{bson.D{{Key: "$eq", Value: bson.A{"$status", "LIVE"}}}, 1, 0}}}}}},
		{Key: "paid", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{bson.D{{Key: "$eq", Value: bson.A{"$commission.status", "PAID"}}}, "$commission.amount", 0}}}}}},
		{Key: "registered", Value: bson.D{{Key: "$sum", Value: 1}}}}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var stats []struct {
		ID    *bson.ObjectID `bson:"_id"`
		Stats codeStats      `bson:",inline"` // named: an unexported embedded inline struct is skipped

	}
	if err := cur.All(c, &stats); err != nil {
		httpx.Fail(c, err)
		return
	}
	// ponytail: newest 200 only; page by createdAt when the list outgrows it.
	cur, err = p.col("hostelreferrals").Find(c, bson.D{}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(200))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []struct {
		ID         bson.ObjectID `bson:"_id"`
		Code       string        `bson:"code"`
		CodeID     bson.ObjectID `bson:"codeId"`
		Commission struct {
			Amount float64    `bson:"amount"`
			PaidAt *time.Time `bson:"paidAt"`
			Status string     `bson:"status"`
		} `bson:"commission"`
		CreatedAt  time.Time      `bson:"createdAt"`
		Kind       string         `bson:"kind"`
		LiveAt     *time.Time     `bson:"liveAt"`
		Referee    bson.ObjectID  `bson:"refereeHostelId"`
		RefereeRew PlanBonus      `bson:"refereeReward"`
		Referrer   *bson.ObjectID `bson:"referrerHostelId"`
		ReferrerRw PlanBonus      `bson:"referrerReward"`
		Status     string         `bson:"status"`
	}
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	byCode := map[bson.ObjectID]*codeStats{}
	var owed float64
	registered := 0
	for i := range stats {
		if stats[i].ID != nil {
			byCode[*stats[i].ID] = &stats[i].Stats
		}
		owed += stats[i].Stats.Commission - stats[i].Stats.Paid
		registered += stats[i].Stats.Registered
	}
	codeNames := map[bson.ObjectID]string{}
	partner := make([]ordered.Map, len(codes))
	for i := range codes {
		codeNames[codes[i].ID] = codes[i].Name
		partner[i] = p.serializeCode(&codes[i], byCode[codes[i].ID])
	}
	ids := bson.A{}
	for _, r := range rows {
		ids = append(ids, r.Referee)
		if r.Referrer != nil {
			ids = append(ids, *r.Referrer)
		}
	}
	names, err := p.hostelNames(c, ids)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	or := func(s, fallback string) string {
		if s == "" {
			return fallback
		}
		return s
	}
	live := 0
	referrals := make([]ordered.Map, len(rows))
	for i, r := range rows {
		from := or(codeNames[r.CodeID], "Partner")
		if r.Kind != "PARTNER" {
			from = "A hostel"
			if r.Referrer != nil {
				from = or(names[*r.Referrer], "A hostel")
			}
		}
		if r.Status == "LIVE" {
			live++
		}
		referrals[i] = ordered.Map{{Key: "code", Value: r.Code}, {Key: "commission", Value: ordered.Map{{Key: "amount", Value: r.Commission.Amount}, {Key: "paidAt", Value: isoOrNil(r.Commission.PaidAt)}, {Key: "status", Value: r.Commission.Status}}},
			{Key: "createdAt", Value: httpx.ISO(r.CreatedAt)}, {Key: "from", Value: from}, {Key: "hostelName", Value: or(names[r.Referee], "A hostel")}, {Key: "id", Value: r.ID.Hex()}, {Key: "kind", Value: r.Kind},
			{Key: "liveAt", Value: isoOrNil(r.LiveAt)}, {Key: "refereeReward", Value: Describe(r.RefereeRew)}, {Key: "referrerReward", Value: Describe(r.ReferrerRw)}, {Key: "status", Value: r.Status}}
	}
	httpx.OK(c, ordered.Map{{Key: "partnerCodes", Value: partner}, {Key: "referrals", Value: referrals}, {Key: "settings", Value: settings.out()},
		{Key: "totals", Value: ordered.Map{{Key: "commissionOwed", Value: owed}, {Key: "live", Value: live}, {Key: "registered", Value: registered}}}}, "Hostel referrals")
}

func (p *Platform) hostelNames(ctx context.Context, ids bson.A) (map[bson.ObjectID]string, error) {
	out := map[bson.ObjectID]string{}
	if len(ids) == 0 {
		return out, nil
	}
	cur, err := p.col("hostels").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var hs []struct {
		ID   bson.ObjectID `bson:"_id"`
		Name string        `bson:"name"`
	}
	if err := cur.All(ctx, &hs); err != nil {
		return nil, err
	}
	for _, h := range hs {
		out[h.ID] = h.Name
	}
	return out, nil
}

func planBonusForm(f *valid.Form, key string, def PlanBonus) (PlanBonus, bool) {
	b := def
	if _, present := f.M[key]; !present {
		return b, true
	}
	ok := f.Nest(key, false, func(sub *valid.Form) {
		d, _ := sub.Num("days", valid.N{Coerce: true, Int: true, Min: valid.P(0), Max: valid.P(365), Default: valid.P(0)})
		m, _ := sub.Num("months", valid.N{Coerce: true, Int: true, Min: valid.P(0), Max: valid.P(24), Default: valid.P(0)})
		b = PlanBonus{int(d), int(m)}
	})
	return b, ok
}

// saveSettings is saveHostelReferralSettings: a partial edit merges onto what is stored.
func (p *Platform) saveSettings(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cur := p.Service.Settings(c)
	merged := map[string]any{"enabled": cur.Enabled,
		"referee":  map[string]any{"days": float64(cur.Referee.Days), "months": float64(cur.Referee.Months)},
		"referrer": map[string]any{"days": float64(cur.Referrer.Days), "months": float64(cur.Referrer.Months)}}
	if in, ok := body.(map[string]any); ok {
		for k, v := range in {
			merged[k] = v
		}
	}
	f := valid.NewForm(merged)
	enabled, _ := f.Bool("enabled", false, nil)
	referee, _ := planBonusForm(f, "referee", PlanBonus{0, 1})
	referrer, _ := planBonusForm(f, "referrer", PlanBonus{0, 1})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	next := Settings{enabled, referee, referrer}
	actor, _ := bson.ObjectIDFromHex(authz.From(c).UserID)
	now := time.Now().UTC()
	_, err = p.col("platformsettings").UpdateOne(c, bson.D{{Key: "key", Value: "hostel-referrals"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "key", Value: "hostel-referrals"}, {Key: "updatedBy", Value: actor}, {Key: "value", Value: bson.D{{Key: "enabled", Value: next.Enabled},
			{Key: "referee", Value: bson.D{{Key: "days", Value: next.Referee.Days}, {Key: "months", Value: next.Referee.Months}}},
			{Key: "referrer", Value: bson.D{{Key: "days", Value: next.Referrer.Days}, {Key: "months", Value: next.Referrer.Months}}}}}, {Key: "updatedAt", Value: now}}},
			{Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}}, options.UpdateOne().SetUpsert(true))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "settings", Value: next.out()}}, "Referral settings saved")
}

var codeRe = regexp.MustCompile(`^[a-zA-Z0-9-]*$`)

// codeFields reads partnerCodeCreateSchema, or for an update only the keys sent.
// TS's update kept the create schema's offer defaults through `.partial()`, so
// every edit reset offerDays and offerMonths to 0 (P7-24).
func codeFields(body any, update bool) (bson.D, error) {
	f := valid.NewForm(body)
	set := bson.D{}
	put := func(k string, v any, ok bool) {
		if ok {
			set = append(set, bson.E{Key: k, Value: v})
		}
	}
	if !update {
		v, ok := f.Str("code", valid.S{Opt: true, Trim: true, Max: 24, Re: codeRe, ReMsg: "Letters and numbers only."})
		put("code", v, ok)
	}
	kind, ok := f.Enum("commissionType", update, nil, "AMOUNT", "PERCENT")
	put("commissionType", kind, ok)
	value, ok := f.Num("commissionValue", valid.N{Opt: update, Coerce: true, Min: valid.P(0), Max: valid.P(1_000_000)})
	put("commissionValue", value, ok)
	v, ok := f.Str("contact", valid.S{Opt: true, Trim: true, Max: 160})
	put("contact", v, ok)
	v, ok = f.Str("name", valid.S{Opt: update, Trim: true, Min: 2, Max: 120})
	put("name", v, ok)
	v, ok = f.Str("note", valid.S{Opt: true, Trim: true, Max: 500})
	put("note", v, ok)
	days := valid.N{Opt: true, Coerce: true, Int: true, Min: valid.P(0), Max: valid.P(365)}
	months := valid.N{Opt: true, Coerce: true, Int: true, Min: valid.P(0), Max: valid.P(24)}
	if !update {
		days.Default, months.Default = valid.P(0), valid.P(0)
	}
	n, ok := f.Num("offerDays", days)
	put("offerDays", n, ok)
	n, ok = f.Num("offerMonths", months)
	put("offerMonths", n, ok)
	if update {
		s, ok := f.Enum("status", true, nil, "ACTIVE", "INACTIVE")
		put("status", s, ok)
	}
	if !f.Hard && kind == "PERCENT" && value > 100 {
		f.Is.Add("commissionValue", "A percent commission is 100 at most.")
	}
	if err := f.Err(); err != nil {
		return nil, err
	}
	return set, nil
}

func get(d bson.D, k string) (any, bool) {
	for _, e := range d {
		if e.Key == k {
			return e.Value, true
		}
	}
	return nil, false
}

// uniqueCode is uniquePartnerCode: the name's letters and four digits.
func (p *Platform) uniqueCode(ctx context.Context, name string) (string, error) {
	letters := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return -1
		}
		return r
	}, Normalize(name))
	if len(letters) > 5 {
		letters = letters[:5]
	}
	if letters == "" {
		letters = "HP"
	}
	for range 5 {
		code := letters + strconv.Itoa(1000+rand.IntN(9000))
		n, err := p.col("hostelreferralcodes").CountDocuments(ctx, bson.D{{Key: "code", Value: code}}, options.Count().SetLimit(1))
		if err != nil {
			return "", err
		}
		if n == 0 {
			return code, nil
		}
	}
	return "", referralErr("Could not make a free code. Type one instead.")
}

func (p *Platform) createCode(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	set, err := codeFields(body, false)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	raw, _ := get(set, "code")
	name, _ := get(set, "name")
	code := ""
	if s, _ := raw.(string); s != "" {
		code = Normalize(s)
	} else if code, err = p.uniqueCode(c, name.(string)); err != nil {
		httpx.Fail(c, err)
		return
	}
	if len(code) < 4 {
		httpx.Fail(c, referralErr("A code needs at least 4 letters or numbers."))
		return
	}
	taken := httpx.NewError(http.StatusConflict, "CODE_TAKEN", code+" is already in use. Pick another.", nil)
	if n, err := p.col("hostelreferralcodes").CountDocuments(c, bson.D{{Key: "code", Value: code}}, options.Count().SetLimit(1)); err != nil {
		httpx.Fail(c, err)
		return
	} else if n > 0 {
		httpx.Fail(c, taken)
		return
	}
	str := func(k string) string { v, _ := get(set, k); s, _ := v.(string); return s }
	num := func(k string) float64 { v, _ := get(set, k); n, _ := v.(float64); return n }
	actor, _ := bson.ObjectIDFromHex(authz.From(c).UserID)
	now := time.Now().UTC().Truncate(time.Millisecond)
	rec := codeRecord{ID: bson.NewObjectID(), Code: code, CommissionType: str("commissionType"), CommissionValue: num("commissionValue"), Contact: str("contact"), CreatedAt: now,
		Name: str("name"), Note: str("note"), OfferDays: num("offerDays"), OfferMonths: num("offerMonths"), Status: "ACTIVE"}
	_, err = p.col("hostelreferralcodes").InsertOne(c, bson.D{{Key: "_id", Value: rec.ID}, {Key: "code", Value: rec.Code}, {Key: "kind", Value: "PARTNER"}, {Key: "hostelId", Value: nil},
		{Key: "name", Value: rec.Name}, {Key: "contact", Value: rec.Contact}, {Key: "note", Value: rec.Note}, {Key: "offerMonths", Value: rec.OfferMonths}, {Key: "offerDays", Value: rec.OfferDays},
		{Key: "commissionType", Value: rec.CommissionType}, {Key: "commissionValue", Value: rec.CommissionValue}, {Key: "status", Value: rec.Status}, {Key: "createdBy", Value: actor},
		{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}})
	if mongo.IsDuplicateKeyError(err) {
		httpx.Fail(c, taken) // a racing create of the same code
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusCreated, p.serializeCode(&rec, nil), "Partner code created")
}

func (p *Platform) updateCode(c *gin.Context) {
	id, err := bson.ObjectIDFromHex(c.Param("codeId"))
	if err != nil {
		httpx.Fail(c, notFound("code"))
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	set, err := codeFields(body, true)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var cur codeRecord
	if err := p.col("hostelreferralcodes").FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "kind", Value: "PARTNER"}}).Decode(&cur); errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, notFound("code"))
		return
	} else if err != nil {
		httpx.Fail(c, err)
		return
	}
	kind, value := cur.CommissionType, cur.CommissionValue
	if v, ok := get(set, "commissionType"); ok {
		kind = v.(string)
	}
	if v, ok := get(set, "commissionValue"); ok {
		value = v.(float64)
	}
	if kind == "PERCENT" && value > 100 {
		httpx.Fail(c, referralErr("A percent commission is 100 at most."))
		return
	}
	set = append(set, bson.E{Key: "updatedAt", Value: time.Now().UTC()})
	var rec codeRecord
	if err := p.col("hostelreferralcodes").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: set}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&rec); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, p.serializeCode(&rec, nil), "Partner code updated")
}

// markPaid is markCommissionPaid.
func (p *Platform) markPaid(c *gin.Context) {
	raw := c.Param("referralId")
	id, err := bson.ObjectIDFromHex(raw)
	if err != nil {
		httpx.Fail(c, notFound("referral"))
		return
	}
	res, err := p.col("hostelreferrals").UpdateOne(c, bson.D{{Key: "_id", Value: id}, {Key: "commission.status", Value: "EARNED"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "commission.paidAt", Value: time.Now().UTC()}, {Key: "commission.status", Value: "PAID"}, {Key: "updatedAt", Value: time.Now().UTC()}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if res.ModifiedCount == 0 {
		httpx.Fail(c, httpx.NewError(http.StatusConflict, "NOTHING_OWED", "There is no unpaid commission on that referral.", nil))
		return
	}
	actor, _ := bson.ObjectIDFromHex(authz.From(c).UserID)
	if err := p.Audit.Write(c, audit.Entry{Action: "HOSTEL_REFERRAL_COMMISSION_PAID", ActorID: actor, EntityID: raw, EntityType: "HostelReferral"}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "id", Value: raw}}, "Commission marked paid")
}
