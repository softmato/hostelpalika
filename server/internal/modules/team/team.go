// Package team is modules/team: the field team's own routes (their filings,
// wallet, the registration track sheet) and the superadmin's view of the team.
package team

import (
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

type Handler struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Config *platformconfig.Service
	Audit  *audit.Log
	RT     *realtime.Client
	Now    func() time.Time
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	e := httpx.ETag()
	team := authz.Use(h.Guards.RequireTeam)
	v1.GET("/team/collection-qr", team, e, h.collectionQR)
	v1.GET("/team/setup-fee", team, e, h.setupFee)
	v1.GET("/team/email-check", team, e, h.emailCheck)
	v1.GET("/team/summary", team, e, h.summary)
	v1.GET("/team/hostels", team, e, h.hostels)
	v1.GET("/team/wallet", team, e, h.wallet)
	v1.GET("/team/registration-track-sheet", team, e, h.trackSheet)
	v1.PUT("/team/registration-track-sheet", team, h.saveTrackSheet)
	v1.POST("/team/registration-track-sheet/focus", team, h.focus)

	super := authz.Use(h.Guards.RequireSuperadmin)
	v1.GET("/platform/team", super, e, h.platformTeam)
	v1.GET("/platform/team/wallets", super, e, h.wallets)
	v1.POST("/platform/team/wallets/:agentId", super, h.payout)
}

func (h *Handler) col(n string) *mongo.Collection { return h.DB.Collection(n) }

func findAll[T any](ctx context.Context, coll *mongo.Collection, filter any, opts ...options.Lister[options.FindOptions]) ([]T, error) {
	cur, err := coll.Find(ctx, filter, opts...)
	if err != nil {
		return nil, err
	}
	out := []T{}
	return out, cur.All(ctx, &out)
}

func iso(t *time.Time) any {
	if t == nil {
		return nil
	}
	return httpx.ISO(*t)
}

// Filed is requireTeamPrincipal + assertAgentFiledHostel: a superadmin may open
// any hostel, an agent only one they filed; anything else is 404.
func Filed(db *mongo.Database, guards *authz.Guards) func(c *gin.Context) (*authz.Principal, bson.ObjectID, error) {
	return func(c *gin.Context) (*authz.Principal, bson.ObjectID, error) {
		p, err := guards.RequireTeam(c)
		if err != nil {
			return nil, bson.ObjectID{}, err
		}
		notFound := httpx.NewError(404, "NOT_FOUND", "Hostel was not found.", nil)
		id, err := bson.ObjectIDFromHex(c.Param("id"))
		if err != nil {
			return p, id, notFound
		}
		if p.Role == authz.Superadmin {
			return p, id, nil
		}
		agent, _ := bson.ObjectIDFromHex(p.UserID)
		n, err := db.Collection("hostelsubscriptions").CountDocuments(c, bson.D{{Key: "agentId", Value: agent}, {Key: "hostelId", Value: id}}, options.Count().SetLimit(1))
		if err != nil {
			return p, id, err
		}
		if n == 0 {
			return p, id, notFound
		}
		return p, id, nil
	}
}

func (h *Handler) collectionQR(c *gin.Context) {
	o := h.Config.OperationsTyped(c)
	httpx.OK(c, ordered.Map{{Key: "qr", Value: ordered.Map{{Key: "label", Value: o.CollectionQrLabel}, {Key: "url", Value: o.CollectionQrURL}}}}, "Collection QR loaded")
}

func (h *Handler) setupFee(c *gin.Context) {
	o := h.Config.OperationsTyped(c)
	httpx.OK(c, ordered.Map{{Key: "setupFee", Value: o.TeamSetupFee}, {Key: "trialDays", Value: o.TrialDays}}, "Setup fee loaded")
}

var exactEmail = func(addr string) *regexp.Regexp {
	return regexp.MustCompile(`(?i)^` + regexp.QuoteMeta(addr) + `$`)
}

