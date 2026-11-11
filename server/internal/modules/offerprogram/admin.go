package offerprogram

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Admin is /platform/offer-program. Superadmin only: awards are HostelPalika's
// money, the same rule as sponsors and the store.
type Admin struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Audit  *audit.Log
	Notify *notifications.Service
	Mail   *email.Sender
	AppURL func(path string) string
	// ApplyFeeOffs is ledger.Engine.ApplyPendingFeeOffs: logs, never fails.
	ApplyFeeOffs func(ctx context.Context, resident bson.ObjectID)
}

func (a *Admin) Register(v1 *gin.RouterGroup) {
	g := v1.Group("/platform/offer-program", authz.Use(a.Guards.RequireSuperadmin))
	g.GET("", httpx.ETag(), a.overview)
	g.POST("/perks", a.createPerk)
	g.PATCH("/perks/:perkId", a.updatePerk)
	g.DELETE("/perks/:perkId", a.deletePerk)
	g.POST("/awards", a.award)
	g.PATCH("/awards/:awardId", a.updateAward)
}

func opErr(status int, code, msg string) error { return httpx.NewError(status, code, msg, nil) }

var quarterRe = regexp.MustCompile(`^(\d{4})-Q([1-4])$`)

type quarter struct {
	key, label string
	from, to   time.Time
}

// bounds is offerQuarterBounds.
func bounds(key string) (quarter, error) {
	var y, q int
	if _, err := fmt.Sscanf(key, "%d-Q%d", &y, &q); err != nil {
		return quarter{}, err
	}
	first := (q-1)*3 + 1
	start, err := bs.PeriodBounds(bs.FormatPeriodKey(y, first))
	if err != nil {
		return quarter{}, err
	}
	end, err := bs.PeriodBounds(bs.FormatPeriodKey(y, first+2))
	if err != nil {
		return quarter{}, err
	}
	return quarter{key, QuarterLabel(key), start.Start, end.End}, nil
}

// shift is shiftOfferQuarter.
func shift(key string, delta int) string {
	var y, q int
	_, _ = fmt.Sscanf(key, "%d-Q%d", &y, &q)
	i := y*4 + q - 1 + delta
	return fmt.Sprintf("%d-Q%d", i/4, i%4+1)
}

// resolve is resolveQuarter: the asked quarter if it is a real one not in the future.
func resolve(input string) (quarter, string, error) {
	current, err := QuarterOf(time.Now())
	if err != nil {
		return quarter{}, "", err
	}
	key := current
	if quarterRe.MatchString(input) && input <= current {
		key = input
	}
	b, err := bounds(key)
	if err != nil {
		b, err = bounds(current)
	}
	return b, current, err
}

func certifiedIn(from, to time.Time) bson.D {
	return bson.D{{Key: "certificationCode", Value: bson.D{{Key: "$type", Value: "string"}}}, {Key: "certifiedAt", Value: bson.D{{Key: "$gte", Value: from}, {Key: "$lte", Value: to}}}, {Key: "voidedAt", Value: nil}}
}

type perkRow struct {
	ID          bson.ObjectID `bson:"_id"`
	Description string        `bson:"description"`
	GiftValue   *float64      `bson:"giftValue"`
	ImageURL    string        `bson:"imageUrl"`
	IsActive    bool          `bson:"isActive"`
	Kind        string        `bson:"kind"`
	Partner     string        `bson:"partner"`
	PercentOff  *float64      `bson:"percentOff"`
	SortOrder   float64       `bson:"sortOrder"`
	Title       string        `bson:"title"`
}

func (p *perkRow) out() ordered.Map {
	partner := p.Partner
	if partner == "" {
		partner = platformName
	}
	return ordered.Map{{Key: "description", Value: p.Description}, {Key: "giftValue", Value: p.GiftValue}, {Key: "id", Value: p.ID.Hex()}, {Key: "imageUrl", Value: p.ImageURL},
		{Key: "isActive", Value: p.IsActive}, {Key: "kind", Value: p.Kind}, {Key: "partner", Value: partner}, {Key: "percentOff", Value: p.PercentOff}, {Key: "sortOrder", Value: p.SortOrder}, {Key: "title", Value: p.Title}}
}

