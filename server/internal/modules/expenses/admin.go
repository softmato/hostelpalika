package expenses

import (
	"context"
	"errors"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/storage"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

const (
	categoryNameMax = 32
	categoryLimit   = 20
	dayMS           = 24 * time.Hour
)

// Admin is the hostel's side of the money-out book.
type Admin struct {
	*Handler
	Cache    *cache.Cache
	R2       *storage.R2
	Evidence *finance.Reader
}

func (a *Admin) Register(v1 *gin.RouterGroup) {
	g := v1.Group("/hostel-admin/expenses")
	g.GET("", a.home)
	g.POST("", a.create)
	g.POST("/:id/cash", a.cash)
	g.POST("/:id/void", a.voidOne)
	g.POST("/categories", a.addCategory)
	g.PATCH("/categories/:id", a.editCategory)
	g.PUT("/cook", a.cookSwitch)
	g.POST("/receipt/read", a.readReceipt)
	g.GET("/wallet", httpx.ETag(), a.wallet)
}

// Resolve is resolveExpenseActor for anyone: staff through their hostel scope, a cook
// through the owner's switch.
func (h *Handler) Resolve(ctx context.Context, p *authz.Principal, requested string) (*Actor, error) {
	switch p.Role {
	case authz.HostelAdmin, authz.Warden:
		id, err := opsscope.HostelID(p, requested)
		if err != nil {
			return nil, err
		}
		if p.Role == authz.HostelAdmin {
			return &Actor{id, p, "HOSTEL_ADMIN", true}, nil
		}
		return &Actor{id, p, "WARDEN", false}, nil
	case authz.Cook:
		return h.resolve(ctx, p, requested)
	}
	return nil, fail(403, "CAPABILITY_DENIED", "You cannot add expenses.")
}

// ProofRequired is isProofRequired.
func (h *Handler) ProofRequired(ctx context.Context, a *Actor) (bool, error) {
	switch a.role {
	case "HOSTEL_ADMIN":
		return false, nil
	case "COOK":
		return true, nil
	}
	me, err := httpx.OID(a.p.UserID, "user id")
	if err != nil {
		return false, err
	}
	n, err := h.DB.Collection("hostelmembers").CountDocuments(ctx, bson.D{{Key: "hostelId", Value: a.hostelID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "permissions", Value: "expenseWithoutProof"}, {Key: "status", Value: "ACTIVE"}, {Key: "userId", Value: me}}, options.Count().SetLimit(1))
	return n == 0, err
}

// wallet row is StaffWallet.
type walletOut struct {
	Given   int64  `json:"given"`
	Left    int64  `json:"left"`
	Pending int64  `json:"pending"`
	Spent   int64  `json:"spent"`
	Name    string `json:"name"`
	UserID  string `json:"userId"`
}

// ListWallets is listStaffWallets; user limits it to one warden.
func (h *Handler) ListWallets(ctx context.Context, hostel bson.ObjectID, people []person, user *bson.ObjectID) ([]walletOut, error) {
	coll := h.DB.Collection("expenses")
	handedMatch := bson.D{{Key: "category", Value: staffCash}, {Key: "cashStatus", Value: bson.D{{Key: "$in", Value: bson.A{"PENDING", "ACCEPTED"}}}}, {Key: "hostelId", Value: hostel}, {Key: "status", Value: "RECORDED"}}
	spentMatch := bson.D{{Key: "category", Value: bson.D{{Key: "$ne", Value: staffCash}}}, {Key: "hostelId", Value: hostel}, {Key: "payer", Value: "STAFF"}, {Key: "recordedByRole", Value: "WARDEN"}, {Key: "status", Value: "RECORDED"}}
	if user != nil {
		handedMatch = append(handedMatch, bson.E{Key: "cashTo.userId", Value: *user})
		spentMatch = append(spentMatch, bson.E{Key: "recordedBy", Value: *user})
	}
	cur, err := coll.Aggregate(ctx, bson.A{bson.D{{Key: "$match", Value: handedMatch}}, bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: bson.D{{Key: "status", Value: "$cashStatus"}, {Key: "user", Value: "$cashTo.userId"}}}, {Key: "name", Value: bson.D{{Key: "$last", Value: "$cashTo.name"}}}, {Key: "total", Value: bson.D{{Key: "$sum", Value: "$amount"}}}}}}})
	if err != nil {
		return nil, err
	}
	var handed []struct {
		ID struct {
			Status string        `bson:"status"`
			User   bson.ObjectID `bson:"user"`
		} `bson:"_id"`
		Name  string `bson:"name"`
		Total int64  `bson:"total"`
	}
	if err := cur.All(ctx, &handed); err != nil {
		return nil, err
	}
	cur, err = coll.Aggregate(ctx, bson.A{bson.D{{Key: "$match", Value: spentMatch}}, bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$recordedBy"}, {Key: "name", Value: bson.D{{Key: "$last", Value: "$recordedByName"}}}, {Key: "total", Value: bson.D{{Key: "$sum", Value: "$amount"}}}}}}})
	if err != nil {
		return nil, err
	}
	var spent []struct {
		ID    bson.ObjectID `bson:"_id"`
		Name  string        `bson:"name"`
		Total int64         `bson:"total"`
	}
	if err := cur.All(ctx, &spent); err != nil {
		return nil, err
	}
	boxes := map[string]*walletOut{}
	box := func(id, name string) *walletOut {
		if b, ok := boxes[id]; ok {
			return b
		}
		b := &walletOut{Name: name, UserID: id}
		boxes[id] = b
		return b
	}
	names := map[string]string{}
	for _, x := range people {
		names[x.UserID] = x.Name
		if x.HoldsCash && (user == nil || x.UserID == user.Hex()) {
			box(x.UserID, x.Name)
		}
	}
	for _, x := range handed {
		b := box(x.ID.User.Hex(), x.Name)
		if x.ID.Status == "ACCEPTED" {
			b.Given += x.Total
		} else {
			b.Pending += x.Total
		}
	}
	for _, x := range spent {
		name := x.Name
		if name == "" {
			name = "Warden"
		}
		box(x.ID.Hex(), name).Spent += x.Total
	}
	out := make([]walletOut, 0, len(boxes))
	for _, b := range boxes {
		b.Left = b.Given - b.Spent
		if n, ok := names[b.UserID]; ok {
			b.Name = n
		}
		out = append(out, *b)
	}
	sort.SliceStable(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out, nil
}

// moneyIn is moneyInForPeriod. Rows are read a day either side of the BS month, since a
// settlement near the boundary belongs to whichever Nepal day it fell on.
func (h *Handler) moneyIn(ctx context.Context, hostel bson.ObjectID, period string) (int64, error) {
	bounds, err := bs.PeriodBounds(period)
	if err != nil {
		return 0, err
	}
	cur, err := h.DB.Collection("paymentevents").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "settledAt", Value: bson.D{{Key: "$gte", Value: bounds.Start.Add(-dayMS)}, {Key: "$lte", Value: bounds.End.Add(dayMS)}}}, {Key: "status", Value: "SETTLED"}},
		options.Find().SetProjection(bson.D{{Key: "amount", Value: 1}, {Key: "direction", Value: 1}, {Key: "settledAt", Value: 1}}))
	if err != nil {
		return 0, err
	}
	var rows []struct {
		Amount    int64      `bson:"amount"`
		Direction string     `bson:"direction"`
		SettledAt *time.Time `bson:"settledAt"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return 0, err
	}
	var sum int64
	for _, x := range rows {
		if x.SettledAt == nil {
			continue
		}
		if p, err := bs.PeriodOf(*x.SettledAt); err != nil || p != period {
			continue
		}
		if x.Direction == "DEBIT" {
			sum -= x.Amount
		} else {
			sum += x.Amount
		}
	}
	return sum, nil
}

type categoryTotal struct {
	Amount           int64   `json:"amount"`
	Category         string  `json:"category"`
	CustomCategoryID *string `json:"customCategoryId"`
	Label            string  `json:"label"`
}

type totalsOut struct {
	ByCategory   []categoryTotal `json:"byCategory"`
	In           int64           `json:"in"`
	LastMonthOut int64           `json:"lastMonthOut"`
	Left         int64           `json:"left"`
	Out          int64           `json:"out"`
	StaffCount   int             `json:"staffCount"`
}

func (a *Admin) home(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "recordExpenses")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	if v, ok := q["hostelId"]; ok && !objectIDRe.MatchString(v) {
		is.Add("hostelId", "Invalid id.")
	}
	if v, ok := q["period"]; ok && !periodRe.MatchString(v) {
		is.Add("period", "Month must be YYYY-MM.")
	}
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := a.Resolve(c, p, q["hostelId"])
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	key := "expenses"
	if raw := c.Request.URL.RawQuery; raw != "" {
		key += "?" + raw
	}
	cache.Respond(c, a.Cache, p.HostelIDs, p.UserID, key, "Expenses loaded", func() (homeOut, error) {
		return a.Home(c, actor, q["period"])
	})
}

// Home is getExpenseHome.
func (h *Handler) Home(ctx context.Context, a *Actor, requested string) (homeOut, error) {
	now := time.Now()
	period, err := resolvePeriod(requested, now)
	if err != nil {
		return homeOut{}, err
	}
	bounds, err := bs.PeriodBounds(period)
	if err != nil {
		return homeOut{}, err
	}
	me, err := httpx.OID(a.p.UserID, "user id")
	if err != nil {
		return homeOut{}, err
	}
	newest := bson.D{{Key: "spentOn", Value: -1}, {Key: "createdAt", Value: -1}}
	scope := bson.D{{Key: "hostelId", Value: a.hostelID}, {Key: "spentOn", Value: bson.D{{Key: "$gte", Value: bounds.Start}, {Key: "$lte", Value: bounds.End}}}}
	pendingScope := bson.D{{Key: "category", Value: staffCash}, {Key: "cashStatus", Value: "PENDING"}, {Key: "hostelId", Value: a.hostelID}, {Key: "status", Value: "RECORDED"}}
	if !a.canSeeAll {
		scope = append(scope, bson.E{Key: "$or", Value: bson.A{bson.D{{Key: "recordedBy", Value: me}}, bson.D{{Key: "category", Value: staffCash}, {Key: "cashTo.userId", Value: me}}}})
		pendingScope = append(pendingScope, bson.E{Key: "cashTo.userId", Value: me})
	}
	coll := h.DB.Collection("expenses")
	cur, err := coll.Find(ctx, scope, options.Find().SetSort(newest).SetLimit(maxRows))
	if err != nil {
		return homeOut{}, err
	}
	var docs []doc
	if err := cur.All(ctx, &docs); err != nil {
		return homeOut{}, err
	}
	cur, err = coll.Find(ctx, pendingScope, options.Find().SetSort(newest).SetLimit(50))
	if err != nil {
		return homeOut{}, err
	}
	var pending []doc
	if err := cur.All(ctx, &pending); err != nil {
		return homeOut{}, err
	}
	all, err := h.categories(ctx, a.hostelID)
	if err != nil {
		return homeOut{}, err
	}
	people, err := h.people(ctx, a.hostelID)
	if err != nil {
		return homeOut{}, err
	}
	proof, err := h.ProofRequired(ctx, a)
	if err != nil {
		return homeOut{}, err
	}
	names := map[string]string{}
	shown := []category{}
	for _, x := range all {
		names[x.ID] = x.Name
		if a.canSeeAll || !x.Hidden {
			shown = append(shown, x)
		}
	}
	out := homeOut{CanSeeTotals: a.canSeeAll, Categories: shown, Expenses: make([]ordered.Map, len(docs)), PendingCash: make([]ordered.Map, len(pending)), People: people, Period: period, ProofRequired: proof, Role: a.role}
	out.CurrentPeriod, _ = bs.CurrentPeriod(now)
	var outSum int64
	staffCount := 0
	var byCategory []*categoryTotal
	index := map[string]*categoryTotal{}
	for i := range docs {
		d := &docs[i]
		out.Expenses[i] = serialize(d, a.p.UserID, names)
		if d.Status != "RECORDED" || d.Category == staffCash {
			continue
		}
		if d.By == me {
			out.Mine.Count++
			out.Mine.Out += d.Amount
		}
		outSum += d.Amount
		if d.ByRole != "HOSTEL_ADMIN" {
			staffCount++
		}
		key := d.Category
		var customID *string
		if d.Category == custom && d.CustomID != nil {
			hex := d.CustomID.Hex()
			customID = &hex
			key = "C:" + hex
		}
		e, ok := index[key]
		if !ok {
			e = &categoryTotal{Category: categoryValue(d.Category), CustomCategoryID: customID, Label: labelOf(d, names)}
			index[key] = e
			byCategory = append(byCategory, e)
		}
		e.Amount += d.Amount
	}
	for i := range pending {
		out.PendingCash[i] = serialize(&pending[i], a.p.UserID, names)
	}
	if a.canSeeAll || a.role == "WARDEN" {
		var limit *bson.ObjectID
		if !a.canSeeAll {
			limit = &me
		}
		wallets, err := h.ListWallets(ctx, a.hostelID, people, limit)
		if err != nil {
			return homeOut{}, err
		}
		if a.canSeeAll {
			out.Wallets = wallets
		} else if len(wallets) > 0 {
			out.Wallet = wallets[0]
		} else {
			out.Wallet = walletOut{UserID: a.p.UserID}
		}
	}
	if !a.canSeeAll {
		return out, nil
	}
	in, err := h.moneyIn(ctx, a.hostelID, period)
	if err != nil {
		return homeOut{}, err
	}
	var last int64
	if lastPeriod, err := bs.AddMonths(period, -1); err == nil {
		lastBounds, err := bs.PeriodBounds(lastPeriod)
		if err != nil {
			return homeOut{}, err
		}
		ac, err := coll.Aggregate(ctx, bson.A{bson.D{{Key: "$match", Value: bson.D{{Key: "category", Value: bson.D{{Key: "$ne", Value: staffCash}}}, {Key: "hostelId", Value: a.hostelID}, {Key: "spentOn", Value: bson.D{{Key: "$gte", Value: lastBounds.Start}, {Key: "$lte", Value: lastBounds.End}}}, {Key: "status", Value: "RECORDED"}}}},
			bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: nil}, {Key: "total", Value: bson.D{{Key: "$sum", Value: "$amount"}}}}}}})
		if err != nil {
			return homeOut{}, err
		}
		var rows []struct {
			Total int64 `bson:"total"`
		}
		if err := ac.All(ctx, &rows); err != nil {
			return homeOut{}, err
		}
		if len(rows) > 0 {
			last = rows[0].Total
		}
	}
	sort.SliceStable(byCategory, func(i, j int) bool { return byCategory[i].Amount > byCategory[j].Amount })
	totals := totalsOut{ByCategory: make([]categoryTotal, len(byCategory)), In: in, LastMonthOut: last, Left: in - outSum, Out: outSum, StaffCount: staffCount}
	for i, e := range byCategory {
		totals.ByCategory[i] = *e
	}
	out.Totals = totals
	return out, nil
}

func categoryValue(cat string) string {
	if cat == custom || isKey(cat) {
		return cat
	}
	return "OTHER"
}

func (a *Admin) create(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "recordExpenses")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, err := parse(body)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := a.Resolve(c, p, in.hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	a.answerCreate(c, actor, in)
}

// Void is voidExpense: an owner may cancel anyone's row, everybody else only their own.
func (h *Handler) Void(ctx context.Context, a *Actor, expenseID, reason string) (ordered.Map, error) {
	id, err := bson.ObjectIDFromHex(expenseID)
	if err != nil {
		return nil, fail(404, "EXPENSE_NOT_FOUND", notFoundMsg)
	}
	me, err := httpx.OID(a.p.UserID, "user id")
	if err != nil {
		return nil, err
	}
	coll := h.DB.Collection("expenses")
	filter := bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: a.hostelID}}
	if !a.canSeeAll {
		filter = append(filter, bson.E{Key: "recordedBy", Value: me})
	}
	var old doc
	err = coll.FindOne(ctx, filter).Decode(&old)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, fail(404, "EXPENSE_NOT_FOUND", notFoundMsg)
	}
	if err != nil {
		return nil, err
	}
	already := fail(409, "EXPENSE_ALREADY_VOID", "This expense is already cancelled.")
	if old.Status == "VOID" {
		return nil, already
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	var updated doc
	err = coll.FindOneAndUpdate(ctx, append(filter, bson.E{Key: "status", Value: "RECORDED"}),
		bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "VOID"}, {Key: "voidReason", Value: reason}, {Key: "voidedAt", Value: now}, {Key: "voidedBy", Value: me}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&updated)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, already
	}
	if err != nil {
		return nil, err
	}
	if err := h.Audit.WriteFinance(ctx, me, string(a.p.Role), audit.Finance{Action: "EXPENSE_VOIDED", AmountBefore: old.Amount, EntityID: old.ID.Hex(), EntityType: "Expense", HostelID: a.hostelID, Reason: reason, Source: "EXPENSE_VOID"}); err != nil {
		return nil, err
	}
	what := rupees(old.Amount)
	if old.What != "" {
		what += " — " + old.What
	}
	if old.By != me {
		h.notifyQuietly(ctx, a.hostelID, old.By.Hex(), "Expense cancelled", what+" was cancelled. "+reason, old.ID.Hex(), "EXPENSE_VOIDED")
	} else if a.role != "HOSTEL_ADMIN" {
		who := old.ByName
		if who == "" {
			who = "Staff"
		}
		h.notifyAdmins(ctx, a.hostelID, a.p.UserID, "Expense cancelled", who+" cancelled "+what+". "+reason, old.ID.Hex(), "STAFF_EXPENSE_VOIDED")
	}
	h.moneyMoved(ctx, a.hostelID)
	return h.one(ctx, &updated, a.p.UserID)
}

func (a *Admin) voidOne(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "recordExpenses")
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
	reason, _ := f.Str("reason", valid.S{Trim: true, Min: 3, Max: 300})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := a.Resolve(c, p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := a.Void(c, actor, c.Param("id"), reason)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Expense cancelled")
}

func (a *Admin) cash(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "recordExpenses")
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
	accept, _ := f.Bool("accept", false, nil)
	note, _ := f.Str("note", valid.S{Opt: true, Trim: true, Max: 300})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := a.Resolve(c, p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, idErr := bson.ObjectIDFromHex(c.Param("id"))
	if actor.role != "WARDEN" || idErr != nil {
		httpx.Fail(c, fail(404, "EXPENSE_NOT_FOUND", "Cash not found."))
		return
	}
	me, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	status := "DECLINED"
	set := bson.D{}
	if accept {
		status = "ACCEPTED"
	} else {
		if note == "" {
			note = "Not received"
		}
		set = append(set, bson.E{Key: "cashNote", Value: note})
	}
	set = append(set, bson.E{Key: "cashRespondedAt", Value: now}, bson.E{Key: "cashStatus", Value: status}, bson.E{Key: "updatedAt", Value: now})
	var row doc
	err = a.DB.Collection("expenses").FindOneAndUpdate(c, bson.D{{Key: "category", Value: staffCash}, {Key: "cashStatus", Value: "PENDING"}, {Key: "hostelId", Value: actor.hostelID}, {Key: "status", Value: "RECORDED"}, {Key: "cashTo.userId", Value: me}, {Key: "_id", Value: id}},
		bson.D{{Key: "$set", Value: set}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, fail(409, "CASH_NOT_PENDING", "This cash was already answered, or is not yours."))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	entry := audit.Finance{Action: "STAFF_CASH_DECLINED", EntityID: row.ID.Hex(), EntityType: "Expense", HostelID: actor.hostelID, Reason: note, Source: "STAFF_CASH"}
	if accept {
		entry.Action, entry.AmountAfter, entry.Reason = "STAFF_CASH_ACCEPTED", row.Amount, ""
	}
	if err := a.Audit.WriteFinance(c, me, string(p.Role), entry); err != nil {
		httpx.Fail(c, err)
		return
	}
	name := "The warden"
	if row.CashTo != nil && row.CashTo.Name != "" {
		name = row.CashTo.Name
	}
	if accept {
		a.notifyQuietly(c, actor.hostelID, row.By.Hex(), "Cash received", name+" got "+rupees(row.Amount)+".", row.ID.Hex(), "STAFF_CASH_ACCEPTED")
	} else {
		a.notifyQuietly(c, actor.hostelID, row.By.Hex(), "Cash not received", name+" says "+rupees(row.Amount)+" did not reach them.", row.ID.Hex(), "STAFF_CASH_DECLINED")
	}
	a.moneyMoved(c, actor.hostelID)
	out, err := a.one(c, &row, p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	message := "Marked not received"
	if accept {
		message = "Cash received"
	}
	httpx.OK(c, out, message)
}

type walletAnswer struct {
	Rows      []ordered.Map `json:"rows"`
	Truncated bool          `json:"truncated"`
	Wallet    walletOut     `json:"wallet"`
}

func (a *Admin) wallet(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "recordExpenses")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	for _, key := range []string{"hostelId", "userId"} {
		if v, ok := q[key]; ok && !objectIDRe.MatchString(v) {
			is.Add(key, "Invalid id.")
		}
	}
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := a.Resolve(c, p, q["hostelId"])
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if actor.role == "COOK" || (actor.canSeeAll && q["userId"] == "") {
		httpx.Fail(c, fail(422, "WALLET_USER_REQUIRED", "Pick a warden."))
		return
	}
	raw := p.UserID
	if actor.canSeeAll {
		raw = q["userId"]
	}
	user, err := httpx.OID(raw, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	people, err := a.people(c, actor.hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cats, err := a.categories(c, actor.hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err := a.DB.Collection("expenses").Find(c, bson.D{{Key: "$or", Value: bson.A{bson.D{{Key: "category", Value: staffCash}, {Key: "cashTo.userId", Value: user}},
		bson.D{{Key: "category", Value: bson.D{{Key: "$ne", Value: staffCash}}}, {Key: "payer", Value: "STAFF"}, {Key: "recordedBy", Value: user}, {Key: "recordedByRole", Value: "WARDEN"}}}}, {Key: "hostelId", Value: actor.hostelID}},
		options.Find().SetSort(bson.D{{Key: "spentOn", Value: -1}, {Key: "createdAt", Value: -1}}).SetLimit(maxRows))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var docs []doc
	if err := cur.All(c, &docs); err != nil {
		httpx.Fail(c, err)
		return
	}
	wallets, err := a.ListWallets(c, actor.hostelID, people, &user)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if len(wallets) == 0 && len(docs) == 0 {
		httpx.Fail(c, fail(404, "WALLET_NOT_FOUND", "This warden has no cash box here."))
		return
	}
	names := map[string]string{}
	for _, x := range cats {
		names[x.ID] = x.Name
	}
	out := walletAnswer{Rows: make([]ordered.Map, len(docs)), Truncated: len(docs) >= maxRows}
	for i := range docs {
		out.Rows[i] = serialize(&docs[i], p.UserID, names)
	}
	if len(wallets) > 0 {
		out.Wallet = wallets[0]
	} else {
		out.Wallet = walletOut{UserID: user.Hex()}
		if docs[0].CashTo != nil {
			out.Wallet.Name = docs[0].CashTo.Name
		}
	}
	httpx.Write(c, 200, out, "Cash box loaded")
}

func (a *Admin) nameFree(ctx context.Context, hostel bson.ObjectID, name string, except *bson.ObjectID) error {
	for _, label := range labels {
		if strings.EqualFold(label, name) {
			return fail(409, "CATEGORY_EXISTS", "You already have a category with this name.")
		}
	}
	filter := bson.D{{Key: "hostelId", Value: hostel}, {Key: "name", Value: bson.Regex{Pattern: "^" + regexp.QuoteMeta(name) + "$", Options: "i"}}}
	if except != nil {
		filter = append(filter, bson.E{Key: "_id", Value: bson.D{{Key: "$ne", Value: *except}}})
	}
	n, err := a.DB.Collection("hostelexpensecategories").CountDocuments(ctx, filter, options.Count().SetLimit(1))
	if err != nil {
		return err
	}
	if n > 0 {
		return fail(409, "CATEGORY_EXISTS", "You already have a category with this name.")
	}
	return nil
}

func (a *Admin) addCategory(c *gin.Context) {
	p, err := a.Guards.RequireHostelAdmin(c)
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
	hostel := ""
	if v, ok := f.M["hostelId"]; ok {
		s, _ := v.(string)
		if !objectIDRe.MatchString(s) {
			f.Is.Add("hostelId", "Invalid id.")
		}
		hostel = s
	}
	name, _ := f.Str("name", valid.S{Trim: true, Min: 2, Max: categoryNameMax})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := a.Resolve(c, p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.nameFree(c, actor.hostelID, name, nil); err != nil {
		httpx.Fail(c, err)
		return
	}
	coll := a.DB.Collection("hostelexpensecategories")
	count, err := coll.CountDocuments(c, bson.D{{Key: "hostelId", Value: actor.hostelID}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if count >= categoryLimit {
		httpx.Fail(c, fail(409, "CATEGORY_LIMIT", "You can add up to "+strconv.Itoa(categoryLimit)+" categories. Hide one you do not use."))
		return
	}
	me, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id := bson.NewObjectID()
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := coll.InsertOne(c, bson.D{{Key: "_id", Value: id}, {Key: "createdBy", Value: me}, {Key: "hostelId", Value: actor.hostelID}, {Key: "name", Value: name}, {Key: "hidden", Value: false}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, 201, category{false, id.Hex(), name}, "Category added")
}

func (a *Admin) editCategory(c *gin.Context) {
	p, err := a.Guards.RequireHostelAdmin(c)
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
	hidden, hasHidden := f.Bool("hidden", true, nil)
	name, hasName := f.Str("name", valid.S{Opt: true, Trim: true, Min: 2, Max: categoryNameMax})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	if !hasHidden && !hasName {
		f.Is.Add("", "Nothing to change.")
		httpx.Fail(c, f.Err())
		return
	}
	actor, err := a.Resolve(c, p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		httpx.Fail(c, fail(404, "CATEGORY_NOT_FOUND", "Category not found."))
		return
	}
	if hasName {
		if err := a.nameFree(c, actor.hostelID, name, &id); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	set := bson.D{{Key: "updatedAt", Value: time.Now().UTC().Truncate(time.Millisecond)}}
	if hasHidden {
		set = append(set, bson.E{Key: "hidden", Value: hidden})
	}
	if hasName {
		set = append(set, bson.E{Key: "name", Value: name})
	}
	var row struct {
		ID     bson.ObjectID `bson:"_id"`
		Hidden bool          `bson:"hidden"`
		Name   string        `bson:"name"`
	}
	err = a.DB.Collection("hostelexpensecategories").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: actor.hostelID}}, bson.D{{Key: "$set", Value: set}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, fail(404, "CATEGORY_NOT_FOUND", "Category not found."))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, category{row.Hidden, row.ID.Hex(), row.Name}, "Category saved")
}

func (a *Admin) cookSwitch(c *gin.Context) {
	p, err := a.Guards.RequireHostelAdmin(c)
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
	hostel := ""
	if v, ok := f.M["hostelId"]; ok {
		s, _ := v.(string)
		if !objectIDRe.MatchString(s) {
			f.Is.Add("hostelId", "Invalid id.")
		}
		hostel = s
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := a.Resolve(c, p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	me, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := a.DB.Collection("hostelsettings").UpdateOne(c, bson.D{{Key: "hostelId", Value: actor.hostelID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "cookCanRecordExpenses", Value: enabled}, {Key: "updatedBy", Value: me}, {Key: "updatedAt", Value: now}}},
		{Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}}, options.UpdateOne().SetUpsert(true)); err != nil {
		httpx.Fail(c, err)
		return
	}
	message := "The cook can no longer add expenses"
	if enabled {
		message = "The cook can add expenses"
	}
	httpx.OK(c, ordered.Map{{Key: "expensesEnabled", Value: enabled}}, message)
}

var (
	badOutcome = regexp.MustCompile(`(?i)\b(failed|pending|cancelled|canceled|reversed|refunded|unsuccessful)\b`)
	goodWord   = regexp.MustCompile(`(?i)\b(successful|success|completed|paid|transferred)\b`)
	spaces     = regexp.MustCompile(`\s+`)
)

const whatFallback = "Shared payment receipt"

func (a *Admin) readReceipt(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "recordExpenses")
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
	assetID, _ := f.Str("assetId", valid.S{Re: objectIDRe, ReSrc: "/^[a-f\\d]{24}$/i"})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := a.Resolve(c, p, "")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	ph, err := a.usablePhoto(c, actor, assetID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var asset struct {
		Bucket string `bson:"bucket"`
		Key    string `bson:"key"`
		Mime   string `bson:"mimeType"`
	}
	if err := a.DB.Collection("fileassets").FindOne(c, bson.D{{Key: "_id", Value: ph.id}}).Decode(&asset); err != nil {
		httpx.Fail(c, fail(404, "NOT_FOUND", "File not found"))
		return
	}
	var bytes []byte
	if a.R2 != nil {
		bytes = a.R2.ReadStoredObject(c, asset.Bucket, asset.Key)
	}
	if bytes == nil {
		httpx.Fail(c, fail(503, "READ_UNAVAILABLE", "Receipt could not be opened. Try again."))
		return
	}
	text, _ := a.Evidence.Read(c, bytes, asset.Mime)
	fields := finance.ExtractClaimFields(text)
	receipt := finance.ParseReceipt(text)
	remarks := finance.ReceiptRemarks(text, receipt)
	direction := finance.ReadDirection(text)
	description := receipt.Payee
	if remarks != "" {
		if description != "" {
			description += " · "
		}
		description += remarks
	}
	if utf8.RuneCountInString(description) > whatMax {
		description = string([]rune(description)[:whatMax])
	}
	if description == "" {
		description = whatFallback
	}
	eligible := !badOutcome.MatchString(text) && goodWord.MatchString(text) && !direction.IsLedgerView && direction.Direction == "DEBIT" && direction.Outcome == "SUCCESS" && receipt.Shape == "RECEIPT" &&
		receipt.TxnID != "" && receipt.Payee != "" && fields.Amount != nil && fields.Method != "" && receipt.Amount != nil && *receipt.Amount == *fields.Amount
	txn := strings.ToUpper(spaces.ReplaceAllString(receipt.TxnID, ""))
	if len(txn) < 6 {
		txn = ""
	}
	var txnOut, catOut, bankOut any
	if txn != "" {
		txnOut = txn
		if _, err := a.DB.Collection("fileassets").UpdateOne(c, bson.D{{Key: "_id", Value: ph.id}}, bson.D{{Key: "$set", Value: bson.D{{Key: "receiptTxnId", Value: txn}}}}); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	if cat := finance.ReceiptCategory(text, receipt.Payee, remarks); cat != "" {
		catOut = cat
	}
	if key, name := finance.ReceiptBank(text); key != "" {
		bankOut = ordered.Map{{Key: "key", Value: key}, {Key: "name", Value: name}}
	}
	fieldsOut := ordered.Map{}
	if fields.Amount != nil {
		fieldsOut = append(fieldsOut, ordered.Pair{Key: "amount", Value: *fields.Amount})
	}
	if fields.Method != "" {
		fieldsOut = append(fieldsOut, ordered.Pair{Key: "method", Value: fields.Method})
	}
	if fields.ReferenceCode != "" {
		fieldsOut = append(fieldsOut, ordered.Pair{Key: "referenceCode", Value: fields.ReferenceCode})
	}
	if fields.TransactionCode != "" {
		fieldsOut = append(fieldsOut, ordered.Pair{Key: "transactionCode", Value: fields.TransactionCode})
	}
	group, err := a.receiptGroup(c, actor.hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	saved, err := a.savedFacts(c, actor, group, ph.hash, txn)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := a.receiptHostel(c, actor.hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "fields", Value: fieldsOut}, {Key: "description", Value: description}, {Key: "autoSaveEligible", Value: eligible && saved == nil}, {Key: "category", Value: catOut}, {Key: "bank", Value: bankOut}, {Key: "txnId", Value: txnOut}, {Key: "alreadySaved", Value: saved}, {Key: "hostel", Value: hostel}}, "Receipt read")
}

// savedFacts is findSavedReceipt as an answer, nil when the receipt is new.
func (h *Handler) savedFacts(ctx context.Context, a *Actor, group bson.ObjectID, hash, txn string) (any, error) {
	match := bson.A{}
	if hash != "" {
		match = append(match, bson.D{{Key: "receiptHash", Value: hash}})
	}
	if txn != "" {
		match = append(match, bson.D{{Key: "receiptTxnId", Value: txn}})
	}
	if len(match) == 0 {
		return nil, nil
	}
	var saved struct {
		Amount   int64         `bson:"amount"`
		HostelID bson.ObjectID `bson:"hostelId"`
		By       string        `bson:"recordedByName"`
		What     string        `bson:"what"`
	}
	err := h.DB.Collection("expenses").FindOne(ctx, bson.D{{Key: "receiptGroupId", Value: group}, {Key: "status", Value: "RECORDED"}, {Key: "$or", Value: match}}).Decode(&saved)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var where any
	if saved.HostelID != a.hostelID {
		var row struct {
			Name *string `bson:"name"`
		}
		if err := h.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: saved.HostelID}}).Decode(&row); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
			return nil, err
		}
		if row.Name != nil {
			where = *row.Name
		}
	}
	return ordered.Map{{Key: "amount", Value: saved.Amount}, {Key: "by", Value: saved.By}, {Key: "what", Value: saved.What}, {Key: "where", Value: where}}, nil
}

func (h *Handler) receiptHostel(ctx context.Context, hostel bson.ObjectID) (any, error) {
	var row struct {
		Name     string         `bson:"name"`
		Parent   *bson.ObjectID `bson:"parentHostelId"`
		Location struct {
			Area string `bson:"area"`
		} `bson:"location"`
	}
	err := h.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}}).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var kind any
	if row.Parent != nil {
		kind = "Branch"
	} else {
		n, err := h.DB.Collection("hostels").CountDocuments(ctx, bson.D{{Key: "parentHostelId", Value: hostel}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}, options.Count().SetLimit(1))
		if err != nil {
			return nil, err
		}
		if n > 0 {
			kind = "Main hostel"
		}
	}
	return ordered.Map{{Key: "area", Value: row.Location.Area}, {Key: "kind", Value: kind}, {Key: "name", Value: row.Name}}, nil
}

// ActorFor is the ExpenseActor stock builds for hostel staff.
func (h *Handler) ActorFor(p *authz.Principal, hostel bson.ObjectID, owner bool) *Actor {
	if owner {
		return &Actor{hostel, p, "HOSTEL_ADMIN", true}
	}
	return &Actor{hostel, p, "WARDEN", false}
}

// NewInput is an expense stock writes on someone's behalf.
func NewInput(amount int64, category, request, paidBy, photo, spentOn, what string) *Input {
	return &Input{amount: amount, category: category, clientRequest: request, paidBy: paidBy, photoAssetID: photo, spentOn: spentOn, what: what}
}