// hostelUsing is findHostelUsingEmail: the hostel an address already belongs to.
func (h *Handler) hostelUsing(ctx context.Context, email string) (string, error) {
	addr := strings.ToLower(strings.TrimSpace(email))
	if addr == "" {
		return "", nil
	}
	var u struct {
		ID        bson.ObjectID   `bson:"_id"`
		HostelIDs []bson.ObjectID `bson:"hostelIds"`
		Role      string          `bson:"role"`
	}
	found := h.col("users").FindOne(ctx, bson.D{{Key: "email", Value: addr}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&u) == nil
	or := bson.A{bson.D{{Key: "contact.email", Value: bson.Regex{Pattern: exactEmail(addr).String()[4:], Options: "i"}}}}
	if found {
		or = append(or, bson.D{{Key: "ownerId", Value: u.ID}})
		if u.Role == "HOSTEL_ADMIN" || u.Role == "WARDEN" || u.Role == "COOK" {
			ids := u.HostelIDs
			if ids == nil {
				ids = []bson.ObjectID{}
			}
			or = append(or, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}})
		}
	}
	var hostel struct {
		Name *string `bson:"name"`
	}
	err := h.col("hostels").FindOne(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "$or", Value: or}}).Decode(&hostel)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if hostel.Name == nil {
		return "another hostel", nil
	}
	return *hostel.Name, nil
}