type awardRow struct {
	ID            bson.ObjectID  `bson:"_id"`
	AppliedAmount *float64       `bson:"appliedAmount"`
	AppliedAt     *time.Time     `bson:"appliedAt"`
	AppliedInv    *bson.ObjectID `bson:"appliedInvoiceId"`
	CreatedAt     time.Time      `bson:"createdAt"`
	DeliveredAt   *time.Time     `bson:"deliveredAt"`
	HostelID      bson.ObjectID  `bson:"hostelId"`
	HostelPaidAt  *time.Time     `bson:"hostelPaidAt"`
	Kind          string         `bson:"kind"`
	Note          string         `bson:"note"`
	PercentOff    *float64       `bson:"percentOff"`
	Quarter       string         `bson:"quarter"`
	ResidentID    bson.ObjectID  `bson:"residentId"`
	Status        string         `bson:"status"`
	Title         string         `bson:"title"`
}

func isoOrNil(t *time.Time) any {
	if t == nil {
		return nil
	}
	return httpx.ISO(*t)
}

// out is serializeAward; period is the applied bill's BS month.
func (w *awardRow) out(period string) ordered.Map {
	var applied any
	if period != "" {
		if f := bs.FormatPeriod(period); f != "" {
			applied = f
		} else {
			applied = period
		}
	}
	label := w.Quarter
	if quarterRe.MatchString(w.Quarter) {
		label = QuarterLabel(w.Quarter)
	}
	return ordered.Map{{Key: "appliedAmount", Value: w.AppliedAmount}, {Key: "appliedAt", Value: isoOrNil(w.AppliedAt)}, {Key: "appliedPeriod", Value: applied}, {Key: "awardedAt", Value: httpx.ISO(w.CreatedAt)},
		{Key: "deliveredAt", Value: isoOrNil(w.DeliveredAt)}, {Key: "hostelPaidAt", Value: isoOrNil(w.HostelPaidAt)}, {Key: "id", Value: w.ID.Hex()}, {Key: "kind", Value: w.Kind}, {Key: "note", Value: w.Note},
		{Key: "percentOff", Value: w.PercentOff}, {Key: "quarter", Value: w.Quarter}, {Key: "quarterLabel", Value: label}, {Key: "status", Value: w.Status}, {Key: "title", Value: w.Title}}
}

type residentRow struct {
	ID        bson.ObjectID  `bson:"_id"`
	Email     string         `bson:"email"`
	FirstName string         `bson:"firstName"`
	FullName  string         `bson:"fullName"`
	HostelID  bson.ObjectID  `bson:"hostelId"`
	IsDeleted bool           `bson:"isDeleted"`
	LastName  string         `bson:"lastName"`
	Status    *string        `bson:"status"`
	UserID    *bson.ObjectID `bson:"userId"`
}

func (r *residentRow) name() string {
	if r == nil {
		return "Resident"
	}
	if r.FullName != "" {
		return r.FullName
	}
	if n := strings.TrimSpace(strings.Join(nonEmpty(r.FirstName, r.LastName), " ")); n != "" {
		return n
	}
	return "Resident"
}

func nonEmpty(s ...string) []string {
	var out []string
	for _, x := range s {
		if x != "" {
			out = append(out, x)
		}
	}
	return out
}

func all[T any](ctx context.Context, cur *mongo.Cursor, err error) ([]T, error) {
	if err != nil {
		return nil, err
	}
	var out []T
	return out, cur.All(ctx, &out)
}

