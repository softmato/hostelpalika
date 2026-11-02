package stock

import (
	"context"
	"errors"
	"math"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/expenses"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/export"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

const (
	itemLimit     = 200
	supplierLimit = 200
	itemNameMax   = 40
	supplierMax   = 60
	amountMax     = 100_000_000
)

var (
	stockUnits = []string{"KG", "LITRE", "SACK", "PACKET", "PIECE", "DOZEN", "BOTTLE", "TIN", "CYLINDER"}
	stockKinds = []string{"STORE", "DAILY"}
	entryKinds = []string{"BUY", "OPENING", "USE", "WASTE", "SEND", "COUNT"}
	useFor     = []string{"KITCHEN", "STAFF", "RESIDENT", "OTHER"}
	wasteWhy   = []string{"SPOILED", "EXPIRED", "DAMAGED", "OTHER"}
	stockCats  = []string{"GROCERIES", "VEGETABLES_MEAT", "GAS", "WATER", "CLEANING", "OTHER"}
	paidBy     = []string{"CASH", "ESEWA", "KHALTI", "BANK"}
	periodRe   = regexp.MustCompile(`^\d{4}-(0[1-9]|1[0-2])$`)
	dayRe      = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

// Admin is the store side: buying, sending, counting, suppliers and the reports.
type Admin struct {
	*Handler
	Expenses *expenses.Handler
	Cache    *cache.Cache
}

func (a *Admin) Register(v1 *gin.RouterGroup) {
	g := v1.Group("/hostel-admin/stock")
	g.GET("", a.adminHome)
	g.POST("", a.adminCreate)
	g.PUT("/cook", a.cookSwitch)
	g.POST("/entries/:id/approve", a.approve)
	g.POST("/entries/:id/cancel", a.cancel)
	g.POST("/entries/:id/receive", a.receive)
	g.POST("/items", a.addItem)
	g.PATCH("/items/:id", a.editItem)
	g.POST("/payments", a.pay)
	g.POST("/payments/:id/cancel", a.cancelPay)
	g.GET("/report", a.report)
	g.POST("/suppliers", a.addSupplier)
	g.GET("/suppliers/:id", httpx.ETag(), a.supplier)
	g.PATCH("/suppliers/:id", a.editSupplier)
	g.GET("/usage", a.usage)
}

type storePlace struct {
	ID       string
	IsMain   bool
	Location string
	Name     string
}

type rights struct {
	CanApprove, CanSpend, Money, ProofRequired bool
}

// storeActor is StockActor for hostel staff.
type storeActor struct {
	active  bson.ObjectID
	group   bson.ObjectID
	mine    []string
	mineIDs []bson.ObjectID
	owner   bool
	overall bool
	places  []storePlace
	p       *authz.Principal
	rights  rights
}

func (a *storeActor) nameOf(id string) string {
	for _, x := range a.places {
		if x.ID == id {
			return x.Name
		}
	}
	return "Hostel"
}

func (s *storeActor) isMine(id string) bool { return slices.Contains(s.mine, id) }

func (a *Admin) resolveStore(ctx context.Context, p *authz.Principal, everyBuilding bool) (*storeActor, error) {
	active := ""
	if len(p.HostelIDs) > 0 {
		active = p.HostelIDs[0]
	}
	id, err := bson.ObjectIDFromHex(active)
	if err != nil {
		return nil, fail(422, "HOSTEL_SCOPE_REQUIRED", "Pick a hostel first.")
	}
	var hostel struct {
		Parent *bson.ObjectID `bson:"parentHostelId"`
	}
	err = a.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: id}}, options.FindOne().SetProjection(bson.D{{Key: "parentHostelId", Value: 1}})).Decode(&hostel)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, fail(404, "HOSTEL_NOT_FOUND", "Hostel not found.")
	}
	if err != nil {
		return nil, err
	}
	group := id
	if hostel.Parent != nil {
		group = *hostel.Parent
	}
	cur, err := a.DB.Collection("hostels").Find(ctx, bson.D{{Key: "$or", Value: bson.A{bson.D{{Key: "_id", Value: group}}, bson.D{{Key: "parentHostelId", Value: group}}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID       bson.ObjectID  `bson:"_id"`
		Name     *string        `bson:"name"`
		Parent   *bson.ObjectID `bson:"parentHostelId"`
		Location struct {
			Area string `bson:"area"`
			City string `bson:"city"`
		} `bson:"location"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	places := make([]storePlace, len(rows))
	for i, r := range rows {
		parts := []string{}
		if r.Location.Area != "" {
			parts = append(parts, r.Location.Area)
		}
		if r.Location.City != "" {
			parts = append(parts, r.Location.City)
		}
		name := "Hostel"
		if r.Name != nil {
			name = *r.Name
		}
		places[i] = storePlace{r.ID.Hex(), r.Parent == nil, strings.Join(parts, ", "), name}
	}
	sort.SliceStable(places, func(i, j int) bool { return places[i].IsMain && !places[j].IsMain })
	owner := p.Role == authz.HostelAdmin
	held := p.HostelIDs
	if owner && everyBuilding && len(p.AllHostelIDs) > 0 {
		held = p.AllHostelIDs
	}
	s := &storeActor{active: id, group: group, owner: owner, overall: owner && everyBuilding, places: places, p: p}
	for _, x := range places {
		if slices.Contains(held, x.ID) {
			s.mine = append(s.mine, x.ID)
			pid, _ := bson.ObjectIDFromHex(x.ID)
			s.mineIDs = append(s.mineIDs, pid)
		}
	}
	if owner {
		s.rights = rights{true, true, true, false}
		return s, nil
	}
	var member struct {
		Permissions []string `bson:"permissions"`
	}
	me, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		return nil, err
	}
	err = a.DB.Collection("hostelmembers").FindOne(ctx, bson.D{{Key: "hostelId", Value: id}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "status", Value: "ACTIVE"}, {Key: "userId", Value: me}}).Decode(&member)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	has := func(capability string) bool {
		for _, k := range authz.GrantingPermissionKeys(authz.Capability(capability)) {
			if slices.Contains(member.Permissions, k) {
				return true
			}
		}
		return false
	}
	spend := has("recordExpenses")
	s.rights = rights{has("approveStockCount"), spend, spend, !slices.Contains(member.Permissions, "expenseWithoutProof")}
	return s, nil
}

func (a *Admin) staffStore(c *gin.Context, every bool) (*storeActor, error) {
	p, err := a.Guards.RequireHostelCapability(c, "manageStock")
	if err != nil {
		return nil, err
	}
	return a.resolveStore(c, p, every)
}

// billMoney is billMoney: a nil answer means no prices at all.
func billMoney(e *entry) (paid, total float64, ok bool) {
	var fromLines float64
	for _, l := range e.Lines {
		if l.Rate != nil {
			fromLines += *l.Rate * l.Qty
		}
	}
	switch {
	case e.Total != nil:
		total = *e.Total
	case e.Amount != nil:
		total = *e.Amount
	case fromLines > 0:
		total = jsRound(fromLines)
	default:
		return 0, 0, false
	}
	paid = total
	if e.Paid != nil {
		paid = *e.Paid
	} else if e.Amount != nil {
		paid = *e.Amount
	}
	return math.Min(paid, total), total, true
}

func billStatus(total, paid float64) string {
	if paid >= total {
		return "PAID"
	}
	if paid > 0 {
		return "PARTIAL"
	}
	return "DUE"
}

func numOrNil(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

func zeroOr(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

func serializeStore(a *storeActor, e *entry) ordered.Map {
	mine := e.RecordedBy.Hex() == a.p.UserID
	var toID, toName any
	toHex := ""
	if e.ToHostelID != nil {
		toHex = e.ToHostelID.Hex()
		toID, toName = toHex, a.nameOf(toHex)
	}
	money := a.rights.Money
	live := !a.overall && e.Status != "CANCELLED"
	pendingCount := e.Kind == "COUNT" && e.Status == "PENDING"
	canApprove := live && pendingCount && a.rights.CanApprove && a.isMine(e.HostelID.Hex()) && (a.owner || !mine)
	var amount any
	if (a.owner || (mine && money)) && e.Amount != nil {
		amount = *e.Amount
	}
	var bill any
	if e.Kind == "BUY" {
		paid, total, ok := billMoney(e)
		var discount, due, paidOut, status, supplierID, tax, totalOut, photo any
		if money {
			discount, tax = zeroOr(e.Discount), zeroOr(e.Tax)
			if ok {
				due, paidOut, status, totalOut = total-paid, paid, billStatus(total, paid), total
			}
		}
		if e.Photo != nil {
			photo = e.Photo.Hex()
		}
		if e.SupplierID != nil {
			supplierID = e.SupplierID.Hex()
		}
		no := ""
		if e.BillNo != nil {
			no = *e.BillNo
		}
		bill = ordered.Map{{Key: "billNo", Value: no}, {Key: "discount", Value: discount}, {Key: "due", Value: due}, {Key: "paid", Value: paidOut}, {Key: "photoAssetId", Value: photo}, {Key: "status", Value: status}, {Key: "supplierId", Value: supplierID}, {Key: "tax", Value: tax}, {Key: "total", Value: totalOut}}
	}
	lines := make([]ordered.Map, len(e.Lines))
	for i, l := range e.Lines {
		var lineAmount, rate any
		if money && l.Rate != nil {
			rate = *l.Rate
			if e.Kind == "BUY" {
				lineAmount = jsRound(*l.Rate * l.Qty)
			}
		}
		lines[i] = ordered.Map{{Key: "amount", Value: lineAmount}, {Key: "itemId", Value: l.ItemID.Hex()}, {Key: "name", Value: l.Name}, {Key: "packQty", Value: ptrAny(l.PackQty)}, {Key: "packUnit", Value: ptrAny(l.PackUnit)}, {Key: "qty", Value: l.Qty},
			{Key: "rate", Value: rate}, {Key: "receivedQty", Value: ptrAny(l.ReceivedQ)}, {Key: "systemQty", Value: ptrAny(l.SystemQty)}, {Key: "unit", Value: l.Unit}}
	}
	name := e.RecordedName
	if name == "" {
		name = "Staff"
		if e.RecordedRole != nil && *e.RecordedRole == "COOK" {
			name = "Kitchen"
		}
	}
	var received any
	if e.ReceivedAt != nil {
		received = httpx.ISO(*e.ReceivedAt)
	}
	supplier := ""
	if e.Supplier != nil {
		supplier = *e.Supplier
	}
	canCancel := live && (a.owner || canApprove || (mine && !(e.Kind == "SEND" && e.Status == "RECEIVED") && !(e.Kind == "COUNT" && e.Status == "DONE" && !pendingCount)))
	canReceive := !a.overall && e.Status == "PENDING" && e.Kind == "SEND" && toHex != "" && a.isMine(toHex)
	return ordered.Map{{Key: "amount", Value: amount}, {Key: "approvedByName", Value: ptrAny(e.ApprovedBy)}, {Key: "bill", Value: bill}, {Key: "canApprove", Value: canApprove}, {Key: "canCancel", Value: canCancel}, {Key: "canReceive", Value: canReceive},
		{Key: "cancelReason", Value: ptrAny(e.CancelReason)}, {Key: "createdAt", Value: httpx.ISO(e.CreatedAt)}, {Key: "hostelId", Value: e.HostelID.Hex()}, {Key: "hostelName", Value: a.nameOf(e.HostelID.Hex())}, {Key: "id", Value: e.ID.Hex()},
		{Key: "kind", Value: e.Kind}, {Key: "lines", Value: lines}, {Key: "mine", Value: mine}, {Key: "note", Value: e.Note}, {Key: "on", Value: dayKey(e.On)}, {Key: "receivedAt", Value: received}, {Key: "receivedByName", Value: ptrAny(e.ReceivedBy)},
		{Key: "recordedByName", Value: name}, {Key: "recordedRole", Value: ptrAny(e.RecordedRole)}, {Key: "status", Value: e.Status}, {Key: "supplier", Value: supplier}, {Key: "toHostelId", Value: toID}, {Key: "toHostelName", Value: toName},
		{Key: "useFor", Value: ptrAny(e.UseFor)}, {Key: "wasteReason", Value: ptrAny(e.WasteReason)}}
}

type supplierDoc struct {
	ID         bson.ObjectID `bson:"_id"`
	Active     bool          `bson:"active"`
	CreatedAt  time.Time     `bson:"createdAt"`
	Name       string        `bson:"name"`
	Note       string        `bson:"note"`
	OpeningDue float64       `bson:"openingDue"`
	Phone      string        `bson:"phone"`
}

type paymentDoc struct {
	ID         bson.ObjectID  `bson:"_id"`
	Amount     float64        `bson:"amount"`
	CreatedAt  time.Time      `bson:"createdAt"`
	ExpenseID  *bson.ObjectID `bson:"expenseId"`
	HostelID   bson.ObjectID  `bson:"hostelId"`
	Note       string         `bson:"note"`
	On         time.Time      `bson:"on"`
	PaidBy     string         `bson:"paidBy"`
	RecordedBy bson.ObjectID  `bson:"recordedBy"`
	ByName     string         `bson:"recordedByName"`
	Status     string         `bson:"status"`
	SupplierID bson.ObjectID  `bson:"supplierId"`
}

func (a *Admin) readAll(ctx context.Context, s *storeActor) ([]item, []entry, map[bson.ObjectID]string, error) {
	cur, err := a.DB.Collection("stockitems").Find(ctx, bson.D{{Key: "groupHostelId", Value: s.group}}, options.Find().SetSort(bson.D{{Key: "active", Value: -1}, {Key: "name", Value: 1}}))
	if err != nil {
		return nil, nil, nil, err
	}
	var items []item
	if err := cur.All(ctx, &items); err != nil {
		return nil, nil, nil, err
	}
	cur, err = a.DB.Collection("stockentries").Find(ctx, bson.D{{Key: "groupHostelId", Value: s.group}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: 1}}))
	if err != nil {
		return nil, nil, nil, err
	}
	var docs []entry
	if err := cur.All(ctx, &docs); err != nil {
		return nil, nil, nil, err
	}
	kinds := make(map[bson.ObjectID]string, len(items))
	for i := range items {
		kinds[items[i].ID] = items[i].Kind
	}
	return items, docs, kinds, nil
}

func (a *Admin) suppliersOf(ctx context.Context, s *storeActor) ([]supplierDoc, error) {
	cur, err := a.DB.Collection("stocksuppliers").Find(ctx, bson.D{{Key: "groupHostelId", Value: s.group}}, options.Find().SetSort(bson.D{{Key: "active", Value: -1}, {Key: "name", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []supplierDoc
	return rows, cur.All(ctx, &rows)
}

func (a *Admin) residentsAt(ctx context.Context, id bson.ObjectID) (int64, error) {
	return a.DB.Collection("residents").CountDocuments(ctx, bson.D{{Key: "hostelId", Value: id}, {Key: "isDeleted", Value: false}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "MOVED_OUT"}}}})
}

type supplierTotal struct {
	Bills      int     `json:"bills"`
	Billed     float64 `json:"billed"`
	Name       string  `json:"name"`
	Paid       float64 `json:"paid"`
	SupplierID *string `json:"supplierId"`
}

func boughtBySupplier(docs []*entry, suppliers []supplierDoc, mine func(string) bool) []supplierTotal {
	names := map[bson.ObjectID]string{}
	for _, x := range suppliers {
		names[x.ID] = x.Name
	}
	order := []*supplierTotal{}
	index := map[string]*supplierTotal{}
	for _, e := range docs {
		if e.Kind != "BUY" || e.Status == "CANCELLED" || !mine(e.HostelID.Hex()) {
			continue
		}
		paid, total, ok := billMoney(e)
		if !ok {
			continue
		}
		free := ""
		if e.Supplier != nil {
			free = *e.Supplier
		}
		key := "name:" + strings.ToLower(free)
		var sid *string
		name := free
		if e.SupplierID != nil {
			hex := e.SupplierID.Hex()
			key, sid = hex, &hex
			if n := names[*e.SupplierID]; n != "" {
				name = n
			}
		}
		if name == "" {
			name = "No supplier"
		}
		b := index[key]
		if b == nil {
			b = &supplierTotal{Name: name, SupplierID: sid}
			index[key] = b
			order = append(order, b)
		}
		b.Bills++
		b.Billed += total
		b.Paid += paid
	}
	sort.SliceStable(order, func(i, j int) bool { return order[i].Billed > order[j].Billed })
	out := make([]supplierTotal, len(order))
	for i, b := range order {
		out[i] = *b
	}
	return out
}

func resolvePeriod(requested string, now time.Time) string {
	current, _ := bs.CurrentPeriod(now)
	if requested == "" || !bs.IsBsPeriod(requested) || requested > current {
		return current
	}
	if _, err := bs.PeriodBounds(requested); err != nil {
		return current
	}
	return requested
}

// atRow answers one building's figures for an item; money hidden unless allowed.
func atRow(row atPlace, money bool, hostel string, low bool) ordered.Map {
	if !money {
		row.AdjustedValue, row.BoughtValue, row.UsedValue, row.WastedValue = 0, 0, 0, 0
	}
	var countedAt any
	if row.CountedAt != nil {
		countedAt = httpx.ISO(*row.CountedAt)
	}
	return ordered.Map{{Key: "adjusted", Value: row.Adjusted}, {Key: "adjustedValue", Value: row.AdjustedValue}, {Key: "bought", Value: row.Bought}, {Key: "boughtValue", Value: row.BoughtValue}, {Key: "closing", Value: row.Closing}, {Key: "counted", Value: numOrNil(row.Counted)},
		{Key: "countedAt", Value: countedAt}, {Key: "in", Value: row.In}, {Key: "left", Value: row.Left}, {Key: "onWay", Value: row.OnWay}, {Key: "opening", Value: row.Opening}, {Key: "out", Value: row.Out}, {Key: "short", Value: row.Short}, {Key: "used", Value: row.Used},
		{Key: "usedValue", Value: row.UsedValue}, {Key: "wasted", Value: row.Wasted}, {Key: "wastedValue", Value: row.WastedValue}, {Key: "hostelId", Value: hostel}, {Key: "low", Value: low}}
}

func cachedOr[T any](a *Admin, c *gin.Context, p *authz.Principal, every bool, key, message string, load func() (T, error)) {
	if raw := c.Request.URL.RawQuery; raw != "" {
		key += "?" + raw
	}
	if every {
		out, err := load()
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		httpx.Write(c, 200, out, message)
		return
	}
	cache.Respond(c, a.Cache, p.HostelIDs, p.UserID, key, message, load)
}

func scopeAll(q map[string]string, is *valid.Issues) bool {
	v, ok := q["scope"]
	if ok && v != "all" {
		is.Add("scope", `Invalid input: expected "all"`)
	}
	return ok && v == "all"
}

func (a *Admin) adminHome(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "manageStock")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	if v, ok := q["period"]; ok && !periodRe.MatchString(v) {
		is.Add("period", "Month must be YYYY-MM.")
	}
	every := scopeAll(q, &is)
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	cachedOr(a, c, p, every, "stock", "Stock loaded", func() (ordered.Map, error) {
		s, err := a.resolveStore(c, p, every)
		if err != nil {
			return nil, err
		}
		return a.home2(c, s, q["period"])
	})
}

func (a *Admin) home2(ctx context.Context, s *storeActor, requested string) (ordered.Map, error) {
	now := time.Now()
	period := resolvePeriod(requested, now)
	current, _ := bs.CurrentPeriod(now)
	items, docs, kinds, err := a.readAll(ctx, s)
	if err != nil {
		return nil, err
	}
	f := foldStock(docs, kinds, s.mineIDs, period, period)
	suppliers, err := a.suppliersOf(ctx, s)
	if err != nil {
		return nil, err
	}
	money := s.rights.Money
	var payments []paymentDoc
	if money {
		cur, err := a.DB.Collection("stockpayments").Find(ctx, bson.D{{Key: "groupHostelId", Value: s.group}, {Key: "status", Value: "DONE"}})
		if err != nil {
			return nil, err
		}
		if err := cur.All(ctx, &payments); err != nil {
			return nil, err
		}
	}
	residentsBy := map[string]int64{}
	var residentsTotal int64
	for i, id := range s.mineIDs {
		n, err := a.residentsAt(ctx, id)
		if err != nil {
			return nil, err
		}
		residentsBy[s.mine[i]] = n
		residentsTotal += n
	}
	touches := func(e *entry) bool {
		return s.isMine(e.HostelID.Hex()) || (e.ToHostelID != nil && s.isMine(e.ToHostelID.Hex()))
	}
	visible := []*entry{}
	for i := range docs {
		if touches(&docs[i]) {
			visible = append(visible, &docs[i])
		}
	}
	var usedValue, wastedValue, missingValue, boughtValue, stockValue float64
	type bucket struct {
		category          string
		stockValue, usedV float64
	}
	buckets := []*bucket{}
	byCat := map[string]*bucket{}
	low := 0
	itemRows := make([]ordered.Map, len(items))
	for i := range items {
		x := &items[i]
		avg := f.avgCost(x.ID)
		at := make([]ordered.Map, len(s.mineIDs))
		var leftHere, usedCat float64
		anyLow := false
		for j, place := range s.mineIDs {
			row := f.figures(x.ID, place)
			isLow := x.Kind == "STORE" && x.Active && x.LowAt != nil && row.Left < *x.LowAt
			anyLow = anyLow || isLow
			if money {
				usedValue += row.UsedValue
				wastedValue += row.WastedValue
				missingValue += math.Max(0, -row.AdjustedValue)
				boughtValue += row.BoughtValue
				usedCat += row.UsedValue + row.WastedValue
			}
			at[j] = atRow(row, money, s.mine[j], isLow)
			leftHere += math.Max(0, row.Left)
		}
		if anyLow {
			low++
		}
		var avgOut, value any
		worth := 0.0
		if money {
			avgOut = numOrNil(avg)
			if avg != nil && x.Kind == "STORE" {
				worth = jsRound(leftHere * *avg)
			}
			value = worth
		}
		stockValue += worth
		cat := "GROCERIES"
		if x.Category != nil {
			cat = *x.Category
		}
		b := byCat[cat]
		if b == nil {
			b = &bucket{category: cat}
			byCat[cat] = b
			buckets = append(buckets, b)
		}
		b.stockValue += worth
		b.usedV += usedCat
		location := ""
		if x.Location != nil {
			location = *x.Location
		}
		itemRows[i] = ordered.Map{{Key: "active", Value: x.Active}, {Key: "at", Value: at}, {Key: "avgCost", Value: avgOut}, {Key: "category", Value: cat}, {Key: "id", Value: x.ID.Hex()}, {Key: "kind", Value: x.Kind}, {Key: "location", Value: location}, {Key: "lowAt", Value: numOrNil(x.LowAt)},
			{Key: "name", Value: x.Name}, {Key: "packSize", Value: numOrNil(x.PackSize)}, {Key: "packUnit", Value: ptrAny(x.PackUnit)}, {Key: "unit", Value: x.Unit}, {Key: "value", Value: value}}
	}
	var dueTotal float64
	supplierRows := make([]ordered.Map, len(suppliers))
	for i := range suppliers {
		x := &suppliers[i]
		var bills []ledgerBill
		count := 0
		var last *time.Time
		for j := range docs {
			e := &docs[j]
			if e.Kind != "BUY" || e.Status == "CANCELLED" || e.SupplierID == nil || *e.SupplierID != x.ID {
				continue
			}
			count++
			paid, total, _ := billMoney(e)
			bills = append(bills, ledgerBill{createdAt: e.CreatedAt, id: e.ID.Hex(), on: e.On, paid: paid, status: e.Status, total: total})
			if last == nil || e.On.After(*last) {
				on := e.On
				last = &on
			}
		}
		var pays []ledgerPayment
		for _, y := range payments {
			if y.SupplierID == x.ID {
				pays = append(pays, ledgerPayment{amount: y.Amount, createdAt: y.CreatedAt, id: y.ID.Hex(), on: y.On, status: y.Status})
			}
		}
		ledger := supplierLedger(x.OpeningDue, bills, pays, x.CreatedAt)
		var billed, due, opening, lastOn any
		if money {
			billed, due, opening = ledger.billed, ledger.due, x.OpeningDue
			dueTotal += math.Max(0, ledger.due)
		}
		if last != nil {
			lastOn = dayKey(*last)
		}
		supplierRows[i] = ordered.Map{{Key: "active", Value: x.Active}, {Key: "bills", Value: count}, {Key: "billed", Value: billed}, {Key: "due", Value: due}, {Key: "id", Value: x.ID.Hex()}, {Key: "lastBillOn", Value: lastOn}, {Key: "name", Value: x.Name}, {Key: "note", Value: x.Note}, {Key: "openingDue", Value: opening}, {Key: "phone", Value: x.Phone}}
	}
	inPeriod := []*entry{}
	for _, e := range visible {
		if periodOf(e.On) == period {
			inPeriod = append(inPeriod, e)
		}
	}
	bounds, err := bs.PeriodBounds(period)
	if err != nil {
		return nil, err
	}
	days := bounds.DaysInMonth
	if period == current {
		days = max(1, int(math.Floor(bs.Today(now).Sub(bounds.Start).Hours()/24))+1)
	}
	spentValue := usedValue + wastedValue + missingValue
	summary := ordered.Map{}
	var costPer, boughtOut, dueOut, missingOut, spentOut, stockOut, usedOut, wastedOut any
	byCategory, bySupplier := []ordered.Map{}, []supplierTotal{}
	if money {
		kept := []*bucket{}
		for _, b := range buckets {
			if b.stockValue > 0 || b.usedV > 0 {
				kept = append(kept, b)
			}
		}
		sort.SliceStable(kept, func(i, j int) bool { return kept[i].stockValue+kept[i].usedV > kept[j].stockValue+kept[j].usedV })
		for _, b := range kept {
			byCategory = append(byCategory, ordered.Map{{Key: "category", Value: b.category}, {Key: "stockValue", Value: b.stockValue}, {Key: "usedValue", Value: b.usedV}})
		}
		bySupplier = boughtBySupplier(inPeriod, suppliers, s.isMine)
		if residentsTotal > 0 {
			costPer = jsRound(spentValue / (float64(residentsTotal) * float64(days)))
		}
		boughtOut, dueOut, missingOut, spentOut, stockOut, usedOut, wastedOut = boughtValue, dueTotal, missingValue, spentValue, stockValue, usedValue, wastedValue
	}
	summary = ordered.Map{{Key: "boughtValue", Value: boughtOut}, {Key: "byCategory", Value: byCategory}, {Key: "bySupplier", Value: bySupplier}, {Key: "costPerResidentDay", Value: costPer}, {Key: "days", Value: days}, {Key: "dueTotal", Value: dueOut}, {Key: "low", Value: low},
		{Key: "missingValue", Value: missingOut}, {Key: "residents", Value: residentsTotal}, {Key: "spentValue", Value: spentOut}, {Key: "stockValue", Value: stockOut}, {Key: "usedValue", Value: usedOut}, {Key: "wastedValue", Value: wastedOut}}

	store := map[string]bool{}
	for i := range items {
		if items[i].Active && items[i].Kind == "STORE" {
			store[items[i].ID.Hex()] = true
		}
	}
	type rank struct {
		id    string
		count int
	}
	ranks := []*rank{}
	byID := map[string]*rank{}
	tail := visible
	if len(tail) > 200 {
		tail = tail[len(tail)-200:]
	}
	for _, e := range tail {
		if e.Status == "CANCELLED" || (e.Kind != "USE" && e.Kind != "BUY") {
			continue
		}
		weight := 1
		if e.Kind == "USE" {
			weight = 3
		}
		for _, l := range e.Lines {
			id := l.ItemID.Hex()
			if !store[id] {
				continue
			}
			r := byID[id]
			if r == nil {
				r = &rank{id: id}
				byID[id] = r
				ranks = append(ranks, r)
			}
			r.count += weight
		}
	}
	sort.SliceStable(ranks, func(i, j int) bool { return ranks[i].count > ranks[j].count })
	recent := make([]string, len(ranks))
	for i, r := range ranks {
		recent[i] = r.id
	}
	sorted := append([]*entry{}, inPeriod...)
	sort.SliceStable(sorted, func(i, j int) bool {
		if !sorted[i].On.Equal(sorted[j].On) {
			return sorted[i].On.After(sorted[j].On)
		}
		return sorted[i].CreatedAt.After(sorted[j].CreatedAt)
	})
	if len(sorted) > 300 {
		sorted = sorted[:300]
	}
	entries := make([]ordered.Map, len(sorted))
	for i, e := range sorted {
		entries[i] = serializeStore(s, e)
	}
	sent, waiting, approve := []ordered.Map{}, []ordered.Map{}, []ordered.Map{}
	for i := len(visible) - 1; i >= 0; i-- {
		e := visible[i]
		if e.Kind != "SEND" || e.Status != "PENDING" {
			continue
		}
		if s.isMine(e.HostelID.Hex()) {
			sent = append(sent, serializeStore(s, e))
		}
		if e.ToHostelID != nil && s.isMine(e.ToHostelID.Hex()) {
			waiting = append(waiting, serializeStore(s, e))
		}
	}
	for _, e := range visible {
		if e.Kind == "COUNT" && e.Status == "PENDING" {
			row := serializeStore(s, e)
			if v, _ := row.Get("canApprove"); v == true {
				approve = append(approve, row)
			}
		}
	}
	places := make([]ordered.Map, len(s.places))
	for i, x := range s.places {
		var residents any
		if n, ok := residentsBy[x.ID]; ok {
			residents = n
		}
		places[i] = ordered.Map{{Key: "id", Value: x.ID}, {Key: "isMain", Value: x.IsMain}, {Key: "location", Value: x.Location}, {Key: "name", Value: x.Name}, {Key: "mine", Value: s.isMine(x.ID)}, {Key: "residents", Value: residents}}
	}
	return ordered.Map{{Key: "canApprove", Value: s.rights.CanApprove}, {Key: "canSpend", Value: s.rights.CanSpend}, {Key: "money", Value: money}, {Key: "proofRequired", Value: s.rights.ProofRequired}, {Key: "currentPeriod", Value: current}, {Key: "entries", Value: entries}, {Key: "items", Value: itemRows},
		{Key: "owner", Value: s.owner}, {Key: "period", Value: period}, {Key: "places", Value: places}, {Key: "recentUse", Value: recent}, {Key: "sentWaiting", Value: sent}, {Key: "summary", Value: summary}, {Key: "suppliers", Value: supplierRows}, {Key: "toApprove", Value: approve}, {Key: "waiting", Value: waiting}}, nil
}

type lineIn struct {
	amount  *float64
	item    string
	packQty *float64
	qty     float64
	rate    *float64
}

type entryIn struct {
	amount, discount, paid, tax *float64
	billNo, supplierID, useFor  string
	wasteReason, request        string
	hostel, kind, note, on      string
	paidBy, photo, supplier, to string
	lines                       []lineIn
}

func optionalInt(f *valid.Form, key string, min, max float64, positive bool) *float64 {
	v, present := f.M[key]
	if !present {
		return nil
	}
	n, ok := v.(float64)
	if !ok {
		f.Hard = true
		f.Is.Add(key, valid.Type("number", valid.Received(v, false)))
		return nil
	}
	if n != math.Trunc(n) {
		f.Is.Add(key, "Whole rupees.")
		return nil
	}
	if positive && n <= 0 {
		f.Is.Add(key, valid.TooSmall("number", 0, false))
	} else if !positive && n < min {
		f.Is.Add(key, valid.TooSmall("number", min, true))
	}
	if n > max {
		f.Is.Add(key, valid.TooBig("number", max, true))
	}
	return &n
}

func optionalIDIn(f *valid.Form, key string) string {
	v, present := f.M[key]
	if !present {
		return ""
	}
	s, ok := v.(string)
	if !ok {
		f.Hard = true
		f.Is.Add(key, valid.Type("string", valid.Received(v, false)))
		return ""
	}
	if !objectIDRe.MatchString(s) {
		f.Is.Add(key, "Invalid id.")
		return ""
	}
	return s
}

func parseEntry(body any) (*entryIn, error) {
	f := valid.NewForm(body)
	in := &entryIn{}
	in.amount = optionalInt(f, "amount", 0, amountMax, true)
	in.billNo, _ = f.Str("billNo", valid.S{Opt: true, Trim: true, Max: 40})
	in.discount = optionalInt(f, "discount", 0, amountMax, false)
	in.paid = optionalInt(f, "paid", 0, amountMax, false)
	in.supplierID = optionalIDIn(f, "supplierId")
	in.tax = optionalInt(f, "tax", 0, amountMax, false)
	in.useFor, _ = f.Enum("useFor", true, nil, useFor...)
	in.wasteReason, _ = f.Enum("wasteReason", true, nil, wasteWhy...)
	in.request, _ = f.Str("clientRequestId", valid.S{Opt: true, Trim: true, Min: 8, Max: 64})
	in.hostel = optionalIDIn(f, "hostelId")
	in.kind, _ = f.Enum("kind", false, nil, entryKinds...)
	if list, ok := f.Array("lines", false, false); ok {
		for i, raw := range list {
			path := "lines." + strconv.Itoa(i)
			m, isObj := raw.(map[string]any)
			if !isObj {
				f.Is.Add(path, valid.Type("object", valid.Received(raw, false)))
				continue
			}
			sub := &valid.Form{M: m}
			line := lineIn{amount: optionalInt(sub, "amount", 0, amountMax, false)}
			id, present := m["itemId"]
			s, isStr := id.(string)
			switch {
			case !present || !isStr:
				sub.Is.Add("itemId", valid.Type("string", valid.Received(id, !present)))
			case !objectIDRe.MatchString(s):
				sub.Is.Add("itemId", "Invalid id.")
			}
			line.item = s
			line.packQty = parseQty(sub, "packQty", true, false)
			if q := parseQty(sub, "qty", false, false); q != nil {
				line.qty = *q
			}
			if r, ok := sub.Num("rate", valid.N{Opt: true, Min: valid.P(0), Max: valid.P(amountMax)}); ok {
				line.rate = &r
			}
			f.Join(path, sub)
			in.lines = append(in.lines, line)
		}
		f.Size("lines", len(list), 1, linesMax, "Add at least one item.", false)
	}
	in.note, _ = f.Str("note", valid.S{Opt: true, Trim: true, Max: 200})
	if v, ok := f.M["on"]; ok {
		s, isStr := v.(string)
		if !isStr {
			f.Hard = true
			f.Is.Add("on", valid.Type("string", valid.Received(v, false)))
		} else if !dayRe.MatchString(s) {
			f.Is.Add("on", "Date must be YYYY-MM-DD.")
		}
		in.on = s
	}
	cash := "CASH"
	in.paidBy, _ = f.Enum("paidBy", false, &cash, paidBy...)
	in.photo = optionalIDIn(f, "photoAssetId")
	in.supplier, _ = f.Str("supplier", valid.S{Opt: true, Trim: true, Max: 80})
	in.to = optionalIDIn(f, "toHostelId")
	if err := f.Err(); err != nil {
		return nil, err
	}
	if in.kind == "SEND" && in.to == "" {
		f.Is.Add("toHostelId", "Pick where it goes.")
	}
	if in.kind != "BUY" && (in.amount != nil || in.paid != nil) {
		f.Is.Add("amount", "Only Bought has an amount.")
	}
	if in.kind == "WASTE" && in.wasteReason == "" {
		f.Is.Add("wasteReason", "Say why it was thrown away.")
	}
	if in.kind != "COUNT" {
		for _, l := range in.lines {
			if l.qty <= 0 {
				f.Is.Add("lines", "Write how much of each item.")
				break
			}
		}
	}
	return in, f.Err()
}

func (a *Admin) byRequestStore(ctx context.Context, s *storeActor, key string) (*entry, error) {
	return a.byRequest(ctx, &actor{group: s.group, userID: s.p.UserID}, key)
}

func (a *Admin) userName(ctx context.Context, id string) string {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return ""
	}
	var row struct {
		Name string `bson:"name"`
	}
	_ = a.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: oid}}).Decode(&row)
	return row.Name
}

func lineSummary(lines []line, prefix string) string {
	parts := make([]string, len(lines))
	for i, l := range lines {
		parts[i] = l.Name + " " + formatQty(l.Qty, l.Unit)
	}
	text := prefix + strings.Join(parts, ", ")
	if utf8.RuneCountInString(text) > whatMax {
		return string([]rune(text)[:whatMax-1]) + "…"
	}
	return text
}

func (a *Admin) notifyMany(ctx context.Context, users []string, title, body, hostel, entryID string, waits bool) {
	kind := "NORMAL"
	if waits {
		kind = "ACTION"
	}
	seen := map[string]bool{}
	for _, u := range users {
		if seen[u] {
			continue
		}
		seen[u] = true
		_, _ = a.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/hostel-admin/stock", Body: body, Category: "STOCK", Data: ordered.Map{{Key: "entryId", Value: entryID}, {Key: "type", Value: "STOCK"}}, HostelID: hostel, Kind: kind, Title: title, UserID: u})
	}
}

// receiversOf is receivers(hostel, permission): the owner, then the wardens holding it.
func (a *Admin) receiversOf(ctx context.Context, hostel string, permission string, except string) []string {
	id, err := bson.ObjectIDFromHex(hostel)
	if err != nil {
		return nil
	}
	var row struct {
		Owner *bson.ObjectID `bson:"ownerId"`
	}
	_ = a.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&row)
	cur, err := a.DB.Collection("hostelmembers").Find(ctx, bson.D{{Key: "hostelId", Value: id}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "permissions", Value: bson.D{{Key: "$in", Value: authz.GrantingPermissionKeys(authz.Capability(permission))}}}, {Key: "role", Value: "WARDEN"}, {Key: "status", Value: "ACTIVE"}})
	if err != nil {
		return nil
	}
	var wardens []struct {
		UserID bson.ObjectID `bson:"userId"`
	}
	if cur.All(ctx, &wardens) != nil {
		return nil
	}
	out := []string{}
	if row.Owner != nil && row.Owner.Hex() != except {
		out = append(out, row.Owner.Hex())
	}
	for _, w := range wardens {
		if w.UserID.Hex() != except {
			out = append(out, w.UserID.Hex())
		}
	}
	return out
}

func (a *Admin) warnLow(ctx context.Context, s *storeActor, hostel string, items []item, before, after map[bson.ObjectID]float64, entryID string) {
	crossed := []*item{}
	for i := range items {
		x := &items[i]
		was, ok1 := before[x.ID]
		now, ok2 := after[x.ID]
		if x.Kind == "STORE" && x.LowAt != nil && ok1 && ok2 && was >= *x.LowAt && now < *x.LowAt {
			crossed = append(crossed, x)
		}
	}
	if len(crossed) == 0 {
		return
	}
	title := "Stock running low"
	if len(crossed) == 1 {
		title = crossed[0].Name + " is running low"
	}
	parts := make([]string, len(crossed))
	for i, x := range crossed {
		parts[i] = x.Name + ": " + formatQty(math.Max(0, after[x.ID]), x.Unit) + " left"
	}
	place := "the hostel"
	for _, x := range s.places {
		if x.ID == hostel {
			place = x.Name
		}
	}
	a.notifyMany(ctx, a.receiversOf(ctx, hostel, "manageStock", ""), title, strings.Join(parts, ", ")+" in "+place+". Buy more soon.", hostel, entryID, false)
}

func (a *Admin) adminCreate(c *gin.Context) {
	s, err := a.staffStore(c, false)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, err := parseEntry(body)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, duplicate, err := a.createEntry(c, s, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if duplicate {
		httpx.OK(c, out, "Already saved")
		return
	}
	httpx.Write(c, 201, out, "Saved")
}

func (a *Admin) createEntry(ctx context.Context, s *storeActor, in *entryIn) (ordered.Map, bool, error) {
	if e, err := a.byRequestStore(ctx, s, in.request); err != nil {
		return nil, false, err
	} else if e != nil {
		return serializeStore(s, e), true, nil
	}
	if s.overall {
		return nil, false, fail(422, "OVERALL_READ_ONLY", "Overall only shows. Pick a building to add stock.")
	}
	main := ""
	for _, x := range s.places {
		if x.IsMain {
			main = x.ID
		}
	}
	hostel := in.hostel
	if hostel == "" {
		switch {
		case s.owner && in.kind == "BUY" && main != "" && s.isMine(main):
			hostel = main
		case s.isMine(s.active.Hex()):
			hostel = s.active.Hex()
		case len(s.mine) > 0:
			hostel = s.mine[0]
		}
	}
	if hostel == "" {
		return nil, false, fail(403, "CAPABILITY_DENIED", "You do not look after any building here.")
	}
	if !s.isMine(hostel) {
		return nil, false, fail(403, "CAPABILITY_DENIED", "You can only add stock for your own building.")
	}
	if in.kind == "OPENING" && !s.owner {
		return nil, false, fail(403, "CAPABILITY_DENIED", "Only the owner can add opening stock.")
	}
	to := ""
	if in.kind == "SEND" {
		known := false
		for _, x := range s.places {
			known = known || x.ID == in.to
		}
		if in.to == "" || in.to == hostel || !known {
			return nil, false, fail(422, "INVALID_DESTINATION", "Pick another building of this hostel to send to.")
		}
		to = in.to
	}
	on, err := expenses.ParseSpentOn(in.on, time.Now())
	if err != nil {
		return nil, false, err
	}
	ids := bson.A{}
	for _, l := range in.lines {
		id, _ := bson.ObjectIDFromHex(l.item)
		ids = append(ids, id)
	}
	incoming := in.kind == "BUY" || in.kind == "OPENING"
	coll := a.DB.Collection("stockitems")
	if incoming {
		if _, err := coll.UpdateMany(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "active", Value: false}, {Key: "groupHostelId", Value: s.group}}, bson.D{{Key: "$set", Value: bson.D{{Key: "active", Value: true}}}}); err != nil {
			return nil, false, err
		}
	}
	cur, err := coll.Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "active", Value: true}, {Key: "groupHostelId", Value: s.group}})
	if err != nil {
		return nil, false, err
	}
	var items []item
	if err := cur.All(ctx, &items); err != nil {
		return nil, false, err
	}
	byID := map[string]*item{}
	for i := range items {
		byID[items[i].ID.Hex()] = &items[i]
	}
	type mergedLine struct {
		id      string
		amount  *float64
		packQty *float64
		qty     float64
		rate    *float64
	}
	order := []*mergedLine{}
	seen := map[string]*mergedLine{}
	for _, l := range in.lines {
		key := strings.ToLower(l.item)
		x := byID[key]
		if x == nil {
			return nil, false, fail(404, "ITEM_NOT_FOUND", "One of the items is not there any more. Pick again.")
		}
		if x.Kind == "DAILY" && (in.kind == "COUNT" || in.kind == "USE" || in.kind == "WASTE") {
			word := "entered again"
			if in.kind == "COUNT" {
				word = "counted"
			}
			return nil, false, fail(422, "DAILY_NOT_TRACKED", x.Name+" is a daily item. It is used the day it comes, so it is not "+word+".")
		}
		inPacks := l.packQty != nil && x.PackUnit != nil && *x.PackUnit != "" && x.PackSize != nil && *x.PackSize != 0
		qty := l.qty
		if inPacks {
			qty = *l.packQty * *x.PackSize
		}
		prev := seen[key]
		if in.kind == "COUNT" || prev == nil {
			m := &mergedLine{id: key, amount: l.amount, qty: qty, rate: l.rate}
			if inPacks {
				m.packQty = l.packQty
			}
			if prev == nil {
				order = append(order, m)
			} else {
				*prev = *m
				m = prev
			}
			seen[key] = m
			continue
		}
		if prev.amount != nil || l.amount != nil {
			sum := zeroOr(prev.amount) + zeroOr(l.amount)
			prev.amount = &sum
		}
		if prev.packQty != nil && inPacks {
			sum := *prev.packQty + *l.packQty
			prev.packQty = &sum
		} else {
			prev.packQty = nil
		}
		prev.qty += qty
		if l.rate != nil {
			prev.rate = l.rate
		}
	}
	needsBook := in.kind == "COUNT" || in.kind == "USE" || in.kind == "WASTE" || in.kind == "SEND"
	hostelID, _ := bson.ObjectIDFromHex(hostel)
	var bookLeft map[bson.ObjectID]float64
	if needsBook {
		_, docs, kinds, err := a.readAll(ctx, s)
		if err != nil {
			return nil, false, err
		}
		current, _ := bs.CurrentPeriod(time.Now())
		f := foldStock(docs, kinds, []bson.ObjectID{hostelID}, current, current)
		bookLeft = map[bson.ObjectID]float64{}
		for id := range kinds {
			bookLeft[id] = f.figures(id, hostelID).Left
		}
	}
	lines := make([]line, len(order))
	docLines := bson.A{}
	differs := false
	for i, m := range order {
		x := byID[m.id]
		qty := roundQty(m.qty)
		var rate *float64
		if s.rights.Money && incoming {
			if m.amount != nil && qty > 0 {
				v := jsRound(*m.amount/qty*100) / 100
				rate = &v
			} else {
				rate = m.rate
			}
		}
		var packUnit *string
		if m.packQty != nil {
			packUnit = x.PackUnit
		}
		var system *float64
		if in.kind == "COUNT" {
			v := roundQty(bookLeft[x.ID])
			system = &v
			differs = differs || qty != v
		}
		lines[i] = line{ItemID: x.ID, Name: x.Name, PackQty: m.packQty, PackUnit: packUnit, Qty: qty, Rate: rate, SystemQty: system, Unit: x.Unit}
		docLines = append(docLines, bson.D{{Key: "itemId", Value: x.ID}, {Key: "name", Value: x.Name}, {Key: "packQty", Value: numOrNil(m.packQty)}, {Key: "packUnit", Value: ptrAny(packUnit)}, {Key: "qty", Value: qty}, {Key: "rate", Value: numOrNil(rate)}, {Key: "receivedQty", Value: nil}, {Key: "systemQty", Value: numOrNil(system)}, {Key: "unit", Value: x.Unit}})
	}
	status := "DONE"
	if in.kind == "SEND" {
		status = "PENDING"
	}
	if in.kind == "COUNT" {
		if differs && in.note == "" {
			return nil, false, fail(422, "COUNT_REASON_REQUIRED", "The count is different from the book. Say why.")
		}
		if differs && !s.rights.CanApprove {
			status = "PENDING"
		}
	}
	var supplierRow *supplierDoc
	if in.supplierID != "" && in.kind == "BUY" {
		id, _ := bson.ObjectIDFromHex(in.supplierID)
		var row supplierDoc
		err := a.DB.Collection("stocksuppliers").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "groupHostelId", Value: s.group}}).Decode(&row)
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, false, fail(404, "SUPPLIER_NOT_FOUND", "That supplier is not in the list any more.")
		}
		if err != nil {
			return nil, false, err
		}
		supplierRow = &row
	}
	supplier := ""
	if in.kind == "BUY" {
		supplier = in.supplier
		if supplierRow != nil {
			supplier = supplierRow.Name
		}
	}
	var total, paid *float64
	var expenseID *bson.ObjectID
	if in.kind == "BUY" {
		var subtotal float64
		for _, m := range order {
			if m.amount != nil {
				subtotal += *m.amount
			} else if m.rate != nil {
				subtotal += jsRound(*m.rate * m.qty)
			}
		}
		gross := subtotal
		if gross <= 0 {
			gross = zeroOr(in.amount)
		}
		discount, tax := zeroOr(in.discount), zeroOr(in.tax)
		if gross > 0 || discount > 0 || tax > 0 {
			if !s.rights.CanSpend {
				return nil, false, fail(403, "CAPABILITY_DENIED", "Your account cannot add prices. Leave the prices empty, or ask the owner to turn on Add expenses.")
			}
			if discount > gross+tax {
				return nil, false, fail(422, "INVALID_DISCOUNT", "The discount is more than the bill.")
			}
			t := gross - discount + tax
			p := t
			if in.paid != nil {
				p = math.Min(*in.paid, t)
			}
			total, paid = &t, &p
			if p < t && supplierRow == nil {
				return nil, false, fail(422, "SUPPLIER_REQUIRED", "Pick the supplier you still owe.")
			}
		}
		if paid != nil && *paid > 0 {
			category := "GROCERIES"
			if len(order) > 0 {
				if c := byID[order[0].id].Category; c != nil {
					category = *c
				}
			}
			prefix := supplier
			if in.billNo != "" {
				if prefix != "" {
					prefix += " · "
				}
				prefix += "bill " + in.billNo
			}
			if prefix != "" {
				prefix += ": "
			}
			request := ""
			if in.request != "" {
				request = "stock:" + in.request
				if len(request) > 64 {
					request = request[:64]
				}
			}
			out, _, err := a.Expenses.Create(ctx, a.Expenses.ActorFor(s.p, s.active, s.owner), expenses.NewInput(int64(*paid), category, request, in.paidBy, in.photo, in.on, lineSummary(lines, prefix)))
			if err != nil {
				return nil, false, err
			}
			v, _ := out.Get("id")
			id, _ := bson.ObjectIDFromHex(v.(string))
			expenseID = &id
		}
	}
	me, err := httpx.OID(s.p.UserID, "user id")
	if err != nil {
		return nil, false, err
	}
	name := a.userName(ctx, s.p.UserID)
	now := time.Now().UTC().Truncate(time.Millisecond)
	role := "WARDEN"
	if s.owner {
		role = "OWNER"
	}
	id := bson.NewObjectID()
	var amountVal, toVal, supplierIDVal, photoVal, useForVal, wasteVal, requestVal, expenseVal any
	discount, tax := 0.0, 0.0
	if expenseID != nil {
		amountVal, expenseVal = *paid, *expenseID
	}
	if in.kind == "BUY" && total != nil {
		discount, tax = zeroOr(in.discount), zeroOr(in.tax)
	}
	if to != "" {
		toID, _ := bson.ObjectIDFromHex(to)
		toVal = toID
	}
	if supplierRow != nil {
		supplierIDVal = supplierRow.ID
	}
	if in.kind == "BUY" && in.photo != "" {
		pid, _ := bson.ObjectIDFromHex(in.photo)
		photoVal = pid
	}
	if in.kind == "USE" {
		useForVal = in.useFor
		if in.useFor == "" {
			useForVal = "KITCHEN"
		}
	}
	if in.kind == "WASTE" {
		wasteVal = in.wasteReason
		if in.wasteReason == "" {
			wasteVal = "OTHER"
		}
	}
	if in.request != "" {
		requestVal = in.request
	}
	doc := bson.D{{Key: "_id", Value: id}, {Key: "amount", Value: amountVal}}
	if status == "DONE" && in.kind == "COUNT" {
		doc = append(doc, bson.E{Key: "approvedAt", Value: now}, bson.E{Key: "approvedBy", Value: me}, bson.E{Key: "approvedByName", Value: name})
	}
	if in.kind == "BUY" && in.billNo != "" {
		doc = append(doc, bson.E{Key: "billNo", Value: in.billNo})
	}
	doc = append(doc, bson.E{Key: "clientRequestId", Value: requestVal}, bson.E{Key: "discount", Value: discount}, bson.E{Key: "expenseId", Value: expenseVal}, bson.E{Key: "groupHostelId", Value: s.group}, bson.E{Key: "hostelId", Value: hostelID}, bson.E{Key: "kind", Value: in.kind}, bson.E{Key: "lines", Value: docLines})
	if in.note != "" {
		doc = append(doc, bson.E{Key: "note", Value: in.note})
	}
	doc = append(doc, bson.E{Key: "on", Value: on}, bson.E{Key: "paid", Value: numOrNil(paid)}, bson.E{Key: "photoAssetId", Value: photoVal}, bson.E{Key: "recordedBy", Value: me}, bson.E{Key: "recordedByName", Value: name}, bson.E{Key: "recordedRole", Value: role}, bson.E{Key: "status", Value: status})
	if supplier != "" {
		doc = append(doc, bson.E{Key: "supplier", Value: supplier})
	}
	doc = append(doc, bson.E{Key: "supplierId", Value: supplierIDVal}, bson.E{Key: "tax", Value: tax}, bson.E{Key: "toHostelId", Value: toVal}, bson.E{Key: "total", Value: numOrNil(total)}, bson.E{Key: "useFor", Value: useForVal}, bson.E{Key: "wasteReason", Value: wasteVal}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := a.DB.Collection("stockentries").InsertOne(ctx, doc); err != nil {
		if mongo.IsDuplicateKeyError(err) {
			if e, rerr := a.byRequestStore(ctx, s, in.request); rerr == nil && e != nil {
				return serializeStore(s, e), true, nil
			}
		}
		return nil, false, err
	}
	entryID := id.Hex()
	if to != "" {
		from := "the other building"
		for _, x := range s.places {
			if x.ID == hostel {
				from = x.Name
			}
		}
		a.notifyMany(ctx, a.receiversOf(ctx, to, "manageStock", s.p.UserID), "Stock on the way", lineSummary(lines, "")+" from "+from+". Tap Got it when it comes.", to, entryID, true)
	}
	if in.kind == "COUNT" && status == "PENDING" {
		who := name
		if who == "" {
			who = "Staff"
		}
		plural := "s"
		if len(lines) == 1 {
			plural = ""
		}
		a.notifyMany(ctx, a.receiversOf(ctx, hostel, "approveStockCount", s.p.UserID), "Count to approve", who+" counted "+strconv.Itoa(len(lines))+" item"+plural+". Some are different from the book.", hostel, entryID, true)
	}
	if bookLeft != nil && (status == "DONE" || in.kind == "SEND") {
		after := map[bson.ObjectID]float64{}
		for k, v := range bookLeft {
			after[k] = v
		}
		for _, l := range lines {
			if in.kind == "COUNT" {
				after[l.ItemID] = l.Qty
			} else {
				after[l.ItemID] = bookLeft[l.ItemID] - l.Qty
			}
		}
		a.warnLow(ctx, s, hostel, items, bookLeft, after, entryID)
	}
	if to != "" {
		a.changed(ctx, hostel, to)
	} else {
		a.changed(ctx, hostel)
	}
	var e entry
	if err := a.DB.Collection("stockentries").FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&e); err != nil {
		return nil, false, err
	}
	return serializeStore(s, &e), false, nil
}

func (a *Admin) findEntry(ctx context.Context, s *storeActor, raw, kind string) (*entry, bson.ObjectID, error) {
	id, err := bson.ObjectIDFromHex(raw)
	if err != nil {
		return nil, id, fail(404, "ENTRY_NOT_FOUND", "Not found.")
	}
	filter := bson.D{{Key: "_id", Value: id}, {Key: "groupHostelId", Value: s.group}}
	if kind != "" {
		filter = append(filter, bson.E{Key: "kind", Value: kind})
	}
	var e entry
	err = a.DB.Collection("stockentries").FindOne(ctx, filter).Decode(&e)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, id, nil
	}
	if err != nil {
		return nil, id, err
	}
	return &e, id, nil
}

func (a *Admin) receive(c *gin.Context) {
	s, err := a.staffStore(c, false)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	got := map[string]float64{}
	if body, berr := valid.Body(c); berr == nil {
		f := valid.NewForm(body)
		if list, ok := f.Array("lines", true, false); ok {
			f.Size("lines", len(list), 0, linesMax, "", false)
			for i, raw := range list {
				sub := valid.NewForm(raw)
				id := optionalIDIn(sub, "itemId")
				if !sub.Present("itemId") {
					sub.Is.Add("itemId", valid.Type("string", "undefined"))
				}
				if q := parseQty(sub, "receivedQty", false, false); q != nil {
					got[strings.ToLower(id)] = roundQty(*q)
				}
				f.Join("lines."+strconv.Itoa(i), sub)
			}
		}
		if err := f.Err(); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	e, id, err := a.findEntry(c, s, c.Param("id"), "SEND")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if e == nil || e.ToHostelID == nil || !s.isMine(e.ToHostelID.Hex()) {
		httpx.Fail(c, fail(404, "ENTRY_NOT_FOUND", "Not found."))
		return
	}
	answered := fail(409, "ENTRY_NOT_PENDING", "This was already answered.")
	if e.Status != "PENDING" {
		httpx.Fail(c, answered)
		return
	}
	lines := append([]line{}, e.Lines...)
	docLines := bson.A{}
	short := []line{}
	for i := range lines {
		q := lines[i].Qty
		if v, ok := got[lines[i].ItemID.Hex()]; ok {
			q = v
		}
		lines[i].ReceivedQ = &q
		l := lines[i]
		docLines = append(docLines, bson.D{{Key: "itemId", Value: l.ItemID}, {Key: "name", Value: l.Name}, {Key: "packQty", Value: numOrNil(l.PackQty)}, {Key: "packUnit", Value: ptrAny(l.PackUnit)}, {Key: "qty", Value: l.Qty}, {Key: "rate", Value: numOrNil(l.Rate)}, {Key: "receivedQty", Value: q}, {Key: "systemQty", Value: numOrNil(l.SystemQty)}, {Key: "unit", Value: l.Unit}})
		if q < l.Qty {
			short = append(short, l)
		}
	}
	me, err := httpx.OID(s.p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	var updated entry
	err = a.DB.Collection("stockentries").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}, {Key: "status", Value: "PENDING"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "lines", Value: docLines}, {Key: "receivedAt", Value: now}, {Key: "receivedBy", Value: me}, {Key: "receivedByName", Value: a.userName(c, s.p.UserID)}, {Key: "status", Value: "RECEIVED"}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&updated)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, answered)
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	a.Notify.SettleAction(c, "STOCK", bson.D{{Key: "entryId", Value: c.Param("id")}}, "GOT_IT")
	if updated.RecordedBy.Hex() != s.p.UserID {
		place := a.storePlaceName(s, e.ToHostelID.Hex(), "The branch")
		title, body := "Stock received", place+" got "+lineSummary(lines, "")+"."
		if len(short) > 0 {
			parts := make([]string, len(short))
			for i, l := range short {
				parts[i] = formatQty(*l.ReceivedQ, l.Unit) + " of " + formatQty(l.Qty, l.Unit) + " " + l.Name
			}
			title, body = "Less stock came", place+" got "+strings.Join(parts, ", ")+"."
		}
		a.notifyMany(c, []string{updated.RecordedBy.Hex()}, title, body, e.HostelID.Hex(), id.Hex(), false)
	}
	a.changed(c, e.HostelID.Hex(), e.ToHostelID.Hex())
	httpx.OK(c, serializeStore(s, &updated), "Got it")
}

func (a *Admin) storePlaceName(s *storeActor, id, fallback string) string {
	for _, x := range s.places {
		if x.ID == id {
			return x.Name
		}
	}
	return fallback
}

func (a *Admin) approve(c *gin.Context) {
	s, err := a.staffStore(c, false)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	e, id, err := a.findEntry(c, s, c.Param("id"), "COUNT")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if e == nil {
		httpx.Fail(c, fail(404, "ENTRY_NOT_FOUND", "Not found."))
		return
	}
	answered := fail(409, "ENTRY_NOT_PENDING", "This was already answered.")
	if e.Status != "PENDING" {
		httpx.Fail(c, answered)
		return
	}
	if v, _ := serializeStore(s, e).Get("canApprove"); v != true {
		httpx.Fail(c, fail(403, "CAPABILITY_DENIED", "You cannot approve this count."))
		return
	}
	items, docs, kinds, err := a.readAll(c, s)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	current, _ := bs.CurrentPeriod(time.Now())
	f := foldStock(docs, kinds, []bson.ObjectID{e.HostelID}, current, current)
	before, after := map[bson.ObjectID]float64{}, map[bson.ObjectID]float64{}
	for k := range kinds {
		before[k] = f.figures(k, e.HostelID).Left
		after[k] = before[k]
	}
	me, err := httpx.OID(s.p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	name := a.userName(c, s.p.UserID)
	now := time.Now().UTC().Truncate(time.Millisecond)
	var updated entry
	err = a.DB.Collection("stockentries").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}, {Key: "status", Value: "PENDING"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "approvedAt", Value: now}, {Key: "approvedBy", Value: me}, {Key: "approvedByName", Value: name}, {Key: "status", Value: "DONE"}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&updated)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, answered)
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	touched := []item{}
	for _, l := range e.Lines {
		sys := l.Qty
		if l.SystemQty != nil {
			sys = *l.SystemQty
		}
		after[l.ItemID] = before[l.ItemID] + l.Qty - sys
		for i := range items {
			if items[i].ID == l.ItemID {
				touched = append(touched, items[i])
			}
		}
	}
	hostel := e.HostelID.Hex()
	a.Notify.SettleAction(c, "STOCK", bson.D{{Key: "entryId", Value: c.Param("id")}}, "APPROVED")
	who := name
	if who == "" {
		who = "The owner"
	}
	a.notifyMany(c, []string{e.RecordedBy.Hex()}, "Count approved", who+" approved your count.", hostel, c.Param("id"), false)
	a.warnLow(c, s, hostel, touched, before, after, c.Param("id"))
	a.changed(c, hostel)
	httpx.OK(c, serializeStore(s, &updated), "Count approved")
}

func readReason(c *gin.Context) (string, error) {
	body, err := valid.Body(c)
	if err != nil {
		return "", err
	}
	f := valid.NewForm(body)
	reason, _ := f.Str("reason", valid.S{Trim: true, Min: 3, Max: 300})
	return reason, f.Err()
}

func (a *Admin) voidLinked(ctx context.Context, s *storeActor, hostel bson.ObjectID, expense bson.ObjectID, reason string) error {
	_, err := a.Expenses.Void(ctx, a.Expenses.ActorFor(s.p, hostel, s.owner), expense.Hex(), reason)
	var he *httpx.Error
	if errors.As(err, &he) && he.ErrorCode == "EXPENSE_ALREADY_VOID" {
		return nil
	}
	return err
}

func (a *Admin) cancel(c *gin.Context) {
	s, err := a.staffStore(c, false)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	reason, err := readReason(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	e, id, err := a.findEntry(c, s, c.Param("id"), "")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cannot := false
	if e != nil {
		v, _ := serializeStore(s, e).Get("canCancel")
		cannot = v != true
	}
	if e == nil || cannot {
		httpx.Fail(c, fail(404, "ENTRY_NOT_CANCELLABLE", "You cannot cancel this."))
		return
	}
	if e.ExpenseID != nil {
		var row struct {
			HostelID bson.ObjectID `bson:"hostelId"`
		}
		err := a.DB.Collection("expenses").FindOne(c, bson.D{{Key: "_id", Value: *e.ExpenseID}}).Decode(&row)
		if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
			httpx.Fail(c, err)
			return
		}
		if err == nil {
			if err := a.voidLinked(c, s, row.HostelID, *e.ExpenseID, reason); err != nil {
				httpx.Fail(c, err)
				return
			}
		}
	}
	me, err := httpx.OID(s.p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	var updated entry
	err = a.DB.Collection("stockentries").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "CANCELLED"}}}}, bson.D{{Key: "$set", Value: bson.D{{Key: "cancelReason", Value: reason}, {Key: "cancelledAt", Value: now}, {Key: "cancelledBy", Value: me}, {Key: "status", Value: "CANCELLED"}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&updated)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, fail(409, "ENTRY_NOT_CANCELLABLE", "This is already cancelled."))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	a.Notify.SettleAction(c, "STOCK", bson.D{{Key: "entryId", Value: id.Hex()}}, "CANCEL")
	if e.Kind == "COUNT" && e.Status == "PENDING" && e.RecordedBy.Hex() != s.p.UserID {
		a.notifyMany(c, []string{e.RecordedBy.Hex()}, "Count not approved", reason, e.HostelID.Hex(), id.Hex(), false)
	}
	if e.ToHostelID != nil {
		a.changed(c, e.HostelID.Hex(), e.ToHostelID.Hex())
	} else {
		a.changed(c, e.HostelID.Hex())
	}
	httpx.OK(c, serializeStore(s, &updated), "Cancelled")
}

func serializeItem(x *item) ordered.Map {
	cat, location := "GROCERIES", ""
	if x.Category != nil {
		cat = *x.Category
	}
	if x.Location != nil {
		location = *x.Location
	}
	return ordered.Map{{Key: "active", Value: x.Active}, {Key: "category", Value: cat}, {Key: "id", Value: x.ID.Hex()}, {Key: "kind", Value: x.Kind}, {Key: "location", Value: location}, {Key: "lowAt", Value: numOrNil(x.LowAt)}, {Key: "name", Value: x.Name},
		{Key: "packSize", Value: numOrNil(x.PackSize)}, {Key: "packUnit", Value: ptrAny(x.PackUnit)}, {Key: "unit", Value: x.Unit}}
}

func (a *Admin) nameTaken(ctx context.Context, coll string, group bson.ObjectID, name string, except *bson.ObjectID) (bool, error) {
	filter := bson.D{{Key: "groupHostelId", Value: group}, {Key: "name", Value: bson.Regex{Pattern: "^" + regexp.QuoteMeta(name) + "$", Options: "i"}}}
	if except != nil {
		filter = append(filter, bson.E{Key: "_id", Value: bson.D{{Key: "$ne", Value: *except}}})
	}
	n, err := a.DB.Collection(coll).CountDocuments(ctx, filter, options.Count().SetLimit(1))
	return n > 0, err
}

// nullableNum is `.nullable().optional()` over a number.
func nullableNum(f *valid.Form, key string, min, max float64, positive bool, msg string) (*float64, bool) {
	v, present := f.M[key]
	if !present {
		return nil, false
	}
	if v == nil {
		return nil, true
	}
	n, ok := v.(float64)
	if !ok {
		if msg != "" {
			f.Is.Add(key, msg)
		} else {
			f.Is.Add(key, valid.Type("number", valid.Received(v, false)))
		}
		return nil, true
	}
	if positive && n <= 0 {
		f.Is.Add(key, valid.TooSmall("number", 0, false))
	} else if !positive && n < min {
		if msg != "" {
			f.Is.Add(key, msg)
		} else {
			f.Is.Add(key, valid.TooSmall("number", min, true))
		}
	}
	if n > max {
		if msg != "" {
			f.Is.Add(key, "That is too much. Check it.")
		} else {
			f.Is.Add(key, valid.TooBig("number", max, true))
		}
	}
	return &n, true
}

func nullableEnum(f *valid.Form, key string, values ...string) (*string, bool) {
	v, present := f.M[key]
	if !present {
		return nil, false
	}
	if v == nil {
		return nil, true
	}
	s, _ := f.Enum(key, false, nil, values...)
	return &s, true
}

func packOf(size *float64, unit *string, base string) (any, any) {
	if unit == nil || *unit == "" || size == nil || *size == 0 || *unit == base {
		return nil, nil
	}
	return *size, *unit
}

func (a *Admin) addItem(c *gin.Context) {
	s, err := a.staffStore(c, false)
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
	category, hasCat := f.Enum("category", true, nil, stockCats...)
	kind, _ := f.Enum("kind", false, nil, stockKinds...)
	lowAt, _ := nullableNum(f, "lowAt", 0, qtyMax, false, "Write how much.")
	name, _ := f.Str("name", valid.S{Trim: true, Min: 1, MinMsg: "Name it.", Max: itemNameMax})
	unit, _ := f.Enum("unit", false, nil, stockUnits...)
	location, hasLocation := f.Str("location", valid.S{Opt: true, Trim: true, Max: 40})
	size, _ := nullableNum(f, "packSize", 0, qtyMax, true, "")
	packUnit, _ := nullableEnum(f, "packUnit", stockUnits...)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	coll := a.DB.Collection("stockitems")
	count, err := coll.CountDocuments(c, bson.D{{Key: "groupHostelId", Value: s.group}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if count >= itemLimit {
		httpx.Fail(c, fail(422, "ITEM_LIMIT", "The list is full. Switch off an item you no longer buy."))
		return
	}
	if taken, err := a.nameTaken(c, "stockitems", s.group, name, nil); err != nil {
		httpx.Fail(c, err)
		return
	} else if taken {
		httpx.Fail(c, fail(409, "ITEM_NAME_TAKEN", name+" is already in the list."))
		return
	}
	me, err := httpx.OID(s.p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if !hasCat {
		category = "GROCERIES"
		if kind == "DAILY" {
			category = "VEGETABLES_MEAT"
		}
	}
	var low any
	if kind == "STORE" {
		low = numOrNil(lowAt)
	}
	ps, pu := packOf(size, packUnit, unit)
	now := time.Now().UTC().Truncate(time.Millisecond)
	id := bson.NewObjectID()
	doc := bson.D{{Key: "_id", Value: id}, {Key: "category", Value: category}, {Key: "createdBy", Value: me}, {Key: "groupHostelId", Value: s.group}, {Key: "kind", Value: kind}}
	if hasLocation {
		doc = append(doc, bson.E{Key: "location", Value: location})
	}
	doc = append(doc, bson.E{Key: "lowAt", Value: low}, bson.E{Key: "name", Value: name}, bson.E{Key: "unit", Value: unit}, bson.E{Key: "packSize", Value: ps}, bson.E{Key: "packUnit", Value: pu}, bson.E{Key: "active", Value: true}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := coll.InsertOne(c, doc); err != nil {
		httpx.Fail(c, err)
		return
	}
	a.changed(c, s.mine...)
	var x item
	if err := coll.FindOne(c, bson.D{{Key: "_id", Value: id}}).Decode(&x); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, 201, serializeItem(&x), "Item added")
}

func (a *Admin) editItem(c *gin.Context) {
	s, err := a.staffStore(c, false)
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
	active, hasActive := f.Bool("active", true, nil)
	category, hasCat := f.Enum("category", true, nil, stockCats...)
	kind, hasKind := f.Enum("kind", true, nil, stockKinds...)
	lowAt, hasLow := nullableNum(f, "lowAt", 0, qtyMax, false, "Write how much.")
	name, hasName := f.Str("name", valid.S{Opt: true, Trim: true, Min: 1, Max: itemNameMax})
	unit, hasUnit := f.Enum("unit", true, nil, stockUnits...)
	location, hasLocation := f.Str("location", valid.S{Opt: true, Trim: true, Max: 40})
	size, hasSize := nullableNum(f, "packSize", 0, qtyMax, true, "")
	packUnit, hasPack := nullableEnum(f, "packUnit", stockUnits...)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	if !hasActive && !hasCat && !hasKind && !hasLow && !hasName && !hasUnit && !hasLocation && !hasSize && !hasPack {
		f.Is.Add("", "Nothing to change.")
		httpx.Fail(c, f.Err())
		return
	}
	if !s.owner {
		httpx.Fail(c, fail(403, "CAPABILITY_DENIED", "Only the owner can change an item."))
		return
	}
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		httpx.Fail(c, fail(404, "ITEM_NOT_FOUND", "Item not found."))
		return
	}
	coll := a.DB.Collection("stockitems")
	var x item
	err = coll.FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "groupHostelId", Value: s.group}}).Decode(&x)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, fail(404, "ITEM_NOT_FOUND", "Item not found."))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if hasName && name != "" && !strings.EqualFold(name, x.Name) {
		if taken, err := a.nameTaken(c, "stockitems", s.group, name, &id); err != nil {
			httpx.Fail(c, err)
			return
		} else if taken {
			httpx.Fail(c, fail(409, "ITEM_NAME_TAKEN", name+" is already in the list."))
			return
		}
	}
	if hasUnit && unit != x.Unit {
		n, err := a.DB.Collection("stockentries").CountDocuments(c, bson.D{{Key: "groupHostelId", Value: s.group}, {Key: "lines.itemId", Value: id}}, options.Count().SetLimit(1))
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		if n > 0 {
			httpx.Fail(c, fail(409, "UNIT_IN_USE", "Stock was already entered in this unit. Add a new item for the new unit."))
			return
		}
	}
	set := bson.D{{Key: "updatedAt", Value: time.Now().UTC().Truncate(time.Millisecond)}}
	add := func(has bool, key string, v any) {
		if has {
			set = append(set, bson.E{Key: key, Value: v})
		}
	}
	add(hasActive, "active", active)
	add(hasCat, "category", category)
	add(hasKind, "kind", kind)
	finalKind := x.Kind
	if hasKind {
		finalKind = kind
	}
	if finalKind == "DAILY" {
		add(true, "lowAt", nil)
	} else {
		add(hasLow, "lowAt", numOrNil(lowAt))
	}
	add(hasName, "name", name)
	add(hasUnit, "unit", unit)
	add(hasLocation, "location", location)
	if hasSize || hasPack {
		base := x.Unit
		if hasUnit {
			base = unit
		}
		useSize, usePack := x.PackSize, x.PackUnit
		if hasSize {
			useSize = size
		}
		if hasPack {
			usePack = packUnit
		}
		ps, pu := packOf(useSize, usePack, base)
		add(true, "packSize", ps)
		add(true, "packUnit", pu)
	}
	var updated item
	if err := coll.FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: set}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&updated); err != nil {
		httpx.Fail(c, err)
		return
	}
	a.changed(c, s.mine...)
	httpx.OK(c, serializeItem(&updated), "Item saved")
}

func serializeSupplier(s *storeActor, x *supplierDoc) ordered.Map {
	var opening any
	if s.rights.Money {
		opening = x.OpeningDue
	}
	return ordered.Map{{Key: "active", Value: x.Active}, {Key: "id", Value: x.ID.Hex()}, {Key: "name", Value: x.Name}, {Key: "note", Value: x.Note}, {Key: "openingDue", Value: opening}, {Key: "phone", Value: x.Phone}}
}

func (a *Admin) addSupplier(c *gin.Context) {
	s, err := a.staffStore(c, false)
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
	name, _ := f.Str("name", valid.S{Trim: true, Min: 1, MinMsg: "Name the shop.", Max: supplierMax})
	note, hasNote := f.Str("note", valid.S{Opt: true, Trim: true, Max: 200})
	opening := optionalInt(f, "openingDue", -amountMax, amountMax, false)
	phone, hasPhone := f.Str("phone", valid.S{Opt: true, Trim: true, Max: 20})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	coll := a.DB.Collection("stocksuppliers")
	count, err := coll.CountDocuments(c, bson.D{{Key: "groupHostelId", Value: s.group}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if count >= supplierLimit {
		httpx.Fail(c, fail(422, "SUPPLIER_LIMIT", "The list is full. Switch off a supplier you no longer use."))
		return
	}
	if taken, err := a.nameTaken(c, "stocksuppliers", s.group, name, nil); err != nil {
		httpx.Fail(c, err)
		return
	} else if taken {
		httpx.Fail(c, fail(409, "SUPPLIER_NAME_TAKEN", name+" is already in the list."))
		return
	}
	me, err := httpx.OID(s.p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	due := 0.0
	if s.rights.Money {
		due = zeroOr(opening)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	row := supplierDoc{ID: bson.NewObjectID(), Active: true, CreatedAt: now, Name: name, OpeningDue: due}
	doc := bson.D{{Key: "_id", Value: row.ID}, {Key: "createdBy", Value: me}, {Key: "groupHostelId", Value: s.group}, {Key: "name", Value: name}}
	if hasNote {
		row.Note = note
		doc = append(doc, bson.E{Key: "note", Value: note})
	}
	doc = append(doc, bson.E{Key: "openingDue", Value: due})
	if hasPhone {
		row.Phone = phone
		doc = append(doc, bson.E{Key: "phone", Value: phone})
	}
	doc = append(doc, bson.E{Key: "active", Value: true}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := coll.InsertOne(c, doc); err != nil {
		httpx.Fail(c, err)
		return
	}
	a.changed(c, s.mine...)
	httpx.Write(c, 201, serializeSupplier(s, &row), "Supplier added")
}

func (a *Admin) findSupplier(c *gin.Context, s *storeActor) (*supplierDoc, error) {
	if !s.rights.Money {
		return nil, fail(403, "CAPABILITY_DENIED", "Only the owner, or staff who can add expenses, see suppliers' money.")
	}
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		return nil, fail(404, "SUPPLIER_NOT_FOUND", "Supplier not found.")
	}
	var row supplierDoc
	err = a.DB.Collection("stocksuppliers").FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "groupHostelId", Value: s.group}}).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, fail(404, "SUPPLIER_NOT_FOUND", "Supplier not found.")
	}
	return &row, err
}

func (a *Admin) editSupplier(c *gin.Context) {
	s, err := a.staffStore(c, false)
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
	name, hasName := f.Str("name", valid.S{Opt: true, Trim: true, Min: 1, MinMsg: "Name the shop.", Max: supplierMax})
	note, hasNote := f.Str("note", valid.S{Opt: true, Trim: true, Max: 200})
	opening := optionalInt(f, "openingDue", -amountMax, amountMax, false)
	phone, hasPhone := f.Str("phone", valid.S{Opt: true, Trim: true, Max: 20})
	active, hasActive := f.Bool("active", true, nil)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	if !hasName && !hasNote && opening == nil && !hasPhone && !hasActive {
		f.Is.Add("", "Nothing to change.")
		httpx.Fail(c, f.Err())
		return
	}
	row, err := a.findSupplier(c, s)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if hasName && name != "" && !strings.EqualFold(name, row.Name) {
		if taken, err := a.nameTaken(c, "stocksuppliers", s.group, name, &row.ID); err != nil {
			httpx.Fail(c, err)
			return
		} else if taken {
			httpx.Fail(c, fail(409, "SUPPLIER_NAME_TAKEN", name+" is already in the list."))
			return
		}
	}
	if opening != nil && !s.owner {
		httpx.Fail(c, fail(403, "CAPABILITY_DENIED", "Only the owner can change what was owed before."))
		return
	}
	set := bson.D{{Key: "updatedAt", Value: time.Now().UTC().Truncate(time.Millisecond)}}
	if hasName {
		set = append(set, bson.E{Key: "name", Value: name})
	}
	if hasNote {
		set = append(set, bson.E{Key: "note", Value: note})
	}
	if opening != nil {
		set = append(set, bson.E{Key: "openingDue", Value: *opening})
	}
	if hasPhone {
		set = append(set, bson.E{Key: "phone", Value: phone})
	}
	if hasActive {
		set = append(set, bson.E{Key: "active", Value: active})
	}
	var updated supplierDoc
	if err := a.DB.Collection("stocksuppliers").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: row.ID}}, bson.D{{Key: "$set", Value: set}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&updated); err != nil {
		httpx.Fail(c, err)
		return
	}
	a.changed(c, s.mine...)
	httpx.OK(c, serializeSupplier(s, &updated), "Supplier saved")
}

func (a *Admin) supplier(c *gin.Context) {
	s, err := a.staffStore(c, false)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	row, err := a.findSupplier(c, s)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err := a.DB.Collection("stockentries").Find(c, bson.D{{Key: "groupHostelId", Value: s.group}, {Key: "kind", Value: "BUY"}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "CANCELLED"}}}, {Key: "supplierId", Value: row.ID}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var bills []entry
	if err := cur.All(c, &bills); err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err = a.DB.Collection("stockpayments").Find(c, bson.D{{Key: "groupHostelId", Value: s.group}, {Key: "status", Value: "DONE"}, {Key: "supplierId", Value: row.ID}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var pays []paymentDoc
	if err := cur.All(c, &pays); err != nil {
		httpx.Fail(c, err)
		return
	}
	billsByID, paysByID := map[string]*entry{}, map[string]*paymentDoc{}
	lb := make([]ledgerBill, len(bills))
	for i := range bills {
		e := &bills[i]
		billsByID[e.ID.Hex()] = e
		paid, total, _ := billMoney(e)
		lb[i] = ledgerBill{createdAt: e.CreatedAt, id: e.ID.Hex(), on: e.On, paid: paid, status: e.Status, total: total}
	}
	lp := make([]ledgerPayment, len(pays))
	for i := range pays {
		x := &pays[i]
		paysByID[x.ID.Hex()] = x
		lp[i] = ledgerPayment{amount: x.Amount, createdAt: x.CreatedAt, id: x.ID.Hex(), on: x.On, status: x.Status}
	}
	ledger := supplierLedger(row.OpeningDue, lb, lp, row.CreatedAt)
	rows := make([]ordered.Map, len(ledger.rows))
	for i := len(ledger.rows) - 1; i >= 0; i-- {
		r := ledger.rows[i]
		var bill, payment any
		if e := billsByID[r.id]; r.kind == "BILL" && e != nil {
			paid, total, _ := billMoney(e)
			names := make([]string, len(e.Lines))
			for j, l := range e.Lines {
				names[j] = l.Name
			}
			no := ""
			if e.BillNo != nil {
				no = *e.BillNo
			}
			bill = ordered.Map{{Key: "billNo", Value: no}, {Key: "items", Value: strings.Join(names, ", ")}, {Key: "paid", Value: paid}, {Key: "status", Value: billStatus(total, paid)}, {Key: "total", Value: total}}
		}
		if x := paysByID[r.id]; r.kind == "PAYMENT" && x != nil {
			by, method := x.ByName, x.PaidBy
			if by == "" {
				by = "Staff"
			}
			if method == "" {
				method = "CASH"
			}
			payment = ordered.Map{{Key: "amount", Value: x.Amount}, {Key: "canCancel", Value: !s.overall && (s.owner || x.RecordedBy.Hex() == s.p.UserID)}, {Key: "note", Value: x.Note}, {Key: "paidBy", Value: method}, {Key: "recordedByName", Value: by}}
		}
		rows[len(ledger.rows)-1-i] = ordered.Map{{Key: "balance", Value: r.balance}, {Key: "bill", Value: bill}, {Key: "change", Value: r.change}, {Key: "id", Value: r.id}, {Key: "kind", Value: r.kind}, {Key: "on", Value: dayKey(r.on)}, {Key: "payment", Value: payment}}
	}
	httpx.Write(c, 200, ordered.Map{{Key: "billed", Value: ledger.billed}, {Key: "due", Value: ledger.due}, {Key: "paid", Value: ledger.paid}, {Key: "rows", Value: rows}, {Key: "supplier", Value: serializeSupplier(s, row)}}, "Supplier loaded")
}

func (a *Admin) pay(c *gin.Context) {
	s, err := a.staffStore(c, false)
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
	var amount float64
	if v, present := f.M["amount"]; present {
		n, ok := v.(float64)
		switch {
		case !ok:
			f.Hard = true
			f.Is.Add("amount", valid.Type("number", valid.Received(v, false)))
		case n != math.Trunc(n):
			f.Is.Add("amount", "Whole rupees.")
		case n <= 0:
			f.Is.Add("amount", "Write the amount.")
		case n > amountMax:
			f.Is.Add("amount", valid.TooBig("number", amountMax, true))
		default:
			amount = n
		}
	} else {
		f.Hard = true
		f.Is.Add("amount", valid.Type("number", "undefined"))
	}
	request, _ := f.Str("clientRequestId", valid.S{Opt: true, Trim: true, Min: 8, Max: 64})
	entryIDs := bson.A{}
	if list, ok := f.Array("entryIds", true, false); ok {
		f.Size("entryIds", len(list), 0, 50, "", false)
		for i, raw := range list {
			s, isStr := raw.(string)
			if !isStr || !objectIDRe.MatchString(s) {
				f.Is.Add("entryIds."+strconv.Itoa(i), "Invalid id.")
				continue
			}
			id, _ := bson.ObjectIDFromHex(s)
			entryIDs = append(entryIDs, id)
		}
	}
	note, hasNote := f.Str("note", valid.S{Opt: true, Trim: true, Max: 200})
	on := ""
	if v, ok := f.M["on"]; ok {
		str, isStr := v.(string)
		if !isStr || !dayRe.MatchString(str) {
			f.Is.Add("on", "Date must be YYYY-MM-DD.")
		}
		on = str
	}
	cash := "CASH"
	method, _ := f.Enum("paidBy", false, &cash, paidBy...)
	photo := optionalIDIn(f, "photoAssetId")
	supplierRaw := optionalIDIn(f, "supplierId")
	if !f.Present("supplierId") {
		f.Is.Add("supplierId", valid.Type("string", "undefined"))
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	if !s.rights.CanSpend {
		httpx.Fail(c, fail(403, "CAPABILITY_DENIED", "Your account cannot add expenses. Ask the owner to turn on Add expenses."))
		return
	}
	if s.overall {
		httpx.Fail(c, fail(422, "OVERALL_READ_ONLY", "Overall only shows. Pick the building you paid from."))
		return
	}
	me, err := httpx.OID(s.p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	coll := a.DB.Collection("stockpayments")
	answer := func(x *paymentDoc, duplicate bool) {
		out := ordered.Map{{Key: "amount", Value: x.Amount}, {Key: "id", Value: x.ID.Hex()}}
		if duplicate {
			httpx.OK(c, out, "Already saved")
			return
		}
		httpx.Write(c, 201, out, "Paid")
	}
	byKey := func() (*paymentDoc, error) {
		var row paymentDoc
		err := coll.FindOne(c, bson.D{{Key: "clientRequestId", Value: request}, {Key: "recordedBy", Value: me}}).Decode(&row)
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil
		}
		return &row, err
	}
	if request != "" {
		row, err := byKey()
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		if row != nil {
			answer(row, true)
			return
		}
	}
	supplierID, _ := bson.ObjectIDFromHex(supplierRaw)
	var supplier supplierDoc
	err = a.DB.Collection("stocksuppliers").FindOne(c, bson.D{{Key: "_id", Value: supplierID}, {Key: "groupHostelId", Value: s.group}}).Decode(&supplier)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, fail(404, "SUPPLIER_NOT_FOUND", "Supplier not found."))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	category := "GROCERIES"
	var last entry
	err = a.DB.Collection("stockentries").FindOne(c, bson.D{{Key: "groupHostelId", Value: s.group}, {Key: "kind", Value: "BUY"}, {Key: "supplierId", Value: supplier.ID}}, options.FindOne().SetSort(bson.D{{Key: "on", Value: -1}})).Decode(&last)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, err)
		return
	}
	if err == nil && len(last.Lines) > 0 {
		var row struct {
			Category *string `bson:"category"`
		}
		if a.DB.Collection("stockitems").FindOne(c, bson.D{{Key: "_id", Value: last.Lines[0].ItemID}}).Decode(&row) == nil && row.Category != nil {
			category = *row.Category
		}
	}
	what := "Paid " + supplier.Name
	if note != "" {
		what += " · " + note
	}
	if utf8.RuneCountInString(what) > whatMax {
		what = string([]rune(what)[:whatMax])
	}
	key := ""
	if request != "" {
		key = "stockpay:" + request
		if len(key) > 64 {
			key = key[:64]
		}
	}
	made, _, err := a.Expenses.Create(c, a.Expenses.ActorFor(s.p, s.active, s.owner), expenses.NewInput(int64(amount), category, key, method, photo, on, what))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	v, _ := made.Get("id")
	expenseID, _ := bson.ObjectIDFromHex(v.(string))
	day, err := expenses.ParseSpentOn(on, time.Now())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	row := paymentDoc{ID: bson.NewObjectID(), Amount: amount}
	var requestVal any
	if request != "" {
		requestVal = request
	}
	doc := bson.D{{Key: "_id", Value: row.ID}, {Key: "amount", Value: amount}, {Key: "clientRequestId", Value: requestVal}, {Key: "entryIds", Value: entryIDs}, {Key: "expenseId", Value: expenseID}, {Key: "groupHostelId", Value: s.group}, {Key: "hostelId", Value: s.active}}
	if hasNote {
		doc = append(doc, bson.E{Key: "note", Value: note})
	}
	doc = append(doc, bson.E{Key: "on", Value: day}, bson.E{Key: "paidBy", Value: method}, bson.E{Key: "recordedBy", Value: me}, bson.E{Key: "recordedByName", Value: a.userName(c, s.p.UserID)}, bson.E{Key: "supplierId", Value: supplier.ID}, bson.E{Key: "status", Value: "DONE"}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := coll.InsertOne(c, doc); err != nil {
		if mongo.IsDuplicateKeyError(err) && request != "" {
			if raced, rerr := byKey(); rerr == nil && raced != nil {
				answer(raced, true)
				return
			}
		}
		httpx.Fail(c, err)
		return
	}
	a.changed(c, s.mine...)
	answer(&row, false)
}

func (a *Admin) cancelPay(c *gin.Context) {
	s, err := a.staffStore(c, false)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	reason, err := readReason(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	missing := fail(404, "PAYMENT_NOT_FOUND", "Not found.")
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		httpx.Fail(c, missing)
		return
	}
	coll := a.DB.Collection("stockpayments")
	var x paymentDoc
	err = coll.FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "groupHostelId", Value: s.group}}).Decode(&x)
	if errors.Is(err, mongo.ErrNoDocuments) || (err == nil && x.Status == "CANCELLED") {
		httpx.Fail(c, missing)
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if s.overall || !(s.owner || x.RecordedBy.Hex() == s.p.UserID) {
		httpx.Fail(c, fail(403, "CAPABILITY_DENIED", "You cannot cancel this payment."))
		return
	}
	if x.ExpenseID != nil {
		if err := a.voidLinked(c, s, x.HostelID, *x.ExpenseID, reason); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	me, err := httpx.OID(s.p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := coll.UpdateOne(c, bson.D{{Key: "_id", Value: id}, {Key: "status", Value: "DONE"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "cancelReason", Value: reason}, {Key: "cancelledAt", Value: now}, {Key: "cancelledBy", Value: me}, {Key: "status", Value: "CANCELLED"}, {Key: "updatedAt", Value: now}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	a.changed(c, s.mine...)
	httpx.OK(c, ordered.Map{{Key: "id", Value: id.Hex()}, {Key: "status", Value: "CANCELLED"}}, "Cancelled")
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
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	s, err := a.resolveStore(c, p, false)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if !s.owner || s.overall {
		httpx.Fail(c, fail(403, "CAPABILITY_DENIED", "Only the owner can change this, for one building at a time."))
		return
	}
	me, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := a.DB.Collection("hostelsettings").UpdateOne(c, bson.D{{Key: "hostelId", Value: s.active}}, bson.D{{Key: "$set", Value: bson.D{{Key: "cookCanUseStock", Value: enabled}, {Key: "updatedBy", Value: me}, {Key: "updatedAt", Value: now}}},
		{Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}}, options.UpdateOne().SetUpsert(true)); err != nil {
		httpx.Fail(c, err)
		return
	}
	message := "The kitchen can no longer enter stock"
	if enabled {
		message = "The kitchen can enter stock used"
	}
	httpx.OK(c, ordered.Map{{Key: "stockEnabled", Value: enabled}}, message)
}

func addDays(key string, days int) string {
	t, _ := time.Parse("2006-01-02", key)
	return t.AddDate(0, 0, days).Format("2006-01-02")
}

func (a *Admin) usage(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "manageStock")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	rng := valid.QueryEnum(q, "range", &is, "today", "week", "month")
	every := scopeAll(q, &is)
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	name := "today"
	if rng != nil {
		name = *rng
	}
	cachedOr(a, c, p, every, "stock-usage", "Usage loaded", func() (ordered.Map, error) {
		s, err := a.resolveStore(c, p, every)
		if err != nil {
			return nil, err
		}
		now := time.Now()
		to := dayKey(bs.Today(now))
		from := to
		switch name {
		case "week":
			from = addDays(to, -6)
		case "month":
			current, _ := bs.CurrentPeriod(now)
			bounds, err := bs.PeriodBounds(current)
			if err != nil {
				return nil, err
			}
			from = dayKey(bounds.Start)
		}
		items, docs, kinds, err := a.readAll(c, s)
		if err != nil {
			return nil, err
		}
		current, _ := bs.CurrentPeriod(now)
		f := foldStock(docs, kinds, s.mineIDs, current, current)
		usage := make([]usageEntry, len(docs))
		for i := range docs {
			e := &docs[i]
			usage[i] = usageEntry{byCook: e.RecordedRole != nil && *e.RecordedRole == "COOK", day: dayKey(e.On), hostel: e.HostelID, kind: e.Kind, status: e.Status, lines: e.Lines}
			if e.ToHostelID != nil {
				usage[i].toHost, usage[i].hasTo = *e.ToHostelID, true
			}
		}
		rows := usageRows(usage, kinds, s.mineIDs, from, to)
		used := map[bson.ObjectID]bool{}
		for _, r := range rows {
			used[r.Item] = true
		}
		money := s.rights.Money
		days := []string{}
		for d := to; d >= from; d = addDays(d, -1) {
			days = append(days, d)
		}
		itemsOut := []ordered.Map{}
		for i := range items {
			x := &items[i]
			if !used[x.ID] {
				continue
			}
			var avg any
			if money {
				avg = numOrNil(f.avgCost(x.ID))
			}
			itemsOut = append(itemsOut, ordered.Map{{Key: "avgCost", Value: avg}, {Key: "id", Value: x.ID.Hex()}, {Key: "kind", Value: x.Kind}, {Key: "name", Value: x.Name}, {Key: "unit", Value: x.Unit}})
		}
		placesOut := []ordered.Map{}
		for _, x := range s.places {
			if s.isMine(x.ID) {
				placesOut = append(placesOut, ordered.Map{{Key: "id", Value: x.ID}, {Key: "name", Value: x.Name}})
			}
		}
		rowsOut := make([]ordered.Map, len(rows))
		var total float64
		for i, r := range rows {
			if c := f.avgCost(r.Item); c != nil {
				total += (r.Used + r.Wasted) * *c
			}
			rowsOut[i] = ordered.Map{{Key: "byCook", Value: r.ByCook}, {Key: "day", Value: r.Day}, {Key: "hostelId", Value: r.Hostel.Hex()}, {Key: "itemId", Value: r.Item.Hex()}, {Key: "used", Value: r.Used}, {Key: "wasted", Value: r.Wasted}}
		}
		var value any
		if money {
			value = jsRound(total)
		}
		return ordered.Map{{Key: "days", Value: days}, {Key: "from", Value: from}, {Key: "items", Value: itemsOut}, {Key: "money", Value: money}, {Key: "places", Value: placesOut}, {Key: "range", Value: name}, {Key: "rows", Value: rowsOut}, {Key: "to", Value: to}, {Key: "value", Value: value}}, nil
	})
}

var (
	reportMonths = map[string]int{"month": 1, "quarter": 3, "year": 12}
	reportLabels = map[string]string{"month": "This month", "quarter": "Last 3 months", "year": "Last 1 year"}
)

// Report is getStockReport's facts, kept typed for the export.
type Report struct {
	Out    ordered.Map
	Rows   []ReportRow
	Label  string
	From   string
	To     string
	Next   string
	Scope  string
	Money  bool
	Bought float64
	NextV  float64
	HasTot bool
}

// ReportRow is one item's line of the report.
type ReportRow struct {
	Name, Unit, Category string
	Figs                 reportFigs
}

func (a *Admin) buildReport(ctx context.Context, s *storeActor, rng string) (*Report, error) {
	now := time.Now()
	to, _ := bs.CurrentPeriod(now)
	from, err := bs.AddMonths(to, -(reportMonths[rng] - 1))
	if err != nil {
		return nil, err
	}
	next, err := bs.AddMonths(to, 1)
	if err != nil {
		return nil, err
	}
	nextBounds, err := bs.PeriodBounds(next)
	if err != nil {
		return nil, err
	}
	fromBounds, err := bs.PeriodBounds(from)
	if err != nil {
		return nil, err
	}
	days := max(1, int(math.Floor(bs.Today(now).Sub(fromBounds.Start).Hours()/24))+1)
	money := s.rights.Money
	items, docs, kinds, err := a.readAll(ctx, s)
	if err != nil {
		return nil, err
	}
	f := foldStock(docs, kinds, s.mineIDs, from, to)
	var suppliers []supplierDoc
	if money {
		if suppliers, err = a.suppliersOf(ctx, s); err != nil {
			return nil, err
		}
	}
	var residentsTotal int64
	for _, id := range s.mineIDs {
		n, err := a.residentsAt(ctx, id)
		if err != nil {
			return nil, err
		}
		residentsTotal += n
	}
	var missing, stockValue float64
	type row struct {
		x    *item
		cat  string
		figs reportFigs
		avg  *float64
	}
	rows := []row{}
	for i := range items {
		x := &items[i]
		at := make([]atPlace, len(s.mineIDs))
		for j, id := range s.mineIDs {
			at[j] = f.figures(x.ID, id)
			missing += math.Max(0, -at[j].AdjustedValue)
		}
		avg := f.avgCost(x.ID)
		figs := reportFigures(at, x.Kind, avg, days, nextBounds.DaysInMonth)
		if x.Kind == "STORE" && avg != nil && figs.Left != nil {
			stockValue += math.Max(0, *figs.Left) * *avg
		}
		if !money {
			figs.BoughtValue, figs.NextValue, figs.UsedValue, figs.WastedValue = 0, nil, 0, 0
		}
		left := 0.0
		if figs.Left != nil {
			left = *figs.Left
		}
		if figs.Bought <= 0 && figs.Used <= 0 && figs.Wasted <= 0 && left == 0 {
			continue
		}
		cat := "GROCERIES"
		if x.Category != nil {
			cat = *x.Category
		}
		rows = append(rows, row{x, cat, figs, avg})
	}
	label := func(cat string) string {
		if l, ok := categoryLabels[cat]; ok {
			return l
		}
		return "Other"
	}
	sort.SliceStable(rows, func(i, j int) bool {
		li, lj := label(rows[i].cat), label(rows[j].cat)
		if li != lj {
			return strings.ToLower(li) < strings.ToLower(lj)
		}
		return strings.ToLower(rows[i].x.Name) < strings.ToLower(rows[j].x.Name)
	})
	var bought, usedV, wastedV, nextV float64
	itemsOut := make([]ordered.Map, len(rows))
	out := make([]ReportRow, len(rows))
	for i, r := range rows {
		bought += r.figs.BoughtValue
		usedV += r.figs.UsedValue
		wastedV += r.figs.WastedValue
		if r.figs.NextValue != nil {
			nextV += *r.figs.NextValue
		}
		var avg any
		if money {
			avg = numOrNil(r.avg)
		}
		itemsOut[i] = ordered.Map{{Key: "bought", Value: r.figs.Bought}, {Key: "boughtValue", Value: r.figs.BoughtValue}, {Key: "left", Value: numOrNil(r.figs.Left)}, {Key: "nextQty", Value: r.figs.NextQty}, {Key: "nextValue", Value: numOrNil(r.figs.NextValue)}, {Key: "used", Value: r.figs.Used},
			{Key: "usedValue", Value: r.figs.UsedValue}, {Key: "wasted", Value: r.figs.Wasted}, {Key: "wastedValue", Value: r.figs.WastedValue}, {Key: "avgCost", Value: avg}, {Key: "category", Value: r.cat}, {Key: "id", Value: r.x.ID.Hex()}, {Key: "kind", Value: r.x.Kind}, {Key: "name", Value: r.x.Name}, {Key: "unit", Value: r.x.Unit}}
		out[i] = ReportRow{r.x.Name, r.x.Unit, r.cat, r.figs}
	}
	inRange := []*entry{}
	for i := range docs {
		if p := periodOf(docs[i].On); p >= from && p <= to {
			inRange = append(inRange, &docs[i])
		}
	}
	bySupplier := []supplierTotal{}
	var costPer, totals any
	if money {
		bySupplier = boughtBySupplier(inRange, suppliers, s.isMine)
		if residentsTotal > 0 {
			costPer = jsRound((usedV + wastedV + missing) / (float64(residentsTotal) * float64(days)))
		}
		totals = ordered.Map{{Key: "boughtValue", Value: bought}, {Key: "missingValue", Value: jsRound(missing)}, {Key: "nextValue", Value: nextV}, {Key: "stockValue", Value: jsRound(stockValue)}, {Key: "usedValue", Value: usedV}, {Key: "wastedValue", Value: wastedV}}
	}
	scope := "All buildings"
	if !s.overall {
		scope = "Hostel"
		if len(s.mine) > 0 {
			scope = s.nameOf(s.mine[0])
		}
	}
	return &Report{Out: ordered.Map{{Key: "bySupplier", Value: bySupplier}, {Key: "costPerResidentDay", Value: costPer}, {Key: "days", Value: days}, {Key: "from", Value: from}, {Key: "items", Value: itemsOut}, {Key: "label", Value: reportLabels[rng]}, {Key: "money", Value: money}, {Key: "nextPeriod", Value: next},
		{Key: "range", Value: rng}, {Key: "residents", Value: residentsTotal}, {Key: "scope", Value: scope}, {Key: "to", Value: to}, {Key: "totals", Value: totals}},
		Rows: out, Label: reportLabels[rng], From: from, To: to, Next: next, Scope: scope, Money: money, Bought: bought, NextV: nextV, HasTot: money}, nil
}

var categoryLabels = map[string]string{"CLEANING": "Cleaning", "ELECTRICITY": "Electricity", "GAS": "Gas", "GROCERIES": "Groceries", "INTERNET": "Internet", "OTHER": "Other", "RENT": "Building rent", "REPAIR": "Repair", "SALARY": "Salary", "STAFF_CASH": "Cash to warden", "VEGETABLES_MEAT": "Vegetables & meat", "WATER": "Water"}

// exportReport is stockReportExport + reportExportResponse.
func (a *Admin) exportReport(c *gin.Context, r *Report, format string) {
	next := bs.FormatPeriod(r.Next)
	cols := []export.Column{{Key: "name", Label: "Item"}, {Key: "unit", Label: "Unit"}, {Key: "bought", Label: "Bought"}}
	if r.Money {
		cols = append(cols, export.Column{Key: "boughtValue", Label: "Bought (Rs)"})
	}
	cols = append(cols, export.Column{Key: "used", Label: "Used"}, export.Column{Key: "wasted", Label: "Wasted"}, export.Column{Key: "left", Label: "Left"}, export.Column{Key: "nextQty", Label: next + " (expected)"})
	if r.Money {
		cols = append(cols, export.Column{Key: "nextValue", Label: next + " (Rs)"})
	}
	rows := make([]map[string]any, 0, len(r.Rows)+1)
	for _, x := range r.Rows {
		var left, nextValue any = "", ""
		if x.Figs.Left != nil {
			left = *x.Figs.Left
		}
		if x.Figs.NextValue != nil {
			nextValue = *x.Figs.NextValue
		}
		unit := strings.ToLower(x.Unit)
		if l, ok := unitLabels[x.Unit]; ok {
			unit = l[1]
		}
		rows = append(rows, map[string]any{"name": x.Name, "unit": unit, "bought": x.Figs.Bought, "boughtValue": x.Figs.BoughtValue, "used": x.Figs.Used, "wasted": x.Figs.Wasted, "left": left, "nextQty": x.Figs.NextQty, "nextValue": nextValue})
	}
	if r.HasTot {
		rows = append(rows, map[string]any{"boughtValue": r.Bought, "name": "Total", "nextValue": r.NextV})
	}
	months := bs.FormatPeriod(r.To)
	if r.From != r.To {
		months = bs.FormatPeriod(r.From) + " – " + bs.FormatPeriod(r.To)
	}
	report := export.Report{Columns: cols, Rows: rows, FilenamePrefix: "stock-report", Period: r.Label + " · " + months + " · " + r.Scope}
	if err := export.WriteReport(c.Writer, report, format, r.Scope, time.Now()); err != nil {
		httpx.Fail(c, err)
	}
}

func (a *Admin) report(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "manageStock")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	format := valid.QueryEnum(q, "format", &is, "csv", "pdf")
	rng := valid.QueryEnum(q, "range", &is, "month", "quarter", "year")
	every := scopeAll(q, &is)
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	name := "month"
	if rng != nil {
		name = *rng
	}
	if format != nil {
		s, err := a.resolveStore(c, p, every)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		r, err := a.buildReport(c, s, name)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		a.exportReport(c, r, *format)
		return
	}
	cachedOr(a, c, p, every, "stock-report", "Report loaded", func() (ordered.Map, error) {
		s, err := a.resolveStore(c, p, every)
		if err != nil {
			return nil, err
		}
		r, err := a.buildReport(c, s, name)
		if err != nil {
			return nil, err
		}
		return r.Out, nil
	})
}