func (h *Handler) emailCheck(c *gin.Context) {
	addr := valid.Trim(c.Query("email"))
	var is valid.Issues
	if !strings.Contains(addr, "@") || strings.ContainsAny(addr, " ") {
		is.Add("email", "Invalid email address")
	} else if len(addr) > 254 {
		is.Add("email", valid.TooBig("string", 254, true))
	}
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	usedBy, err := h.hostelUsing(c, addr)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	status := "HOSTEL"
	if usedBy == "" {
		var u struct {
			Role string `bson:"role"`
		}
		err := h.col("users").FindOne(c, bson.D{{Key: "email", Value: strings.ToLower(addr)}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&u)
		switch {
		case errors.Is(err, mongo.ErrNoDocuments):
			status = "AVAILABLE"
		case err != nil:
			httpx.Fail(c, err)
			return
		case u.Role == "PUBLIC" || u.Role == "HOSTEL_ADMIN":
			status = "EXISTING_ACCOUNT"
		default:
			status = "OTHER_ROLE"
		}
	}
	var by any
	if usedBy != "" {
		by = usedBy
	}
	httpx.OK(c, ordered.Map{{Key: "available", Value: status == "AVAILABLE" || status == "EXISTING_ACCOUNT"}, {Key: "status", Value: status}, {Key: "usedBy", Value: by}}, "Email checked")
}

/* Filings and their money ---------------------------------------------------- */

type subscriptionRow struct {
	ID         bson.ObjectID  `bson:"_id"`
	AgentID    *bson.ObjectID `bson:"agentId"`
	CreatedAt  *time.Time     `bson:"createdAt"`
	CycleTotal *int64         `bson:"cycleTotal"`
	DueBy      *time.Time     `bson:"dueBy"`
	FreeUntil  *time.Time     `bson:"freeUntil"`
	HostelID   bson.ObjectID  `bson:"hostelId"`
	PlanName   *string        `bson:"planName"`
	Status     string         `bson:"status"`
}

type ledger struct {
	cash, online, outstanding, total int64
	setupFee                         any // {amount, collected} or nil
}

// ledgers is ledgerBySubscription: settled money by method, the setup fee, and
// what is still owed on open plan invoices.
func (h *Handler) ledgers(ctx context.Context, subs []subscriptionRow) (map[bson.ObjectID]*ledger, error) {
	out := map[bson.ObjectID]*ledger{}
	ids := bson.A{}
	for _, s := range subs {
		ids = append(ids, s.ID)
	}
	if len(ids) == 0 {
		return out, nil
	}
	get := func(id bson.ObjectID) *ledger {
		if out[id] == nil {
			out[id] = &ledger{}
		}
		return out[id]
	}
	cur, err := h.col("subscriptionpayments").Aggregate(ctx, mongo.Pipeline{
		{{Key: "$match", Value: bson.D{{Key: "status", Value: "SETTLED"}, {Key: "subscriptionId", Value: bson.D{{Key: "$in", Value: ids}}}}}},
		{{Key: "$group", Value: bson.D{{Key: "_id", Value: bson.D{{Key: "invoiceId", Value: "$invoiceId"}, {Key: "method", Value: "$method"}, {Key: "subscriptionId", Value: "$subscriptionId"}}},
			{Key: "total", Value: bson.D{{Key: "$sum", Value: "$amount"}}}}}},
	})
	if err != nil {
		return nil, err
	}
	var pays []struct {
		ID struct {
			InvoiceID      bson.ObjectID `bson:"invoiceId"`
			Method         string        `bson:"method"`
			SubscriptionID bson.ObjectID `bson:"subscriptionId"`
		} `bson:"_id"`
		Total int64 `bson:"total"`
	}
	if err := cur.All(ctx, &pays); err != nil {
		return nil, err
	}
	settled := map[bson.ObjectID]int64{}
	for _, p := range pays {
		l := get(p.ID.SubscriptionID)
		if p.ID.Method == "CASH" {
			l.cash += p.Total
		} else {
			l.online += p.Total
		}
		l.total += p.Total
		settled[p.ID.InvoiceID] += p.Total
	}
	invs, err := findAll[struct {
		ID             bson.ObjectID `bson:"_id"`
		Amount         int64         `bson:"amount"`
		Kind           *string       `bson:"kind"`
		Status         string        `bson:"status"`
		SubscriptionID bson.ObjectID `bson:"subscriptionId"`
	}](ctx, h.col("subscriptioninvoices"), bson.D{{Key: "subscriptionId", Value: bson.D{{Key: "$in", Value: ids}}}})
	if err != nil {
		return nil, err
	}
	for _, inv := range invs {
		l := get(inv.SubscriptionID)
		s := settled[inv.ID]
		if inv.Kind != nil && *inv.Kind == "SETUP_FEE" {
			l.setupFee = ordered.Map{{Key: "amount", Value: inv.Amount}, {Key: "collected", Value: s}}
		} else if inv.Status == "OPEN" || inv.Status == "PARTIAL" {
			l.outstanding += max(0, inv.Amount-s)
		}
	}
	return out, nil
}

type registration struct {
	hostelID, hostelName, status string
	registeredAt                 *time.Time
	paid, outstanding, price     int64
	setupFee                     any
	out                          ordered.Map
}

func str(p *string, def string) string {
	if p == nil {
		return def
	}
	return *p
}

// registrations is listAgentRegistrations.
func (h *Handler) registrations(ctx context.Context, agent bson.ObjectID, limit int64) ([]registration, error) {
	subs, err := findAll[subscriptionRow](ctx, h.col("hostelsubscriptions"), bson.D{{Key: "agentId", Value: agent}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(limit))
	if err != nil {
		return nil, err
	}
	ids := bson.A{}
	for _, s := range subs {
		ids = append(ids, s.HostelID)
	}
	type contact struct{ AlternatePhone, Email, Phone *string }
	type location struct{ Area, City *string }
	hostels, err := findAll[struct {
		ID       bson.ObjectID `bson:"_id"`
		Contact  *contact      `bson:"contact"`
		Location *location     `bson:"location"`
		Name     *string       `bson:"name"`
		Slug     *string       `bson:"slug"`
		Status   *string       `bson:"status"`
	}](ctx, h.col("hostels"), bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}})
	if err != nil {
		return nil, err
	}
	money, err := h.ledgers(ctx, subs)
	if err != nil {
		return nil, err
	}
	out := make([]registration, len(subs))
	for i, s := range subs {
		var area, city, email, phone, name, slug, status string
		name = "Unnamed hostel"
		for _, hs := range hostels {
			if hs.ID != s.HostelID {
				continue
			}
			if hs.Location != nil {
				area, city = str(hs.Location.Area, ""), str(hs.Location.City, "")
			}
			if hs.Contact != nil {
				email = str(hs.Contact.Email, "")
				phone = str(hs.Contact.Phone, str(hs.Contact.AlternatePhone, ""))
			}
			name, slug, status = str(hs.Name, "Unnamed hostel"), str(hs.Slug, ""), str(hs.Status, "")
		}
		l := money[s.ID]
		if l == nil {
			l = &ledger{}
		}
		var price int64
		if s.CycleTotal != nil {
			price = *s.CycleTotal
		}
		out[i] = registration{hostelID: s.HostelID.Hex(), hostelName: name, status: s.Status, registeredAt: s.CreatedAt, paid: l.total, outstanding: l.outstanding, price: price, setupFee: l.setupFee,
			out: ordered.Map{{Key: "area", Value: area}, {Key: "cashCollected", Value: l.cash}, {Key: "city", Value: city}, {Key: "dueBy", Value: iso(s.DueBy)}, {Key: "freeUntil", Value: iso(s.FreeUntil)},
				{Key: "hostelId", Value: s.HostelID.Hex()}, {Key: "hostelName", Value: name}, {Key: "hostelStatus", Value: status}, {Key: "onlineCollected", Value: l.online},
				{Key: "outstanding", Value: l.outstanding}, {Key: "ownerEmail", Value: email}, {Key: "ownerPhone", Value: phone}, {Key: "paid", Value: l.total},
				{Key: "planName", Value: str(s.PlanName, "")}, {Key: "price", Value: price}, {Key: "registeredAt", Value: iso(s.CreatedAt)}, {Key: "setupFee", Value: l.setupFee},
				{Key: "slug", Value: slug}, {Key: "subscriptionStatus", Value: s.Status}}}
		_ = l.cash
	}
	return out, nil
}