// overview is getOfferProgramOverview: who is eligible in a quarter, who was given
// what, the catalogue, and what HostelPalika still owes hostels for fee-offs.
func (a *Admin) overview(c *gin.Context) {
	b, current, err := resolve(c.Query("quarter"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	type group struct {
		ID       bson.ObjectID `bson:"_id"`
		Amount   float64       `bson:"amount"`
		Bills    int           `bson:"bills"`
		Count    int           `bson:"count"`
		HostelID bson.ObjectID `bson:"hostelId"`
	}
	cur, err := a.DB.Collection("receipts").Aggregate(c, bson.A{
		bson.D{{Key: "$match", Value: certifiedIn(b.from, b.to)}},
		bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$residentId"}, {Key: "amount", Value: bson.D{{Key: "$sum", Value: "$amount"}}}, {Key: "bills", Value: bson.D{{Key: "$addToSet", Value: "$invoiceId"}}},
			{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}}, {Key: "hostelId", Value: bson.D{{Key: "$first", Value: "$hostelId"}}}}}},
		bson.D{{Key: "$project", Value: bson.D{{Key: "amount", Value: 1}, {Key: "bills", Value: bson.D{{Key: "$size", Value: "$bills"}}}, {Key: "count", Value: 1}, {Key: "hostelId", Value: 1}}}},
		bson.D{{Key: "$sort", Value: bson.D{{Key: "bills", Value: -1}, {Key: "amount", Value: -1}}}},
		// ponytail: first 500 only; page this when a quarter has more certified residents.
		bson.D{{Key: "$limit", Value: 500}},
	})
	groups, err := all[group](c, cur, err)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	// D4: the credit score ranks residents inside the program — first for gifts.
	ids := make([]bson.ObjectID, len(groups))
	for i, g := range groups {
		ids[i] = g.ID
	}
	scores, err := finance.CreditScoresFor(c, a.DB, ids)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	sort.SliceStable(groups, func(x, y int) bool {
		gx, gy := groups[x], groups[y]
		if scores[gx.ID] != scores[gy.ID] {
			return scores[gx.ID] > scores[gy.ID]
		}
		if gx.Bills != gy.Bills {
			return gx.Bills > gy.Bills
		}
		return gx.Amount > gy.Amount
	})
	cur, err = a.DB.Collection("offerawards").Find(c, bson.D{{Key: "quarter", Value: b.key}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}))
	awards, err := all[awardRow](c, cur, err)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err = a.DB.Collection("offerperks").Find(c, bson.D{}, options.Find().SetSort(bson.D{{Key: "sortOrder", Value: 1}, {Key: "createdAt", Value: 1}}))
	perks, err := all[perkRow](c, cur, err)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err = a.DB.Collection("offerawards").Aggregate(c, bson.A{bson.D{{Key: "$match", Value: bson.D{{Key: "hostelPaidAt", Value: nil}, {Key: "status", Value: "APPLIED"}}}},
		bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: nil}, {Key: "amount", Value: bson.D{{Key: "$sum", Value: "$appliedAmount"}}}, {Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}}}}}})
	owed, err := all[struct {
		Amount float64 `bson:"amount"`
		Count  int     `bson:"count"`
	}](c, cur, err)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	resIDs, hostelIDs, invIDs := bson.A{}, bson.A{}, bson.A{}
	for _, g := range groups {
		resIDs, hostelIDs = append(resIDs, g.ID), append(hostelIDs, g.HostelID)
	}
	for _, w := range awards {
		resIDs, hostelIDs = append(resIDs, w.ResidentID), append(hostelIDs, w.HostelID)
		if w.AppliedInv != nil {
			invIDs = append(invIDs, *w.AppliedInv)
		}
	}
	cur, err = a.DB.Collection("residents").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: resIDs}}}},
		options.Find().SetProjection(bson.D{{Key: "firstName", Value: 1}, {Key: "fullName", Value: 1}, {Key: "lastName", Value: 1}, {Key: "status", Value: 1}, {Key: "isDeleted", Value: 1}}))
	res, err := all[residentRow](c, cur, err)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err = a.DB.Collection("hostels").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: hostelIDs}}}}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}))
	hs, err := all[struct {
		ID   bson.ObjectID `bson:"_id"`
		Name *string       `bson:"name"`
	}](c, cur, err)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	periods := map[bson.ObjectID]string{}
	if len(invIDs) > 0 {
		cur, err = a.DB.Collection("invoices").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: invIDs}}}}, options.Find().SetProjection(bson.D{{Key: "period", Value: 1}}))
		invs, err := all[struct {
			ID     bson.ObjectID `bson:"_id"`
			Period *string       `bson:"period"`
		}](c, cur, err)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		for _, v := range invs {
			if v.Period != nil {
				periods[v.ID] = *v.Period
			}
		}
	}
	byResident := map[bson.ObjectID]*residentRow{}
	for i := range res {
		byResident[res[i].ID] = &res[i]
	}
	hostelName := map[bson.ObjectID]string{}
	for _, h := range hs {
		n := "Hostel"
		if h.Name != nil {
			n = *h.Name
		}
		hostelName[h.ID] = n
	}
	awardOf := map[bson.ObjectID]*awardRow{}
	for i := len(awards) - 1; i >= 0; i-- { // the Map keeps the last write: the oldest
		awardOf[awards[i].ResidentID] = &awards[i]
	}
	who := func(resident, hostel bson.ObjectID) ordered.Map {
		r := byResident[resident]
		status := "UNKNOWN"
		if r != nil {
			if r.IsDeleted {
				status = "DELETED"
			} else if r.Status != nil {
				status = *r.Status
			}
		}
		name, ok := hostelName[hostel]
		if !ok {
			name = "Hostel"
		}
		return ordered.Map{{Key: "hostelName", Value: name}, {Key: "residentId", Value: resident.Hex()}, {Key: "residentName", Value: r.name()}, {Key: "residentStatus", Value: status}}
	}
	awardsOut := make([]ordered.Map, len(awards))
	for i := range awards {
		w := &awards[i]
		period := ""
		if w.AppliedInv != nil {
			period = periods[*w.AppliedInv]
		}
		awardsOut[i] = append(w.out(period), who(w.ResidentID, w.HostelID)...)
	}
	eligible := make([]ordered.Map, len(groups))
	for i, g := range groups {
		var award any
		if w := awardOf[g.ID]; w != nil {
			award = ordered.Map{{Key: "id", Value: w.ID.Hex()}, {Key: "status", Value: w.Status}, {Key: "title", Value: w.Title}}
		}
		eligible[i] = append(who(g.ID, g.HostelID), ordered.Pair{Key: "award", Value: award}, ordered.Pair{Key: "bills", Value: g.Bills},
			ordered.Pair{Key: "certifiedAmount", Value: g.Amount}, ordered.Pair{Key: "certifiedCount", Value: g.Count}, ordered.Pair{Key: "creditScore", Value: scores[g.ID]})
	}
	owedOut := ordered.Map{{Key: "amount", Value: 0}, {Key: "count", Value: 0}}
	if len(owed) > 0 {
		owedOut = ordered.Map{{Key: "amount", Value: owed[0].Amount}, {Key: "count", Value: owed[0].Count}}
	}
	perksOut := make([]ordered.Map, len(perks))
	for i := range perks {
		perksOut[i] = perks[i].out()
	}
	var next any
	if b.key < current {
		next = shift(b.key, 1)
	}
	httpx.OK(c, ordered.Map{{Key: "awards", Value: awardsOut}, {Key: "eligible", Value: eligible}, {Key: "owedToHostels", Value: owedOut}, {Key: "perks", Value: perksOut},
		{Key: "quarter", Value: ordered.Map{{Key: "from", Value: httpx.ISO(b.from)}, {Key: "isCurrent", Value: b.key == current}, {Key: "key", Value: b.key}, {Key: "label", Value: b.label},
			{Key: "next", Value: next}, {Key: "previous", Value: shift(b.key, -1)}, {Key: "to", Value: httpx.ISO(b.to)}}}}, "Offer Program")
}

