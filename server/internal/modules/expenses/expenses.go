// Package expenses is modules/finance/expenses for the kitchen: a cook's month,
// adding a bill and cancelling it. The owner and warden sides land with Phase 6.
package expenses

import (
	"context"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

type Handler struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Notify *notifications.Service
	Audit  *audit.Log
	RT     *realtime.Client
	Bump   realtime.Bumper
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.GET("/cook/expenses", httpx.ETag(), h.home)
	v1.POST("/cook/expenses", h.create)
	v1.POST("/cook/expenses/:id/void", h.void)
}

const (
	staffCash   = "STAFF_CASH"
	custom      = "CUSTOM"
	amountMax   = 100_000_000
	whatMax     = 120
	oldestDays  = 400
	maxRows     = 2000
	notFoundMsg = "Expense not found."
)

var (
	categoryKeys = []string{"GROCERIES", "VEGETABLES_MEAT", "GAS", "ELECTRICITY", "WATER", "INTERNET", "SALARY", staffCash, "RENT", "REPAIR", "CLEANING", "OTHER"}
	labels       = map[string]string{"CLEANING": "Cleaning", "ELECTRICITY": "Electricity", "GAS": "Gas", "GROCERIES": "Groceries", "INTERNET": "Internet", "OTHER": "Other", "RENT": "Building rent",
		"REPAIR": "Repair", "SALARY": "Salary", staffCash: "Cash to warden", "VEGETABLES_MEAT": "Vegetables & meat", "WATER": "Water"}
	objectIDRe = regexp.MustCompile(`(?i)^[a-f\d]{24}$`)
	periodRe   = regexp.MustCompile(`^\d{4}-(0[1-9]|1[0-2])$`)
	dayRe      = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

func fail(status int, code, message string) error { return httpx.NewError(status, code, message, nil) }

type actor struct {
	hostelID bson.ObjectID
	p        *authz.Principal
}

// resolve is resolveExpenseActor for a cook.
func (h *Handler) resolve(ctx context.Context, p *authz.Principal, requested string) (*actor, error) {
	id := requested
	if id == "" && len(p.HostelIDs) > 0 {
		id = p.HostelIDs[0]
	}
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return nil, fail(422, "HOSTEL_SCOPE_REQUIRED", "This cook account is not linked to a hostel.")
	}
	if err := authz.AssertHostelScoped(p, id); err != nil {
		return nil, err
	}
	var s struct {
		On bool `bson:"cookCanRecordExpenses"`
	}
	err = h.DB.Collection("hostelsettings").FindOne(ctx, bson.D{{Key: "hostelId", Value: oid}}).Decode(&s)
	if err != nil && err != mongo.ErrNoDocuments {
		return nil, err
	}
	if !s.On {
		return nil, fail(403, "EXPENSES_OFF_FOR_COOK", "The owner has not turned on expenses for the cook.")
	}
	return &actor{oid, p}, nil
}

func (h *Handler) cook(c *gin.Context) (*authz.Principal, error) {
	p, err := h.Guards.Require(c)
	if err != nil {
		return nil, err
	}
	if err := authz.AssertRoles(p, authz.Cook); err != nil {
		return nil, err
	}
	return p, nil
}

type doc struct {
	ID        bson.ObjectID `bson:"_id"`
	Amount    int64         `bson:"amount"`
	CashNote  *string       `bson:"cashNote"`
	CashAt    *time.Time    `bson:"cashRespondedAt"`
	CashState *string       `bson:"cashStatus"`
	CashTo    *struct {
		Name   string        `bson:"name"`
		UserID bson.ObjectID `bson:"userId"`
	} `bson:"cashTo"`
	Category  string         `bson:"category"`
	CreatedAt *time.Time     `bson:"createdAt"`
	CustomID  *bson.ObjectID `bson:"customCategoryId"`
	HostelID  bson.ObjectID  `bson:"hostelId"`
	PaidBy    string         `bson:"paidBy"`
	Payer     string         `bson:"payer"`
	Photo     *bson.ObjectID `bson:"photoAssetId"`
	By        bson.ObjectID  `bson:"recordedBy"`
	ByName    string         `bson:"recordedByName"`
	ByRole    string         `bson:"recordedByRole"`
	Salary    *struct {
		Name   string         `bson:"name"`
		UserID *bson.ObjectID `bson:"userId"`
	} `bson:"salaryFor"`
	SpentOn    time.Time  `bson:"spentOn"`
	Status     string     `bson:"status"`
	VoidReason *string    `bson:"voidReason"`
	VoidedAt   *time.Time `bson:"voidedAt"`
	What       string     `bson:"what"`
}