func agentOf(c *gin.Context) bson.ObjectID {
	id, _ := bson.ObjectIDFromHex(authz.From(c).UserID)
	return id
}

func (h *Handler) hostels(c *gin.Context) {
	regs, err := h.registrations(c, agentOf(c), 100)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]ordered.Map, len(regs))
	for i, r := range regs {
		out[i] = r.out
	}
	httpx.OK(c, ordered.Map{{Key: "registrations", Value: out}}, "Registrations loaded")
}

func (h *Handler) summary(c *gin.Context) {
	regs, err := h.registrations(c, agentOf(c), 500)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var cash, collected, outstanding, pastDue int64
	for _, r := range regs {
		v, _ := r.out.Get("cashCollected")
		cash += v.(int64)
		collected += r.paid
		outstanding += r.outstanding
		if r.status == "PAST_DUE" {
			pastDue++
		}
	}
	httpx.OK(c, ordered.Map{{Key: "summary", Value: ordered.Map{{Key: "cashCollected", Value: cash}, {Key: "collected", Value: collected}, {Key: "hostelsRegistered", Value: len(regs)},
		{Key: "outstanding", Value: outstanding}, {Key: "pastDue", Value: pastDue}}}}, "Summary loaded")
}

/* Wallets -------------------------------------------------------------------- */

// commissionFor is Math.round(base * rate) / 100.
func commissionFor(base int64, rate float64) float64 { return jsRound(float64(base)*rate) / 100 }

// jsRound is Math.round: halves go up, toward +∞.
func jsRound(v float64) float64 { return math.Floor(v + 0.5) }

func round2(v float64) float64 { return jsRound(v*100) / 100 }

type totals struct {
	earned, paidOut float64
	lastPayoutAt    *time.Time
}