// audited never fails the change the owner just made.
func (a *Admin) audited(c *gin.Context, action, entityType string, id bson.ObjectID, meta bson.D, hostel *bson.ObjectID) {
	actor, _ := bson.ObjectIDFromHex(authz.From(c).UserID)
	e := audit.Entry{Action: action, ActorID: actor, EntityID: id.Hex(), EntityType: entityType, Metadata: meta}
	if hostel != nil {
		e.HostelID = *hostel
	}
	_ = a.Audit.Write(c, e)
}

var imageRe = regexp.MustCompile(`(?i)^https?://`)

// nullableInt is `z.coerce.number().int().min(lo).max(hi).nullable()`.
func nullableInt(f *valid.Form, key string, lo, hi float64, opt bool) (any, bool) {
	v, present := f.M[key]
	if !present && opt {
		return nil, false
	}
	if present && v == nil {
		return nil, true
	}
	n, ok := f.Num(key, valid.N{Coerce: true, Int: true, Min: valid.P(lo), Max: valid.P(hi)})
	if !ok {
		return nil, false
	}
	return n, true
}

// perkFields reads perkCreateSchema, or perkUpdateSchema's present keys.
func perkFields(body any, update bool) (bson.D, error) {
	f := valid.NewForm(body)
	set := bson.D{}
	put := func(k string, v any, ok bool) {
		if ok {
			set = append(set, bson.E{Key: k, Value: v})
		}
	}
	str := func(key string, o valid.S) {
		v, ok := f.Str(key, o)
		if !ok && !update && !f.Present(key) {
			v, ok = "", true
		}
		put(key, v, ok)
	}
	str("description", valid.S{Opt: true, Trim: true, Max: 300})
	g, ok := nullableInt(f, "giftValue", 0, 1_000_000, true)
	put("giftValue", g, ok)
	img, ok := f.Str("imageUrl", valid.S{Opt: true, Trim: true, Max: 500})
	if ok && img != "" && img[0] != '/' && !imageRe.MatchString(img) {
		f.Is.Add("imageUrl", "Image must start with / or http(s)://")
		ok = false
	}
	if !ok && !update && !f.Present("imageUrl") {
		img, ok = "", true
	}
	put("imageUrl", img, ok)
	var yes *bool
	if !update {
		t := true
		yes = &t
	}
	active, ok := f.Bool("isActive", true, yes)
	put("isActive", active, ok)
	kind, ok := f.Enum("kind", update, nil, "FEE_OFF", "GIFT")
	put("kind", kind, ok)
	str("partner", valid.S{Opt: true, Trim: true, Max: 80})
	pct, ok := nullableInt(f, "percentOff", 1, 100, true)
	put("percentOff", pct, ok)
	n := valid.N{Opt: true, Coerce: true, Int: true, Min: valid.P(-1000), Max: valid.P(1000)}
	if !update {
		n.Default = valid.P(0)
	}
	sort, ok := f.Num("sortOrder", n)
	put("sortOrder", sort, ok)
	t, ok := f.Str("title", valid.S{Opt: update, Trim: true, Min: 1, Max: 80})
	put("title", t, ok)
	if !update && !f.Hard && kind == "FEE_OFF" && (pct == nil || pct == 0.0) {
		f.Is.Add("percentOff", "A fee-off perk needs a percent off, 1–100.")
	}
	if update && !f.Hard && len(f.Is) == 0 && len(set) == 0 {
		f.Is.Add("", "Nothing to update.")
	}
	if err := f.Err(); err != nil {
		return nil, err
	}
	if !update && kind == "GIFT" {
		for i := range set {
			if set[i].Key == "percentOff" {
				set[i].Value = nil
			}
		}
		if _, has := f.M["percentOff"]; !has {
			set = append(set, bson.E{Key: "percentOff", Value: nil})
		}
	}
	return set, nil
}