func isoPtr(t *time.Time) any {
	if t == nil {
		return nil
	}
	return httpx.ISO(*t)
}

func strPtr(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

func hexPtr(id *bson.ObjectID) any {
	if id == nil {
		return nil
	}
	return id.Hex()
}

func isKey(s string) bool {
	_, ok := labels[s]
	return ok
}

func labelOf(d *doc, names map[string]string) string {
	if d.Category == custom && d.CustomID != nil {
		if n, ok := names[d.CustomID.Hex()]; ok {
			return n
		}
	}
	if isKey(d.Category) {
		return labels[d.Category]
	}
	return labels["OTHER"]
}

// serialize is serializeExpense.
func serialize(d *doc, asker string, names map[string]string) ordered.Map {
	category := d.Category
	if category != custom && !isKey(category) {
		category = "OTHER"
	}
	var cashTo, salary any
	if d.CashTo != nil {
		cashTo = ordered.Map{{Key: "name", Value: d.CashTo.Name}, {Key: "userId", Value: d.CashTo.UserID.Hex()}}
	}
	if d.Salary != nil {
		salary = ordered.Map{{Key: "name", Value: d.Salary.Name}, {Key: "userId", Value: hexPtr(d.Salary.UserID)}}
	}
	name := d.ByName
	if name == "" {
		name = "Staff"
	}
	return ordered.Map{{Key: "amount", Value: d.Amount}, {Key: "cashNote", Value: strPtr(d.CashNote)}, {Key: "cashRespondedAt", Value: isoPtr(d.CashAt)}, {Key: "cashStatus", Value: strPtr(d.CashState)}, {Key: "cashTo", Value: cashTo},
		{Key: "category", Value: category}, {Key: "categoryLabel", Value: labelOf(d, names)}, {Key: "createdAt", Value: isoPtr(d.CreatedAt)}, {Key: "customCategoryId", Value: hexPtr(d.CustomID)}, {Key: "id", Value: d.ID.Hex()},
		{Key: "mine", Value: d.By.Hex() == asker}, {Key: "paidBy", Value: d.PaidBy}, {Key: "payer", Value: d.Payer}, {Key: "photoAssetId", Value: hexPtr(d.Photo)},
		{Key: "recordedBy", Value: ordered.Map{{Key: "id", Value: d.By.Hex()}, {Key: "name", Value: name}, {Key: "role", Value: d.ByRole}}}, {Key: "salaryFor", Value: salary},
		{Key: "spentOn", Value: d.SpentOn.UTC().Format("2006-01-02")}, {Key: "status", Value: d.Status}, {Key: "voidReason", Value: strPtr(d.VoidReason)}, {Key: "voidedAt", Value: isoPtr(d.VoidedAt)}, {Key: "what", Value: d.What}}
}

type category struct {
	Hidden bool   `json:"hidden"`
	ID     string `json:"id"`
	Name   string `json:"name"`
}

func (h *Handler) categories(ctx context.Context, hostel bson.ObjectID) ([]category, error) {
	cur, err := h.DB.Collection("hostelexpensecategories").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}}, options.Find().SetSort(bson.D{{Key: "name", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID     bson.ObjectID `bson:"_id"`
		Hidden bool          `bson:"hidden"`
		Name   string        `bson:"name"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := make([]category, len(rows))
	for i, r := range rows {
		out[i] = category{r.Hidden, r.ID.Hex(), r.Name}
	}
	return out, nil
}

type person struct {
	HoldsCash bool   `json:"holdsCash"`
	Name      string `json:"name"`
	Role      string `json:"role"`
	UserID    string `json:"userId"`
}

// people is loadPeople.
func (h *Handler) people(ctx context.Context, hostel bson.ObjectID) ([]person, error) {
	cur, err := h.DB.Collection("hostelmembers").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "role", Value: "WARDEN"}, {Key: "status", Value: "ACTIVE"}})
	if err != nil {
		return nil, err
	}
	var members []struct {
		Permissions []string      `bson:"permissions"`
		UserID      bson.ObjectID `bson:"userId"`
	}
	if err := cur.All(ctx, &members); err != nil {
		return nil, err
	}
	out := []person{}
	if len(members) > 0 {
		ids := bson.A{}
		spends := map[string]bool{}
		for _, m := range members {
			ids = append(ids, m.UserID)
			for _, perm := range m.Permissions {
				if perm == "recordExpenses" {
					spends[m.UserID.Hex()] = true
				}
			}
		}
		cur, err := h.DB.Collection("users").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}})
		if err != nil {
			return nil, err
		}
		var users []struct {
			ID   bson.ObjectID `bson:"_id"`
			Name string        `bson:"name"`
		}
		if err := cur.All(ctx, &users); err != nil {
			return nil, err
		}
		for _, u := range users {
			out = append(out, person{spends[u.ID.Hex()], u.Name, "WARDEN", u.ID.Hex()})
		}
	}
	cur, err = h.DB.Collection("cookaccounts").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "status", Value: "ACTIVE"}, {Key: "userId", Value: bson.D{{Key: "$ne", Value: nil}}}})
	if err != nil {
		return nil, err
	}
	var cooks []struct {
		Name   string         `bson:"name"`
		UserID *bson.ObjectID `bson:"userId"`
	}
	if err := cur.All(ctx, &cooks); err != nil {
		return nil, err
	}
	for _, x := range cooks {
		if x.UserID != nil {
			out = append(out, person{false, x.Name, "COOK", x.UserID.Hex()})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out, nil
}

// resolvePeriod is the service's resolvePeriod.
func resolvePeriod(requested string, now time.Time) (string, error) {
	current, err := bs.CurrentPeriod(now)
	if err != nil {
		return "", err
	}
	if requested == "" {
		return current, nil
	}
	if !bs.IsBsPeriod(requested) {
		return "", fail(422, "INVALID_PERIOD", "Pick a month to show.")
	}
	if requested > current {
		return current, nil
	}
	if _, err := bs.PeriodBounds(requested); err != nil {
		return "", fail(422, "INVALID_PERIOD", "There is nothing that far back.")
	}
	return requested, nil
}

type mineOut struct {
	Count int   `json:"count"`
	Out   int64 `json:"out"`
}

type homeOut struct {
	CanSeeTotals  bool          `json:"canSeeTotals"`
	Categories    []category    `json:"categories"`
	CurrentPeriod string        `json:"currentPeriod"`
	Expenses      []ordered.Map `json:"expenses"`
	Mine          mineOut       `json:"mine"`
	PendingCash   []ordered.Map `json:"pendingCash"`
	People        []person      `json:"people"`
	Period        string        `json:"period"`
	ProofRequired bool          `json:"proofRequired"`
	Role          string        `json:"role"`
	Totals        any           `json:"totals"`
	Wallet        any           `json:"wallet"`
	Wallets       any           `json:"wallets"`
}

func (h *Handler) home(c *gin.Context) {
	p, err := h.cook(c)
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
	a, err := h.resolve(c, p, q["hostelId"])
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now()
	period, err := resolvePeriod(q["period"], now)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	bounds, err := bs.PeriodBounds(period)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	me, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	newest := bson.D{{Key: "spentOn", Value: -1}, {Key: "createdAt", Value: -1}}
	coll := h.DB.Collection("expenses")
	cur, err := coll.Find(c, bson.D{{Key: "hostelId", Value: a.hostelID}, {Key: "spentOn", Value: bson.D{{Key: "$gte", Value: bounds.Start}, {Key: "$lte", Value: bounds.End}}},
		{Key: "$or", Value: bson.A{bson.D{{Key: "recordedBy", Value: me}}, bson.D{{Key: "category", Value: staffCash}, {Key: "cashTo.userId", Value: me}}}}},
		options.Find().SetSort(newest).SetLimit(maxRows))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var docs []doc
	if err := cur.All(c, &docs); err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err = coll.Find(c, bson.D{{Key: "category", Value: staffCash}, {Key: "cashStatus", Value: "PENDING"}, {Key: "hostelId", Value: a.hostelID}, {Key: "status", Value: "RECORDED"}, {Key: "cashTo.userId", Value: me}},
		options.Find().SetSort(newest).SetLimit(50))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var pending []doc
	if err := cur.All(c, &pending); err != nil {
		httpx.Fail(c, err)
		return
	}
	all, err := h.categories(c, a.hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	people, err := h.people(c, a.hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	names := map[string]string{}
	visible := []category{}
	for _, x := range all {
		names[x.ID] = x.Name
		if !x.Hidden {
			visible = append(visible, x)
		}
	}
	out := homeOut{Categories: visible, Expenses: make([]ordered.Map, len(docs)), PendingCash: make([]ordered.Map, len(pending)), People: people, Period: period, ProofRequired: true, Role: "COOK"}
	out.CurrentPeriod, _ = bs.CurrentPeriod(now)
	for i := range docs {
		out.Expenses[i] = serialize(&docs[i], p.UserID, names)
		d := &docs[i]
		if d.Status == "RECORDED" && d.Category != staffCash && d.By == me {
			out.Mine.Count++
			out.Mine.Out += d.Amount
		}
	}
	for i := range pending {
		out.PendingCash[i] = serialize(&pending[i], p.UserID, names)
	}
	httpx.OK(c, out, "Expenses loaded")
}

// ParseSpentOn is parseSpentOn: empty means today; the future and the distant past are refused.
func ParseSpentOn(value string, now time.Time) (time.Time, error) {
	today := bs.Today(now)
	if value == "" {
		return today, nil
	}
	day, err := time.Parse("2006-01-02", value)
	if err != nil {
		return time.Time{}, fail(422, "INVALID_DATE", "That date does not exist.")
	}
	if day.After(today) {
		return time.Time{}, fail(422, "DATE_IN_FUTURE", "The date cannot be in the future.")
	}
	if today.Sub(day) > oldestDays*24*time.Hour {
		return time.Time{}, fail(422, "DATE_TOO_OLD", "That date is too long ago. Check the year.")
	}
	return day, nil
}

func rupees(n int64) string { return "Rs " + money.GroupIN(n) }

type input struct {
	amount                      int64
	category, clientRequest     string
	customID, hostelID, paidBy  string
	photoAssetID, spentOn, what string
	shared, notified            bool
	salaryName, salaryUser      string
	hasSalary                   bool
}

func parse(body any) (*input, error) {
	f := valid.NewForm(body)
	in := &input{}
	if f.M != nil {
		v, present := f.M["amount"]
		n, isNum := v.(float64)
		switch {
		case !present || !isNum:
			f.Is.Add("amount", "Write how much you paid.")
		case n != float64(int64(n)):
			f.Is.Add("amount", "Write the amount in whole rupees.")
		default:
			if n <= 0 {
				f.Is.Add("amount", "Write how much you paid.")
			}
			if n > amountMax {
				f.Is.Add("amount", "That amount is too big. Check it.")
			}
			in.amount = int64(n)
		}
	}
	in.category, _ = f.Enum("category", false, nil, append(append([]string{}, categoryKeys...), custom)...)
	in.clientRequest, _ = f.Str("clientRequestId", valid.S{Opt: true, Trim: true, Min: 8, Max: 64})
	id := func(key string) string {
		v, present := f.M[key]
		if !present {
			return ""
		}
		s, ok := v.(string)
		if !ok {
			f.Is.Add(key, valid.Type("string", valid.Received(v, false)))
			f.Hard = true
			return ""
		}
		if !objectIDRe.MatchString(s) {
			f.Is.Add(key, "Invalid id.")
			return ""
		}
		return s
	}
	in.customID = id("customCategoryId")
	in.hostelID = id("hostelId")
	cash := "CASH"
	in.paidBy, _ = f.Enum("paidBy", false, &cash, "CASH", "ESEWA", "KHALTI", "BANK")
	in.photoAssetID = id("photoAssetId")
	if v, present := f.M["salaryFor"]; present {
		m, ok := v.(map[string]any)
		if !ok {
			f.Is.Add("salaryFor", valid.Type("object", valid.Received(v, false)))
			f.Hard = true
		} else {
			in.hasSalary = true
			sub := &valid.Form{M: m}
			in.salaryName, _ = sub.Str("name", valid.S{Trim: true, Min: 1, MinMsg: "Write their name.", Max: 120, MaxMsg: "Their name is too long."})
			if u, has := m["userId"]; has {
				s, isStr := u.(string)
				if !isStr {
					sub.Is.Add("userId", valid.Type("string", valid.Received(u, false)))
				} else if !objectIDRe.MatchString(s) {
					sub.Is.Add("userId", "Invalid id.")
				}
				in.salaryUser = s
			}
			f.Join("salaryFor", sub)
		}
	}
	in.shared, _ = f.Bool("sharedReceipt", true, nil)
	in.notified, _ = f.Bool("notifiedOnDevice", true, nil)
	if v, present := f.M["spentOn"]; present {
		s, ok := v.(string)
		if !ok {
			f.Is.Add("spentOn", valid.Type("string", valid.Received(v, false)))
			f.Hard = true
		} else if !dayRe.MatchString(s) {
			f.Is.Add("spentOn", "Date must be YYYY-MM-DD.")
		}
		in.spentOn = s
	}
	hasCashTo := false
	if v, present := f.M["cashTo"]; present {
		m, ok := v.(map[string]any)
		if !ok {
			f.Is.Add("cashTo", valid.Type("object", valid.Received(v, false)))
			f.Hard = true
		} else {
			hasCashTo = true
			sub := &valid.Form{M: m}
			u, has := m["userId"]
			s, isStr := u.(string)
			switch {
			case !has || !isStr:
				sub.Is.Add("userId", valid.Type("string", valid.Received(u, !has)))
			case !objectIDRe.MatchString(s):
				sub.Is.Add("userId", "Invalid id.")
			}
			f.Join("cashTo", sub)
		}
	}
	in.what, _ = f.Str("what", valid.S{Opt: true, Trim: true, Max: whatMax})
	if err := f.Err(); err != nil {
		return nil, err
	}
	if in.category == staffCash && !hasCashTo {
		f.Is.Add("cashTo", "Pick the warden who got the money.")
	}
	if in.category == custom && in.customID == "" {
		f.Is.Add("customCategoryId", "Pick one of your categories.")
	}
	if in.category == "OTHER" && in.what == "" {
		f.Is.Add("what", "Write what it was for.")
	}
	if err := f.Err(); err != nil {
		return nil, err
	}
	return in, nil
}

func (h *Handler) byRequest(ctx context.Context, a *actor, key string, me bson.ObjectID) (*doc, error) {
	var d doc
	err := h.DB.Collection("expenses").FindOne(ctx, bson.D{{Key: "clientRequestId", Value: key}, {Key: "hostelId", Value: a.hostelID}, {Key: "recordedBy", Value: me}}).Decode(&d)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &d, nil
}

// one is serializeOne.
func (h *Handler) one(ctx context.Context, d *doc, asker string) (ordered.Map, error) {
	names := map[string]string{}
	if d.CustomID != nil {
		var row struct {
			Name string `bson:"name"`
		}
		err := h.DB.Collection("hostelexpensecategories").FindOne(ctx, bson.D{{Key: "_id", Value: *d.CustomID}}).Decode(&row)
		if err == nil {
			names[d.CustomID.Hex()] = row.Name
		} else if err != mongo.ErrNoDocuments {
			return nil, err
		}
	}
	return serialize(d, asker, names), nil
}

type photo struct {
	id          bson.ObjectID
	hash, txnID string
}

func (h *Handler) usablePhoto(ctx context.Context, a *actor, assetID string) (*photo, error) {
	id, err := httpx.OID(assetID, "asset id")
	if err != nil {
		return nil, err
	}
	var row struct {
		Hash     string         `bson:"contentHash"`
		HostelID *bson.ObjectID `bson:"hostelId"`
		Kind     string         `bson:"kind"`
		OwnerID  *bson.ObjectID `bson:"ownerId"`
		TxnID    string         `bson:"receiptTxnId"`
		Done     *time.Time     `bson:"uploadCompletedAt"`
	}
	err = h.DB.Collection("fileassets").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}}).Decode(&row)
	if err != nil && err != mongo.ErrNoDocuments {
		return nil, err
	}
	if err != nil || row.OwnerID == nil || row.OwnerID.Hex() != a.p.UserID || row.HostelID == nil || *row.HostelID != a.hostelID || row.Kind != "EXPENSE_RECEIPT" {
		return nil, fail(403, "ASSET_NOT_OWNED", "This photo is not yours to attach. Add it again.")
	}
	if row.Done == nil {
		return nil, fail(409, "ASSET_NOT_READY", "The photo has not finished uploading. Try again.")
	}
	return &photo{id, row.Hash, row.TxnID}, nil
}

func (h *Handler) receiptGroup(ctx context.Context, hostel bson.ObjectID) (bson.ObjectID, error) {
	var row struct {
		Parent *bson.ObjectID `bson:"parentHostelId"`
	}
	err := h.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}}).Decode(&row)
	if err != nil && err != mongo.ErrNoDocuments {
		return hostel, err
	}
	if row.Parent != nil {
		return *row.Parent, nil
	}
	return hostel, nil
}

// savedReceipt is findSavedReceipt + receiptAlreadySaved: nil when the receipt is new.
func (h *Handler) savedReceipt(ctx context.Context, a *actor, group bson.ObjectID, hash, txn string) error {
	match := bson.A{}
	if hash != "" {
		match = append(match, bson.D{{Key: "receiptHash", Value: hash}})
	}
	if txn != "" {
		match = append(match, bson.D{{Key: "receiptTxnId", Value: txn}})
	}
	if len(match) == 0 {
		return nil
	}
	var saved struct {
		Amount   int64         `bson:"amount"`
		HostelID bson.ObjectID `bson:"hostelId"`
		By       string        `bson:"recordedByName"`
	}
	err := h.DB.Collection("expenses").FindOne(ctx, bson.D{{Key: "receiptGroupId", Value: group}, {Key: "status", Value: "RECORDED"}, {Key: "$or", Value: match}}).Decode(&saved)
	if err == mongo.ErrNoDocuments {
		return nil
	}
	if err != nil {
		return err
	}
	msg := "Already added: " + rupees(saved.Amount)
	if saved.By != "" {
		msg += " by " + saved.By
	}
	if saved.HostelID != a.hostelID {
		name, err := residents.HostelName(ctx, h.DB, saved.HostelID)
		if err != nil {
			return err
		}
		if name != "" {
			msg += " in " + name
		}
	}
	return fail(409, "RECEIPT_ALREADY_SAVED", msg+".")
}

func (h *Handler) recorderName(ctx context.Context, a *actor, me bson.ObjectID) (string, error) {
	var cook struct {
		Name string `bson:"name"`
	}
	err := h.DB.Collection("cookaccounts").FindOne(ctx, bson.D{{Key: "hostelId", Value: a.hostelID}, {Key: "userId", Value: me}}).Decode(&cook)
	if err != nil && err != mongo.ErrNoDocuments {
		return "", err
	}
	if cook.Name != "" {
		return cook.Name, nil
	}
	var user struct {
		Name string `bson:"name"`
	}
	err = h.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: me}}).Decode(&user)
	if err != nil && err != mongo.ErrNoDocuments {
		return "", err
	}
	return user.Name, nil
}

func (h *Handler) notifyAdmins(ctx context.Context, hostel bson.ObjectID, except, title, body, expenseID, kind string) {
	admins, err := residents.HostelStaffUserIDs(ctx, h.DB, hostel, true)
	if err != nil {
		return
	}
	for _, id := range admins {
		if id != except {
			_, _ = h.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/app/expenses", Body: body, Category: "PAYMENT", Data: ordered.Map{{Key: "expenseId", Value: expenseID}, {Key: "type", Value: kind}}, HostelID: hostel.Hex(), Kind: "NORMAL", Title: title, UserID: id})
		}
	}
}

func (h *Handler) moneyMoved(ctx context.Context, hostel bson.ObjectID) {
	realtime.PublishResourceChange(ctx, h.RT, h.Bump, realtime.Change{HostelIDs: []string{hostel.Hex()}, Topics: []realtime.Topic{realtime.Payments}})
}

func (h *Handler) create(c *gin.Context) {
	p, err := h.cook(c)
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
	a, err := h.resolve(c, p, in.hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	me, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	already := func(d *doc) {
		out, err := h.one(c, d, p.UserID)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		httpx.OK(c, out, "Already saved")
	}
	if in.clientRequest != "" {
		d, err := h.byRequest(c, a, in.clientRequest, me)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		if d != nil {
			already(d)
			return
		}
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	spentOn, err := ParseSpentOn(in.spentOn, now)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var customID any
	if in.category == custom {
		id, _ := bson.ObjectIDFromHex(in.customID)
		err := h.DB.Collection("hostelexpensecategories").FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "hidden", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "hostelId", Value: a.hostelID}}).Err()
		if err == mongo.ErrNoDocuments {
			httpx.Fail(c, fail(404, "CATEGORY_NOT_FOUND", "That category is not there any more. Pick another."))
			return
		}
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		customID = id
	}
	var salary any
	if in.category == "SALARY" && in.hasSalary {
		var user any
		if in.salaryUser != "" {
			people, err := h.people(c, a.hostelID)
			if err != nil {
				httpx.Fail(c, err)
				return
			}
			for _, x := range people {
				if x.UserID == in.salaryUser {
					user, _ = bson.ObjectIDFromHex(in.salaryUser)
				}
			}
		}
		salary = bson.D{{Key: "name", Value: in.salaryName}, {Key: "userId", Value: user}}
	}
	if in.category == staffCash {
		httpx.Fail(c, fail(403, "CAPABILITY_DENIED", "Only the owner can give cash to a warden."))
		return
	}
	if in.photoAssetID == "" {
		httpx.Fail(c, fail(422, "PROOF_REQUIRED", "Add a photo of the bill or the goods."))
		return
	}
	ph, err := h.usablePhoto(c, a, in.photoAssetID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var groupID, hashVal, txnVal any
	if in.shared {
		group, err := h.receiptGroup(c, a.hostelID)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		groupID = group
		if ph.hash != "" {
			hashVal = ph.hash
		}
		if ph.txnID != "" {
			txnVal = ph.txnID
		}
		if err := h.savedReceipt(c, a, group, ph.hash, ph.txnID); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	name, err := h.recorderName(c, a, me)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var request any
	if in.clientRequest != "" {
		request = in.clientRequest
	}
	id := bson.NewObjectID()
	_, err = h.DB.Collection("expenses").InsertOne(c, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: a.hostelID}, {Key: "spentOn", Value: spentOn}, {Key: "amount", Value: in.amount}, {Key: "category", Value: in.category}, {Key: "customCategoryId", Value: customID},
		{Key: "what", Value: in.what}, {Key: "paidBy", Value: in.paidBy}, {Key: "payer", Value: "STAFF"}, {Key: "photoAssetId", Value: ph.id}, {Key: "receiptGroupId", Value: groupID}, {Key: "receiptHash", Value: hashVal}, {Key: "receiptTxnId", Value: txnVal},
		{Key: "cashTo", Value: nil}, {Key: "cashStatus", Value: nil}, {Key: "salaryFor", Value: salary}, {Key: "recordedBy", Value: me}, {Key: "recordedByName", Value: name}, {Key: "recordedByRole", Value: "COOK"}, {Key: "source", Value: "MANUAL"}, {Key: "status", Value: "RECORDED"},
		{Key: "clientRequestId", Value: request}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}})
	if err != nil {
		if mongo.IsDuplicateKeyError(err) {
			if in.clientRequest != "" {
				if d, derr := h.byRequest(c, a, in.clientRequest, me); derr == nil && d != nil {
					already(d)
					return
				}
			}
			if in.shared {
				group := groupID.(bson.ObjectID)
				if serr := h.savedReceipt(c, a, group, ph.hash, ph.txnID); serr != nil {
					httpx.Fail(c, serr)
					return
				}
			}
		}
		httpx.Fail(c, err)
		return
	}
	if err := h.Audit.WriteFinance(c, me, string(p.Role), audit.Finance{Action: "EXPENSE_RECORDED", AmountAfter: in.amount, EntityID: id.Hex(), EntityType: "Expense", HostelID: a.hostelID, Source: "EXPENSE_MANUAL"}); err != nil {
		httpx.Fail(c, err)
		return
	}
	who := name
	if who == "" {
		who = "Staff"
	}
	text := who + " recorded " + rupees(in.amount)
	if in.what != "" {
		text += " — " + in.what
	}
	h.notifyAdmins(c, a.hostelID, p.UserID, "New expense recorded", text+".", id.Hex(), "STAFF_EXPENSE_RECORDED")
	if in.shared {
		_, _ = h.Notify.CreateInApp(c, notifications.Input{ActionURL: "/app/expenses", Body: "Your shared receipt was saved as an expense of NPR " + money.GroupUS(in.amount) + ".", Category: "PAYMENT",
			Data: ordered.Map{{Key: "expenseId", Value: id.Hex()}, {Key: "type", Value: "SHARED_RECEIPT_SAVED"}}, HostelID: a.hostelID.Hex(), Kind: "NORMAL", NoPush: in.notified, Title: "Receipt saved", UserID: p.UserID})
	}
	h.moneyMoved(c, a.hostelID)
	var d doc
	if err := h.DB.Collection("expenses").FindOne(c, bson.D{{Key: "_id", Value: id}}).Decode(&d); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.one(c, &d, p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, 201, out, "Expense added")
}

func (h *Handler) void(c *gin.Context) {
	p, err := h.cook(c)
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
	a, err := h.resolve(c, p, "")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		httpx.Fail(c, fail(404, "EXPENSE_NOT_FOUND", notFoundMsg))
		return
	}
	me, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	coll := h.DB.Collection("expenses")
	filter := bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: a.hostelID}, {Key: "recordedBy", Value: me}}
	var old doc
	err = coll.FindOne(c, filter).Decode(&old)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, fail(404, "EXPENSE_NOT_FOUND", notFoundMsg))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	already := fail(409, "EXPENSE_ALREADY_VOID", "This expense is already cancelled.")
	if old.Status == "VOID" {
		httpx.Fail(c, already)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	var updated doc
	err = coll.FindOneAndUpdate(c, append(filter, bson.E{Key: "status", Value: "RECORDED"}),
		bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "VOID"}, {Key: "voidReason", Value: reason}, {Key: "voidedAt", Value: now}, {Key: "voidedBy", Value: me}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&updated)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, already)
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.Audit.WriteFinance(c, me, string(p.Role), audit.Finance{Action: "EXPENSE_VOIDED", AmountBefore: old.Amount, EntityID: old.ID.Hex(), EntityType: "Expense", HostelID: a.hostelID, Reason: reason, Source: "EXPENSE_VOID"}); err != nil {
		httpx.Fail(c, err)
		return
	}
	what := rupees(old.Amount)
	if old.What != "" {
		what += " — " + old.What
	}
	who := old.ByName
	if who == "" {
		who = "Staff"
	}
	h.notifyAdmins(c, a.hostelID, p.UserID, "Expense cancelled", who+" cancelled "+what+". "+reason, old.ID.Hex(), "STAFF_EXPENSE_VOIDED")
	h.moneyMoved(c, a.hostelID)
	out, err := h.one(c, &updated, p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Expense cancelled")
}