func (h *Handler) totalsByAgent(ctx context.Context, agents bson.A) (map[bson.ObjectID]*totals, error) {
	pipe := mongo.Pipeline{{{Key: "$group", Value: bson.D{{Key: "_id", Value: bson.D{{Key: "agentId", Value: "$agentId"}, {Key: "type", Value: "$type"}}},
		{Key: "last", Value: bson.D{{Key: "$max", Value: "$createdAt"}}}, {Key: "total", Value: bson.D{{Key: "$sum", Value: "$amount"}}}}}}}
	if agents != nil {
		pipe = append(mongo.Pipeline{{{Key: "$match", Value: bson.D{{Key: "agentId", Value: bson.D{{Key: "$in", Value: agents}}}}}}}, pipe...)
	}
	cur, err := h.col("teamwalletentries").Aggregate(ctx, pipe)
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID struct {
			AgentID bson.ObjectID `bson:"agentId"`
			Type    string        `bson:"type"`
		} `bson:"_id"`
		Last  time.Time `bson:"last"`
		Total float64   `bson:"total"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := map[bson.ObjectID]*totals{}
	for _, r := range rows {
		t := out[r.ID.AgentID]
		if t == nil {
			t = &totals{}
			out[r.ID.AgentID] = t
		}
		if r.ID.Type == "COMMISSION" {
			t.earned += r.Total
		} else {
			last := r.Last
			t.paidOut, t.lastPayoutAt = t.paidOut+r.Total, &last
		}
	}
	return out, nil
}

type walletEntry struct {
	ID          bson.ObjectID  `bson:"_id"`
	Amount      float64        `bson:"amount"`
	CreatedAt   time.Time      `bson:"createdAt"`
	HostelID    *bson.ObjectID `bson:"hostelId"`
	Method      *string        `bson:"method"`
	RatePercent *float64       `bson:"ratePercent"`
	Reference   *string        `bson:"reference"`
	Type        string         `bson:"type"`
}

func (h *Handler) wallet(c *gin.Context) {
	agent := agentOf(c)
	ops := h.Config.OperationsTyped(c)
	rate := ops.TeamCommissionPercent
	since := bs.Today(h.Now()).Add(-(5*time.Hour + 45*time.Minute))
	regs, err := h.registrations(c, agent, 500)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	tot, err := h.totalsByAgent(c, bson.A{agent})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	t := tot[agent]
	if t == nil {
		t = &totals{}
	}
	entries, err := findAll[walletEntry](c, h.col("teamwalletentries"), bson.D{{Key: "agentId", Value: agent}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(20))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	credits, err := findAll[walletEntry](c, h.col("teamwalletentries"), bson.D{{Key: "agentId", Value: agent}, {Key: "type", Value: "COMMISSION"}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	credited := map[string]bool{}
	var todayCommission float64
	for _, cr := range credits {
		if cr.HostelID != nil {
			credited[cr.HostelID.Hex()] = true
		} else {
			credited["undefined"] = true
		}
		if !cr.CreatedAt.Before(since) {
			todayCommission += cr.Amount
		}
	}
	names := map[string]string{}
	var pending float64
	var todayHostels, todayDue, todayPaid int64
	for _, r := range regs {
		names[r.hostelID] = r.hostelName
		if !credited[r.hostelID] {
			base := r.price
			if m, ok := r.setupFee.(ordered.Map); ok {
				a, _ := m.Get("amount")
				base = a.(int64)
			}
			pending += commissionFor(base, rate)
		}
		if r.registeredAt != nil && !r.registeredAt.Before(since) {
			todayHostels++
			todayDue += r.outstanding
			todayPaid += r.paid
		}
	}
	list := make([]ordered.Map, len(entries))
	for i, e := range entries {
		name := ""
		if e.HostelID != nil {
			name = names[e.HostelID.Hex()]
		}
		var method, rate any
		if e.Method != nil {
			method = *e.Method
		}
		if e.RatePercent != nil {
			rate = *e.RatePercent
		}
		list[i] = ordered.Map{{Key: "amount", Value: e.Amount}, {Key: "at", Value: httpx.ISO(e.CreatedAt)}, {Key: "hostelName", Value: name}, {Key: "id", Value: e.ID.Hex()},
			{Key: "method", Value: method}, {Key: "ratePercent", Value: rate}, {Key: "reference", Value: str(e.Reference, "")}, {Key: "type", Value: e.Type}}
	}
	httpx.OK(c, ordered.Map{{Key: "wallet", Value: ordered.Map{{Key: "balance", Value: round2(t.earned - t.paidOut)}, {Key: "earned", Value: round2(t.earned)},
		{Key: "paidOut", Value: round2(t.paidOut)}, {Key: "pending", Value: round2(pending)}, {Key: "ratePercent", Value: rate},
		{Key: "today", Value: ordered.Map{{Key: "commission", Value: round2(todayCommission)}, {Key: "due", Value: todayDue}, {Key: "hostels", Value: todayHostels}, {Key: "paid", Value: todayPaid}}}}},
		{Key: "entries", Value: list}}, "Wallet loaded")
}

func (h *Handler) wallets(c *gin.Context) {
	ops := h.Config.OperationsTyped(c)
	members, err := findAll[struct {
		ID    bson.ObjectID `bson:"_id"`
		Email *string       `bson:"email"`
		Name  *string       `bson:"name"`
	}](c, h.col("users"), bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "role", Value: "PLATFORM_AGENT"}}, options.Find().SetSort(bson.D{{Key: "name", Value: 1}}))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	tot, err := h.totalsByAgent(c, nil)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]ordered.Map, len(members))
	for i, m := range members {
		t := tot[m.ID]
		if t == nil {
			t = &totals{}
		}
		out[i] = ordered.Map{{Key: "agentId", Value: m.ID.Hex()}, {Key: "balance", Value: round2(t.earned - t.paidOut)}, {Key: "earned", Value: round2(t.earned)},
			{Key: "email", Value: str(m.Email, "")}, {Key: "lastPayoutAt", Value: iso(t.lastPayoutAt)}, {Key: "name", Value: str(m.Name, "Unnamed")}, {Key: "paidOut", Value: round2(t.paidOut)}}
	}
	httpx.OK(c, ordered.Map{{Key: "ratePercent", Value: ops.TeamCommissionPercent}, {Key: "setupFee", Value: ops.TeamSetupFee}, {Key: "wallets", Value: out}}, "Wallets loaded")
}

// enIN is toLocaleString("en-IN") for a wallet balance (up to 3 decimals).
func enIN(v float64) string {
	s := strconv.FormatFloat(math.Abs(v), 'f', -1, 64)
	whole, frac, _ := strings.Cut(s, ".")
	if len(frac) > 3 {
		r := strconv.FormatFloat(jsRound(math.Abs(v)*1000)/1000, 'f', -1, 64)
		whole, frac, _ = strings.Cut(r, ".")
	}
	var b strings.Builder
	n := len(whole)
	for i, ch := range whole {
		if i > 0 && (n-i == 3 || (n-i > 3 && (n-i-3)%2 == 0)) {
			b.WriteByte(',')
		}
		b.WriteRune(ch)
	}
	out := b.String()
	if frac != "" {
		out += "." + frac
	}
	if v < 0 {
		out = "-" + out
	}
	return out
}

// payout is recordTeamPayout. The balance check and the entry run in one
// transaction that also writes the agent's row, so two payouts at once
// conflict instead of both passing the check (TS read, then inserted).
func (h *Handler) payout(c *gin.Context) {
	actor, _ := bson.ObjectIDFromHex(authz.From(c).UserID)
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	amount, _ := f.Num("amount", valid.N{Max: valid.P(10000000)})
	if v, ok := f.M["amount"].(float64); ok && v <= 0 {
		f.Is.Add("amount", valid.TooSmall("number", 0, false))
	}
	method, _ := f.Enum("method", false, nil, "CASH", "BANK", "ESEWA", "KHALTI", "OTHER")
	note, _ := f.Str("note", valid.S{Opt: true, Trim: true, Max: 300})
	ref, _ := f.Str("reference", valid.S{Opt: true, Trim: true, Max: 120})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	agent, err := bson.ObjectIDFromHex(c.Param("agentId"))
	if err != nil {
		httpx.Fail(c, httpx.NewError(404, "NOT_FOUND", "Team member was not found.", nil))
		return
	}
	now := h.Now().UTC().Truncate(time.Millisecond)
	amt := round2(amount)
	id := bson.NewObjectID()
	var balance float64
	err = appmongo.InTx(c, h.DB, func(ctx context.Context) error {
		if _, err := h.col("users").UpdateOne(ctx, bson.D{{Key: "_id", Value: agent}}, bson.D{{Key: "$inc", Value: bson.D{{Key: "walletVersion", Value: 1}}}}); err != nil {
			return err
		}
		tot, err := h.totalsByAgent(ctx, bson.A{agent})
		if err != nil {
			return err
		}
		balance = 0
		if t := tot[agent]; t != nil {
			balance = round2(t.earned - t.paidOut)
		}
		if amt > balance {
			return httpx.NewError(409, "PAYOUT_EXCEEDS_BALANCE", "Only Rs "+enIN(balance)+" is in this wallet.", nil)
		}
		doc := bson.D{{Key: "_id", Value: id}, {Key: "agentId", Value: agent}, {Key: "type", Value: "PAYOUT"}, {Key: "amount", Value: amt}, {Key: "method", Value: method}}
		if ref != "" {
			doc = append(doc, bson.E{Key: "reference", Value: ref})
		}
		if note != "" {
			doc = append(doc, bson.E{Key: "note", Value: note})
		}
		doc = append(doc, bson.E{Key: "createdBy", Value: actor}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
		_, err = h.col("teamwalletentries").InsertOne(ctx, doc)
		return err
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	_ = h.Audit.Write(c, audit.Entry{ActorID: actor, Action: "TEAM_COMMISSION_PAID_OUT", EntityType: "TeamWalletEntry", EntityID: id.Hex(),
		Metadata: bson.D{{Key: "agentId", Value: agent.Hex()}, {Key: "amount", Value: amt}, {Key: "method", Value: method}, {Key: "reference", Value: ref}}})
	httpx.Write(c, 201, ordered.Map{{Key: "balance", Value: round2(balance - amt)}}, "Payout recorded")

}

var _ = fmt.Sprintf