func (a *Admin) createPerk(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	set, err := perkFields(body, false)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, _ := bson.ObjectIDFromHex(authz.From(c).UserID)
	now := time.Now().UTC().Truncate(time.Millisecond)
	id := bson.NewObjectID()
	doc := append(append(bson.D{{Key: "_id", Value: id}}, set...), bson.E{Key: "createdBy", Value: actor}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := a.DB.Collection("offerperks").InsertOne(c, doc); err != nil {
		httpx.Fail(c, err)
		return
	}
	var p perkRow
	if err := a.DB.Collection("offerperks").FindOne(c, bson.D{{Key: "_id", Value: id}}).Decode(&p); err != nil {
		httpx.Fail(c, err)
		return
	}
	a.audited(c, "OFFER_PERK_CREATED", "OfferPerk", id, bson.D{{Key: "title", Value: p.Title}}, nil)
	httpx.Write(c, http.StatusCreated, p.out(), "Perk created")
}

func perkNotFound() error {
	return opErr(http.StatusNotFound, "OFFER_PERK_NOT_FOUND", "Perk was not found.")
}

func (a *Admin) updatePerk(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	set, err := perkFields(body, true)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := httpx.OID(c.Param("perkId"), "perk id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	fields := make([]string, len(set))
	for i, e := range set {
		fields[i] = e.Key
	}
	var p perkRow
	err = a.DB.Collection("offerperks").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: append(set, bson.E{Key: "updatedAt", Value: time.Now().UTC()})}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&p)
	if errors.Is(err, mongo.ErrNoDocuments) {
		err = perkNotFound()
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	a.audited(c, "OFFER_PERK_UPDATED", "OfferPerk", id, bson.D{{Key: "fields", Value: fields}}, nil)
	httpx.OK(c, p.out(), "Perk updated")
}

// deletePerk: awards keep their own copy of the perk, so deleting one rewrites nothing.
func (a *Admin) deletePerk(c *gin.Context) {
	id, err := httpx.OID(c.Param("perkId"), "perk id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var p perkRow
	err = a.DB.Collection("offerperks").FindOneAndDelete(c, bson.D{{Key: "_id", Value: id}}).Decode(&p)
	if errors.Is(err, mongo.ErrNoDocuments) {
		err = perkNotFound()
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	a.audited(c, "OFFER_PERK_DELETED", "OfferPerk", id, bson.D{{Key: "title", Value: p.Title}}, nil)
	httpx.OK(c, ordered.Map{{Key: "deleted", Value: true}}, "Perk deleted")
}

var awardQuarterRe = regexp.MustCompile(`^\d{4}-Q[1-4]$`)

// award is awardOffer: one eligible resident gets a perk for a quarter; a fee-off
// goes onto an open bill at once.
func (a *Admin) award(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	note, _ := f.Str("note", valid.S{Opt: true, Trim: true, Max: 300})
	perkID, _ := f.Str("perkId", valid.S{Trim: true, Min: 1})
	q, _ := f.Str("quarter", valid.S{Re: awardQuarterRe, ReMsg: "Quarter looks like 2083-Q2."})
	residentID, _ := f.Str("residentId", valid.S{Trim: true, Min: 1})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	b, current, err := resolve(q)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if b.key != q || q > current {
		httpx.Fail(c, opErr(400, "OFFER_QUARTER_INVALID", "Offers are given for this quarter or an earlier one."))
		return
	}
	pid, err := httpx.OID(perkID, "perk id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rid, err := httpx.OID(residentID, "resident id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var p perkRow
	if err := a.DB.Collection("offerperks").FindOne(c, bson.D{{Key: "_id", Value: pid}, {Key: "isActive", Value: true}}).Decode(&p); errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, opErr(404, "OFFER_PERK_NOT_FOUND", "That perk is not active."))
		return
	} else if err != nil {
		httpx.Fail(c, err)
		return
	}
	var r residentRow
	if err := a.DB.Collection("residents").FindOne(c, bson.D{{Key: "_id", Value: rid}, {Key: "isDeleted", Value: false}}).Decode(&r); errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, opErr(404, "RESIDENT_NOT_FOUND", "Resident was not found."))
		return
	} else if err != nil {
		httpx.Fail(c, err)
		return
	}
	n, err := a.DB.Collection("receipts").CountDocuments(c, append(bson.D{{Key: "residentId", Value: r.ID}}, certifiedIn(b.from, b.to)...), options.Count().SetLimit(1))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if n == 0 {
		httpx.Fail(c, opErr(400, "OFFER_NOT_ELIGIBLE", r.name()+" has no certified receipt in "+b.label+"."))
		return
	}
	actor, _ := bson.ObjectIDFromHex(authz.From(c).UserID)
	now := time.Now().UTC().Truncate(time.Millisecond)
	var pct any
	if p.Kind == "FEE_OFF" && p.PercentOff != nil {
		pct = *p.PercentOff
	}
	id := bson.NewObjectID()
	doc := bson.D{{Key: "_id", Value: id}, {Key: "perkId", Value: p.ID}, {Key: "residentId", Value: r.ID}, {Key: "hostelId", Value: r.HostelID}, {Key: "userId", Value: r.UserID}, {Key: "quarter", Value: b.key},
		{Key: "title", Value: p.Title}, {Key: "kind", Value: p.Kind}, {Key: "percentOff", Value: pct}, {Key: "status", Value: "AWARDED"}, {Key: "appliedInvoiceId", Value: nil}, {Key: "appliedEventId", Value: nil},
		{Key: "appliedAmount", Value: nil}, {Key: "appliedAt", Value: nil}, {Key: "hostelPaidAt", Value: nil}, {Key: "deliveredAt", Value: nil}, {Key: "cancelledAt", Value: nil}}
	if _, has := f.M["note"]; has {
		doc = append(doc, bson.E{Key: "note", Value: note})
	}
	doc = append(doc, bson.E{Key: "awardedBy", Value: actor}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := a.DB.Collection("offerawards").InsertOne(c, doc); mongo.IsDuplicateKeyError(err) {
		httpx.Fail(c, opErr(http.StatusConflict, "OFFER_ALREADY_AWARDED", r.name()+" already has an offer for "+b.label+"."))
		return
	} else if err != nil {
		httpx.Fail(c, err)
		return
	}
	a.audited(c, "OFFER_AWARDED", "OfferAward", id, bson.D{{Key: "kind", Value: p.Kind}, {Key: "quarter", Value: b.key}, {Key: "residentId", Value: r.ID.Hex()}, {Key: "title", Value: p.Title}}, &r.HostelID)
	if p.Kind == "FEE_OFF" && a.ApplyFeeOffs != nil {
		a.ApplyFeeOffs(c, r.ID)
	}
	var w awardRow
	if err := a.DB.Collection("offerawards").FindOne(c, bson.D{{Key: "_id", Value: id}}).Decode(&w); err != nil {
		httpx.Fail(c, err)
		return
	}
	a.notifyAward(c, &w, &r, b.label)
	httpx.Write(c, http.StatusCreated, w.out(""), "Offer given")
}

// notifyAward never fails the award.
func (a *Admin) notifyAward(ctx context.Context, w *awardRow, r *residentRow, label string) {
	pct := 0.0
	if w.PercentOff != nil {
		pct = *w.PercentOff
	}
	body := w.Title + ": a gift from " + platformName + ". Our team will contact you."
	if w.Kind == "FEE_OFF" {
		body = fmt.Sprintf("%s: %s%% of your next monthly fee, paid by %s.", w.Title, numText(w.PercentOff), platformName)
	}
	if r.UserID != nil {
		_, _ = a.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/resident/offer-program", Body: body, Category: "PAYMENT", HostelID: r.HostelID.Hex(), Kind: "NORMAL",
			Title: "You got a Resident Offer Program offer", UserID: r.UserID.Hex()})
	}
	contact := residents.ResolveContact(ctx, a.DB, r.Email, r.FirstName, r.LastName, r.UserID)
	if contact == nil {
		return
	}
	name := contact.Name
	if name == "" {
		name = r.FirstName
	}
	m := email.OfferAwarded(w.Kind, a.AppURL("/resident/offer-program"), pct, label, name, w.Title)
	if !a.Mail.Notify(ctx, email.Notification{Action: "offer_awarded", To: contact.Email, Subject: m.Subject, HTML: m.HTML, Category: m.Category}) {
		slog.WarnContext(ctx, "offer_award_notification_failed", "awardId", w.ID.Hex())
	}
}

// numText is a JS number's text: `null` when there is none, as a template literal prints it.
func numText(f *float64) string {
	if f == nil {
		return "null"
	}
	return strings.TrimSuffix(strings.TrimRight(fmt.Sprintf("%f", *f), "0"), ".")
}

// updateAward: `deliver` a gift, mark an applied fee-off `hostel-paid`, or `cancel`
// one not yet used. An applied fee-off is money on a bill, undone by reversing that payment.
func (a *Admin) updateAward(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	action, _ := f.Enum("action", false, nil, "cancel", "deliver", "hostel-paid")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := httpx.OID(c.Param("awardId"), "award id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	filter := bson.D{{Key: "_id", Value: id}}
	var set bson.D
	switch action {
	case "cancel":
		filter = append(filter, bson.E{Key: "status", Value: "AWARDED"})
		set = bson.D{{Key: "cancelledAt", Value: now}, {Key: "status", Value: "CANCELLED"}}
	case "deliver":
		filter = append(filter, bson.E{Key: "kind", Value: "GIFT"}, bson.E{Key: "status", Value: "AWARDED"})
		set = bson.D{{Key: "deliveredAt", Value: now}, {Key: "status", Value: "DELIVERED"}}
	default:
		filter = append(filter, bson.E{Key: "hostelPaidAt", Value: nil}, bson.E{Key: "status", Value: "APPLIED"})
		set = bson.D{{Key: "hostelPaidAt", Value: now}}
	}
	var w awardRow
	err = a.DB.Collection("offerawards").FindOneAndUpdate(c, filter, bson.D{{Key: "$set", Value: append(set, bson.E{Key: "updatedAt", Value: now})}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&w)
	if errors.Is(err, mongo.ErrNoDocuments) {
		err = opErr(http.StatusConflict, "OFFER_AWARD_STATE", "That offer cannot be changed that way now.")
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	a.audited(c, "OFFER_AWARD_"+strings.Replace(strings.ToUpper(action), "-", "_", 1), "OfferAward", w.ID, bson.D{{Key: "status", Value: w.Status}}, &w.HostelID)
	httpx.OK(c, w.out(""), "Offer updated")
}
