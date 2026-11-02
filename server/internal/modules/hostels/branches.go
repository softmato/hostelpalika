package hostels

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

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/files"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/plans"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

const overallSlug = "overall"

func branchErr(status int, code, message string) error {
	return httpx.NewError(status, code, message, nil)
}

func openFirst() error { return branchErr(422, "HOSTEL_SCOPE_REQUIRED", "Open a hostel first.") }

// mainHostelOf is the route's own helper: the caller's open hostel, or its main hostel.
func (a *Admin) mainHostelOf(ctx context.Context, p *authz.Principal) (string, error) {
	if len(p.HostelIDs) == 0 || p.HostelIDs[0] == "" {
		return "", openFirst()
	}
	id, err := httpx.OID(p.HostelIDs[0], "hostel id")
	if err != nil {
		return "", err
	}
	main, err := a.billingHostel(ctx, id)
	return main.Hex(), err
}

func (a *Admin) billingHostel(ctx context.Context, id bson.ObjectID) (bson.ObjectID, error) {
	var h struct {
		Parent *bson.ObjectID `bson:"parentHostelId"`
	}
	err := a.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: id}}, options.FindOne().SetProjection(bson.D{{Key: "parentHostelId", Value: 1}})).Decode(&h)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return id, err
	}
	if h.Parent != nil {
		return *h.Parent, nil
	}
	return id, nil
}

type allowanceOut struct {
	Active   bool  `json:"active"`
	Cap      int   `json:"cap"`
	PlanName any   `json:"planName"`
	Used     int64 `json:"used"`
}

// planCap is getPlan(plans, id)?.maxBranches ?? 0.
func (a *Admin) planCap(ctx context.Context, planID string) (cap int, name string, err error) {
	raw, err := a.Config.Section(ctx, "plans")
	if err != nil {
		return 0, "", err
	}
	var catalog plans.Catalog
	if err := platformconfig.Decode(raw, &catalog); err != nil {
		return 0, "", err
	}
	if p := plans.GetPlan(catalog, planID); p != nil {
		return p.MaxBranches, p.Name, nil
	}
	return 0, "", nil
}

func (a *Admin) countBranches(ctx context.Context, main bson.ObjectID) (int64, error) {
	return a.DB.Collection("hostels").CountDocuments(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "parentHostelId", Value: main}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "REJECTED"}}}})
}

// allowance is getBranchAllowance.
func (a *Admin) allowance(ctx context.Context, main bson.ObjectID) (allowanceOut, error) {
	state, err := a.Billing.State(ctx, main)
	if err != nil {
		return allowanceOut{}, err
	}
	out := allowanceOut{PlanName: nil}
	if state != nil {
		out.Active = state.Subscription.Status == "ACTIVE"
		out.PlanName = state.Subscription.PlanName
		if id, ok := state.Subscription.PlanID.(string); ok && id != "" {
			if out.Cap, _, err = a.planCap(ctx, id); err != nil {
				return out, err
			}
		}
	}
	out.Used, err = a.countBranches(ctx, main)
	return out, err
}

func coverOf(raw bson.Raw) any {
	if photos, ok := raw.Lookup("photos").ArrayOK(); ok {
		if u := ExteriorPhoto(bson.Raw(photos)); u != nil {
			return *u
		}
	}
	return nil
}

func strField(raw bson.Raw, path ...string) string { return rawStr(raw.Lookup(path...), "") }

type branchRow struct {
	Area      string `json:"area"`
	City      string `json:"city"`
	CoverURL  any    `json:"coverUrl"`
	CreatedAt any    `json:"createdAt"`
	ID        string `json:"id"`
	Name      string `json:"name"`
	Slug      string `json:"slug"`
	Status    string `json:"status"`
}

type mainRow struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Slug      string `json:"slug"`
	Status    string `json:"status"`
	Area      string `json:"area"`
	City      string `json:"city"`
	CoverURL  any    `json:"coverUrl"`
	PanNumber any    `json:"panNumber"`
}

type branchListOut struct {
	Allowance allowanceOut `json:"allowance"`
	Branches  []branchRow  `json:"branches"`
	Main      mainRow      `json:"main"`
}

func (a *Admin) branchList(c *gin.Context) {
	p := authz.From(c)
	mainID, err := a.mainHostelOf(c, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	main, err := ResolveOwned(c, a.DB, mainID, p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err := a.DB.Collection("hostels").Find(c, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "parentHostelId", Value: main.ID}},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: 1}}).SetLimit(200).SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "slug", Value: 1}, {Key: "status", Value: 1},
			{Key: "location.area", Value: 1}, {Key: "location.city", Value: 1}, {Key: "photos.kind", Value: 1}, {Key: "photos.url", Value: 1}, {Key: "createdAt", Value: 1}}))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []bson.Raw
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	allowance, err := a.allowance(c, main.ID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var pan bson.Raw
	err = a.DB.Collection("hostels").FindOne(c, bson.D{{Key: "_id", Value: main.ID}}, options.FindOne().SetProjection(bson.D{{Key: "panNumber", Value: 1}, {Key: "location", Value: 1}, {Key: "photos.kind", Value: 1}, {Key: "photos.url", Value: 1}})).Decode(&pan)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, err)
		return
	}
	out := branchListOut{Allowance: allowance, Branches: []branchRow{}}
	for _, r := range rows {
		id, _ := r.Lookup("_id").ObjectIDOK()
		out.Branches = append(out.Branches, branchRow{strField(r, "location", "area"), strField(r, "location", "city"), coverOf(r), rawDate(r.Lookup("createdAt")), id.Hex(),
			strField(r, "name"), strField(r, "slug"), strField(r, "status")})
	}
	var panOut any
	if s, ok := pan.Lookup("panNumber").StringValueOK(); ok {
		panOut = s
	}
	out.Main = mainRow{main.ID.Hex(), main.Name, main.Slug, main.Status, strField(pan, "location", "area"), strField(pan, "location", "city"), coverOf(pan), panOut}
	httpx.OK(c, out, "Branches loaded")
}

func (a *Admin) branchDetails(c *gin.Context) {
	p := authz.From(c)
	if len(p.HostelIDs) == 0 || p.HostelIDs[0] == "" {
		httpx.Fail(c, openFirst())
		return
	}
	mainID, err := a.mainHostelOf(c, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	main, err := ResolveOwned(c, a.DB, mainID, p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	notFound := branchErr(404, "HOSTEL_NOT_FOUND", "Branch not found.")
	branchID, err := bson.ObjectIDFromHex(c.Param("branchId"))
	if err != nil {
		httpx.Fail(c, notFound)
		return
	}
	var h bson.Raw
	err = a.DB.Collection("hostels").FindOne(c, bson.D{{Key: "_id", Value: branchID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
		{Key: "$or", Value: bson.A{bson.D{{Key: "_id", Value: main.ID}}, bson.D{{Key: "parentHostelId", Value: main.ID}}}}}).Decode(&h)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, notFound)
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	dcur, err := a.DB.Collection("hosteldocuments").Find(c, bson.D{{Key: "hostelId", Value: branchID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
		options.Find().SetProjection(bson.D{{Key: "documentType", Value: 1}, {Key: "status", Value: 1}, {Key: "rejectionReason", Value: 1}}).SetLimit(100))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var docs []bson.Raw
	if err := dcur.All(c, &docs); err != nil {
		httpx.Fail(c, err)
		return
	}
	saved := SerializeHostel(h, time.Now())
	photos := []any{}
	if arr, ok := h.Lookup("photos").ArrayOK(); ok {
		vals, _ := arr.Values()
		for _, pv := range vals {
			ph, ok := pv.DocumentOK()
			if !ok {
				continue
			}
			url := rawStr(ph.Lookup("url"), "")
			asset := rawID(ph.Lookup("fileAssetId"))
			if url == "" {
				if id, ok := asset.(string); ok {
					url = "/api/v1/files/" + id + "/url"
				}
			}
			photos = append(photos, ordered.Map{{Key: "alt", Value: rawStr(ph.Lookup("alt"), "")}, {Key: "fileAssetId", Value: asset}, {Key: "id", Value: rawID(ph.Lookup("_id"))},
				{Key: "kind", Value: rawStr(ph.Lookup("kind"), "INTERIOR")}, {Key: "mediumUrl", Value: rawStr(ph.Lookup("mediumUrl"), "")}, {Key: "roomType", Value: rawStr(ph.Lookup("roomType"), "")}, {Key: "url", Value: url}})
		}
	}
	rooms := []any{}
	if arr, ok := h.Lookup("roomConfigurations").ArrayOK(); ok {
		vals, _ := arr.Values()
		for _, rv := range vals {
			r, ok := rv.DocumentOK()
			if !ok {
				continue
			}
			rooms = append(rooms, ordered.Map{{Key: "roomType", Value: passRaw(r.Lookup("roomType"))}, {Key: "rooms", Value: passRaw(r.Lookup("rooms"))}, {Key: "bedsPerRoom", Value: passRaw(r.Lookup("bedsPerRoom"))},
				{Key: "vacantBeds", Value: passRaw(r.Lookup("vacantBeds"))}, {Key: "monthlyRent", Value: passRaw(r.Lookup("monthlyRent"))}, {Key: "securityDeposit", Value: passRaw(r.Lookup("securityDeposit"))},
				{Key: "mealInclusion", Value: passRaw(r.Lookup("mealInclusion"))}})
		}
	}
	saved = saved.Set("photos", photos)
	saved = saved.Set("yearEstablished", orStr(h.Lookup("yearEstablished")))
	saved = saved.Set("securityDeposit", passRaw(h.Lookup("securityDeposit")))
	saved = saved.Set("shortStays", passRaw(h.Lookup("shortStays")))
	saved = saved.Set("roomConfigurations", rooms)
	outDocs := []any{}
	for _, d := range docs {
		id, _ := d.Lookup("_id").ObjectIDOK()
		outDocs = append(outDocs, ordered.Map{{Key: "id", Value: id.Hex()}, {Key: "type", Value: passRaw(d.Lookup("documentType"))}, {Key: "status", Value: passRaw(d.Lookup("status"))},
			{Key: "rejectionReason", Value: rawStr(d.Lookup("rejectionReason"), "")}})
	}
	httpx.OK(c, ordered.Map{{Key: "hostel", Value: saved}, {Key: "main", Value: ordered.Map{{Key: "id", Value: main.ID.Hex()}, {Key: "name", Value: main.Name}, {Key: "slug", Value: main.Slug}}},
		{Key: "documents", Value: outDocs}}, "Branch details loaded")
}

// passRaw is `field` as lean + JSON.stringify writes it: absent stays absent.
func passRaw(v bson.RawValue) any {
	if v.Type == 0 {
		return ordered.Undefined
	}
	return ordered.FromBSON(v)
}

// orStr is `hostel.yearEstablished ?? ""`.
func orStr(v bson.RawValue) any {
	if v.Type == 0 || v.Type == bson.TypeNull {
		return ""
	}
	return ordered.FromBSON(v)
}

// ---- names ----

type nameRow struct {
	Area     string `json:"area"`
	City     string `json:"city"`
	CoverURL any    `json:"coverUrl"`
	ID       string `json:"id"`
	IsBranch bool   `json:"isBranch"`
	Name     string `json:"name"`
}

type namesOut struct {
	Current any       `json:"current"`
	Hostels []nameRow `json:"hostels"`
}

func (a *Admin) branchNames(c *gin.Context) {
	p := authz.From(c)
	all := p.AllHostelIDs
	if all == nil {
		all = p.HostelIDs
	}
	ids := objectIDs(all)
	var current any
	if len(p.HostelIDs) > 0 {
		current = p.HostelIDs[0]
	}
	if len(ids) == 0 {
		httpx.OK(c, namesOut{current, []nameRow{}}, "Branch names loaded")
		return
	}
	cur, err := a.DB.Collection("hostels").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "parentHostelId", Value: 1}}))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var own []struct {
		ID     bson.ObjectID  `bson:"_id"`
		Parent *bson.ObjectID `bson:"parentHostelId"`
	}
	if err := cur.All(c, &own); err != nil {
		httpx.Fail(c, err)
		return
	}
	groups := bson.A{}
	for _, h := range own {
		if h.Parent != nil {
			groups = append(groups, *h.Parent)
		} else {
			groups = append(groups, h.ID)
		}
	}
	hcur, err := a.DB.Collection("hostels").Find(c, bson.D{{Key: "$or", Value: bson.A{bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: groups}}}}, bson.D{{Key: "parentHostelId", Value: bson.D{{Key: "$in", Value: groups}}}}}},
		{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
		options.Find().SetSort(bson.D{{Key: "_id", Value: 1}}).SetLimit(500).SetProjection(bson.D{{Key: "location.area", Value: 1}, {Key: "location.city", Value: 1}, {Key: "name", Value: 1}, {Key: "parentHostelId", Value: 1},
			{Key: "photos.kind", Value: 1}, {Key: "photos.url", Value: 1}}))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []bson.Raw
	if err := hcur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	out := namesOut{current, []nameRow{}}
	for _, r := range rows {
		id, _ := r.Lookup("_id").ObjectIDOK()
		_, isBranch := r.Lookup("parentHostelId").ObjectIDOK()
		out.Hostels = append(out.Hostels, nameRow{strField(r, "location", "area"), strField(r, "location", "city"), coverOf(r), id.Hex(), isBranch, strField(r, "name")})
	}
	// Main hostel first, then branches in the order they were added.
	sort.SliceStable(out.Hostels, func(i, j int) bool { return !out.Hostels[i].IsBranch && out.Hostels[j].IsBranch })
	httpx.OK(c, out, "Branch names loaded")
}

// ---- summary ----

type summaryRow struct {
	Area             string  `json:"area"`
	City             string  `json:"city"`
	Beds             float64 `json:"beds"`
	Collected        int64   `json:"collected"`
	CoverURL         any     `json:"coverUrl"`
	Due              int64   `json:"due"`
	ID               string  `json:"id"`
	IsBranch         bool    `json:"isBranch"`
	Name             string  `json:"name"`
	OccupancyPercent any     `json:"occupancyPercent"`
	OpenComplaints   int64   `json:"openComplaints"`
	Residents        int64   `json:"residents"`
	Slug             string  `json:"slug"`
	Status           string  `json:"status"`
}

type summaryOut struct {
	Hostels []summaryRow `json:"hostels"`
	Period  string       `json:"period"`
}

// countsBy groups one count per hostel in a single aggregate.
func (a *Admin) countsBy(ctx context.Context, coll string, match bson.D) (map[bson.ObjectID]int64, error) {
	cur, err := a.DB.Collection(coll).Aggregate(ctx, bson.A{bson.D{{Key: "$match", Value: match}}, bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$hostelId"}, {Key: "n", Value: bson.D{{Key: "$sum", Value: 1}}}}}}})
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID bson.ObjectID `bson:"_id"`
		N  int64         `bson:"n"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := map[bson.ObjectID]int64{}
	for _, r := range rows {
		out[r.ID] = r.N
	}
	return out, nil
}

// totalsBy is collectionTotals per hostel for one period: the billed sum and the
// settled sum, voided invoices left out.
func (a *Admin) totalsBy(ctx context.Context, ids []bson.ObjectID, period string) (map[bson.ObjectID][2]int64, error) {
	settled := bson.D{{Key: "$ifNull", Value: bson.A{bson.D{{Key: "$arrayElemAt", Value: bson.A{"$balance.settledAmount", 0}}}, 0}}}
	group := bson.D{{Key: "_id", Value: "$hostelId"}, {Key: "dueAmount", Value: bson.D{{Key: "$sum", Value: "$totalAmount"}}}, {Key: "paidAmount", Value: bson.D{{Key: "$sum", Value: settled}}}}
	cur, err := a.DB.Collection("invoices").Aggregate(ctx, bson.A{
		bson.D{{Key: "$match", Value: bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "period", Value: period}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "VOID"}}}}}},
		bson.D{{Key: "$lookup", Value: bson.D{{Key: "as", Value: "balance"}, {Key: "foreignField", Value: "invoiceId"}, {Key: "from", Value: "invoicebalances"}, {Key: "localField", Value: "_id"}}}},
		bson.D{{Key: "$group", Value: group}},
	})
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID   bson.ObjectID `bson:"_id"`
		Due  int64         `bson:"dueAmount"`
		Paid int64         `bson:"paidAmount"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := map[bson.ObjectID][2]int64{}
	for _, r := range rows {
		out[r.ID] = [2]int64{r.Due, r.Paid}
	}
	return out, nil
}

func (a *Admin) branchSummary(c *gin.Context) {
	p := authz.From(c)
	all := p.AllHostelIDs
	if all == nil {
		all = p.HostelIDs
	}
	ids := objectIDs(all)
	period, err := bs.CurrentPeriod(time.Now())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if len(ids) == 0 {
		httpx.OK(c, summaryOut{[]summaryRow{}, period}, "Branches summary loaded")
		return
	}
	cur, err := a.DB.Collection("hostels").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
		options.Find().SetProjection(bson.D{{Key: "capacitySummary", Value: 1}, {Key: "location.area", Value: 1}, {Key: "location.city", Value: 1}, {Key: "name", Value: 1}, {Key: "parentHostelId", Value: 1},
			{Key: "photos.kind", Value: 1}, {Key: "photos.url", Value: 1}, {Key: "slug", Value: 1}, {Key: "status", Value: 1}}))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var hostels []bson.Raw
	if err := cur.All(c, &hostels); err != nil {
		httpx.Fail(c, err)
		return
	}
	found := make([]bson.ObjectID, 0, len(hostels))
	exterior := map[bson.ObjectID]any{}
	for _, h := range hostels {
		id, _ := h.Lookup("_id").ObjectIDOK()
		found = append(found, id)
		exterior[id] = coverOf(h)
	}
	residents, err := a.countsBy(c, "residents", bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: found}}}, {Key: "isDeleted", Value: false}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "MOVED_OUT"}}}})
	var complaints map[bson.ObjectID]int64
	var money map[bson.ObjectID][2]int64
	if err == nil {
		complaints, err = a.countsBy(c, "complaints", bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: found}}}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"PENDING", "IN_PROGRESS"}}}}})
	}
	if err == nil {
		money, err = a.totalsBy(c, found, period)
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rows := make([]summaryRow, 0, len(hostels))
	for _, h := range hostels {
		id, _ := h.Lookup("_id").ObjectIDOK()
		parent, isBranch := h.Lookup("parentHostelId").ObjectIDOK()
		beds := rawNum(h.Lookup("capacitySummary", "totalBeds"), 0)
		vacant := rawNum(h.Lookup("capacitySummary", "vacantBeds"), 0)
		var occupancy any
		if beds > 0 {
			occupancy = math.Floor((beds-vacant)/beds*100 + 0.5)
		}
		cover := exterior[id]
		if cover == nil && isBranch {
			cover = exterior[parent]
		}
		m := money[id]
		rows = append(rows, summaryRow{strField(h, "location", "area"), strField(h, "location", "city"), beds, m[1], cover, max(0, m[0]-m[1]), id.Hex(), isBranch, strField(h, "name"), occupancy,
			complaints[id], residents[id], strField(h, "slug"), strField(h, "status")})
	}
	order := map[string]int{}
	for i, id := range all {
		order[id] = i
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].IsBranch != rows[j].IsBranch {
			return !rows[i].IsBranch
		}
		return order[rows[i].ID] < order[rows[j].ID]
	})
	httpx.OK(c, summaryOut{rows, period}, "Branches summary loaded")
}

// ---- request a branch ----

func (a *Admin) uniqueBranchSlug(ctx context.Context, name, area string) (string, error) {
	base := strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(name+"-"+area), "-"), "-")
	if len(base) > 60 {
		base = base[:60]
	}
	if base == "" {
		base = "hostel"
	}
	for attempt := 0; attempt < 20; attempt++ {
		slug := base
		if attempt > 0 {
			slug = base + "-" + strconv.Itoa(attempt+1)
		}
		if slug == overallSlug {
			continue
		}
		n, err := a.DB.Collection("hostels").CountDocuments(ctx, bson.D{{Key: "slug", Value: slug}}, options.Count().SetLimit(1))
		if err != nil {
			return "", err
		}
		if n == 0 {
			return slug, nil
		}
	}
	id := bson.NewObjectID().Hex()
	return base + "-" + id[len(id)-6:], nil
}

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

func (a *Admin) branchRequest(c *gin.Context) {
	p := authz.From(c)
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, err := ParseBranch(body)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	mainID, err := a.mainHostelOf(c, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := a.requestBranch(c, mainID, in, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, 201, out, "Branch sent for approval")
}

type requestedOut struct {
	Branch struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Status string `json:"status"`
	} `json:"branch"`
}

func (a *Admin) requestBranch(c *gin.Context, mainHostelID string, in Branch, p *authz.Principal) (*requestedOut, error) {
	owned, err := ResolveOwned(c, a.DB, mainHostelID, p.UserID)
	if err != nil {
		return nil, err
	}
	var main struct {
		ID         bson.ObjectID  `bson:"_id"`
		Name       string         `bson:"name"`
		OwnerID    bson.ObjectID  `bson:"ownerId"`
		PanNumber  *string        `bson:"panNumber"`
		Parent     *bson.ObjectID `bson:"parentHostelId"`
		Suspension bson.D         `bson:"suspension"`
	}
	if err := a.DB.Collection("hostels").FindOne(c, bson.D{{Key: "_id", Value: owned.ID}}).Decode(&main); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, branchErr(404, "HOSTEL_NOT_FOUND", "Hostel not found.")
		}
		return nil, err
	}
	if main.Parent != nil {
		return nil, branchErr(409, "BRANCH_OF_BRANCH", "This hostel is itself a branch. Add branches from the main hostel.")
	}
	allowance, err := a.allowance(c, main.ID)
	if err != nil {
		return nil, err
	}
	planName := "This plan"
	if s, ok := allowance.PlanName.(string); ok {
		planName = s
	}
	if allowance.Cap == 0 {
		return nil, branchErr(409, "PLAN_HAS_NO_BRANCHES", "Branches come with the plan that includes them. "+planName+" has none.")
	}
	if !allowance.Active {
		return nil, branchErr(409, "PLAN_NOT_ACTIVE", "The main hostel's plan has to be active — clear any due first.")
	}
	if allowance.Used >= int64(allowance.Cap) {
		noun := "branches"
		if allowance.Cap == 1 {
			noun = "branch"
		}
		return nil, branchErr(409, "BRANCH_LIMIT_REACHED", planName+" includes "+strconv.Itoa(allowance.Cap)+" "+noun+", and you have "+strconv.Itoa(int(allowance.Used))+".")
	}
	key := NameKey(in.Name)
	ncur, err := a.DB.Collection("hostels").Find(c, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
		{Key: "location.area", Value: bson.Regex{Pattern: "^" + regexp.QuoteMeta(strings.TrimSpace(in.LocArea)) + "$", Options: "i"}},
		{Key: "location.city", Value: bson.Regex{Pattern: "^" + regexp.QuoteMeta(strings.TrimSpace(in.LocCity)) + "$", Options: "i"}}},
		options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}).SetLimit(500))
	if err != nil {
		return nil, err
	}
	var neighbours []struct {
		Name string `bson:"name"`
	}
	if err := ncur.All(c, &neighbours); err != nil {
		return nil, err
	}
	if key != "" {
		for _, n := range neighbours {
			if NameKey(n.Name) == key {
				return nil, branchErr(409, "HOSTEL_ALREADY_LISTED", "A hostel with this name is already listed in "+in.LocArea+". Give the branch a name that tells them apart.")
			}
		}
	}
	reg := &Registration{ShortStayLimits: a.ShortStayLimits}
	shortStays, err := reg.shortStays(c, in.Reg)
	if err != nil {
		return nil, err
	}
	uploaded, err := a.Claims.Claim(c, a.DB, in.Documents, main.OwnerID)
	if err != nil {
		return nil, err
	}
	type docRef struct {
		Type  string
		Asset bson.ObjectID
	}
	var shared []docRef
	if in.ReuseDocuments {
		// Reuse only this owner's approved documents, never a client-supplied hostel or asset id.
		dcur, err := a.DB.Collection("hosteldocuments").Find(c, bson.D{{Key: "hostelId", Value: main.ID}, {Key: "ownerId", Value: main.OwnerID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "status", Value: "APPROVED"}},
			options.Find().SetProjection(bson.D{{Key: "documentType", Value: 1}, {Key: "fileAssetId", Value: 1}}).SetLimit(100))
		if err != nil {
			return nil, err
		}
		var rows []struct {
			Type  string        `bson:"documentType"`
			Asset bson.ObjectID `bson:"fileAssetId"`
		}
		if err := dcur.All(c, &rows); err != nil {
			return nil, err
		}
		for _, r := range rows {
			shared = append(shared, docRef{r.Type, r.Asset})
		}
	}
	var documents []docRef
	for _, d := range shared {
		if !slices.ContainsFunc(uploaded, func(u files.Claimed) bool { return u.DocumentType == d.Type }) {
			documents = append(documents, d)
		}
	}
	for _, u := range uploaded {
		documents = append(documents, docRef{u.DocumentType, u.FileAssetID})
	}
	slug, err := a.uniqueBranchSlug(c, in.Name, in.LocArea)
	if err != nil {
		return nil, err
	}
	actor, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	branchID := bson.NewObjectID()
	pan := in.PAN
	if in.ReuseDocuments {
		pan = main.PanNumber
	}
	fields := branchFields(in, main.OwnerID, main.ID, actor, slug, shortStays, main.Suspension, PanKey(pan))
	if _, err := a.DB.Collection("hostels").InsertOne(c, NewHostelDoc(branchID, fields, now)); err != nil {
		return nil, err
	}
	docSnap := bson.A{}
	for _, d := range documents {
		docSnap = append(docSnap, bson.D{{Key: "documentType", Value: d.Type}, {Key: "fileAssetId", Value: d.Asset}})
	}
	snap := bson.D{}
	if in.TotalCap != nil {
		snap = append(snap, bson.E{Key: "totalCapacity", Value: *in.TotalCap})
	}
	if in.Floors != nil {
		snap = append(snap, bson.E{Key: "totalFloors", Value: *in.Floors})
	}
	if in.Year != nil {
		snap = append(snap, bson.E{Key: "yearEstablished", Value: *in.Year})
	}
	snap = append(snap, bson.E{Key: "reuseDocuments", Value: in.ReuseDocuments}, bson.E{Key: "contact", Value: in.Contact}, bson.E{Key: "documents", Value: docSnap}, bson.E{Key: "location", Value: in.Location},
		bson.E{Key: "name", Value: in.Name})
	if len(in.Pricing) > 0 {
		snap = append(snap, bson.E{Key: "pricing", Value: in.Pricing})
	}
	snap = append(snap, bson.E{Key: "parentHostelId", Value: main.ID})
	if in.Deposit != nil {
		snap = append(snap, bson.E{Key: "securityDeposit", Value: *in.Deposit})
	}
	snap = append(snap, bson.E{Key: "roomConfigurations", Value: roomSnapshot(in.Rooms)})
	app := bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "hostelId", Value: branchID}, {Key: "applicantId", Value: main.OwnerID}, {Key: "submittedBy", Value: actor}, {Key: "status", Value: "PENDING"},
		{Key: "source", Value: "BRANCH"}, {Key: "submittedByAgentId", Value: nil}, {Key: "requestedDocuments", Value: bson.A{}}}
	if in.Notes != nil {
		app = append(app, bson.E{Key: "notes", Value: *in.Notes})
	}
	app = append(app, bson.E{Key: "snapshot", Value: snap}, bson.E{Key: "isDeleted", Value: false}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := a.DB.Collection("hostelapplications").InsertOne(c, app); err != nil {
		return nil, err
	}
	if _, err := a.DB.Collection("hostelverifications").InsertOne(c, bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "hostelId", Value: branchID}, {Key: "status", Value: "PENDING"},
		{Key: "checklist", Value: bson.A{}}, {Key: "createdBy", Value: actor}, {Key: "updatedBy", Value: actor}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		return nil, err
	}
	if len(documents) > 0 {
		rows := make([]any, 0, len(documents))
		for _, d := range documents {
			rows = append(rows, bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "hostelId", Value: branchID}, {Key: "ownerId", Value: main.OwnerID}, {Key: "documentType", Value: d.Type},
				{Key: "fileAssetId", Value: d.Asset}, {Key: "status", Value: "PENDING"}, {Key: "createdBy", Value: actor}, {Key: "updatedBy", Value: actor}, {Key: "isDeleted", Value: false},
				{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}})
		}
		if _, err := a.DB.Collection("hosteldocuments").InsertMany(c, rows); err != nil {
			return nil, err
		}
	}
	if in.Payout != nil {
		(&Registration{DB: a.DB, Audit: a.Audit, Notify: a.Notify, FinanceKey: a.FinanceKey, FinancePrev: a.FinancePrev, PersonalKey: a.PersonalKey}).savePayout(c, branchID, in.Payout, actor, now)
	}
	var panAudit any
	if k := PanKey(in.PAN); k != nil {
		panAudit = *k
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "HOSTEL_BRANCH_REQUESTED", ActorID: actor, EntityID: branchID.Hex(), EntityType: "Hostel", HostelID: branchID,
		Metadata: bson.D{{Key: "mainHostelId", Value: main.ID.Hex()}, {Key: "panNumber", Value: panAudit}}}); err != nil {
		return nil, err
	}
	phone := ""
	if v, ok := lookup(in.Contact, "phone"); ok {
		phone, _ = v.(string)
	}
	a.notifyBranch(c, in.Name, phone, main.Name)
	out := &requestedOut{}
	out.Branch.ID, out.Branch.Name, out.Branch.Status = branchID.Hex(), in.Name, "PENDING_APPROVAL"
	return out, nil
}

// branchFields is the document requestBranch creates, in the order the model keeps.
func branchFields(in Branch, ownerID, mainID, actor bson.ObjectID, slug string, shortStays bson.D, suspension bson.D, pan *string) bson.D {
	var capacity bson.D
	if len(in.Rooms) > 0 {
		var rooms, beds, vacant float64
		for _, r := range in.Rooms {
			rooms += r.Rooms
			beds += r.Rooms * r.Beds
			vacant += r.Vacant
		}
		capacity = bson.D{{Key: "totalRooms", Value: rooms}, {Key: "totalBeds", Value: beds}, {Key: "vacantBeds", Value: vacant}}
	} else {
		capacity = append(bson.D{}, in.Capacity...)
		if in.TotalCap != nil {
			capacity = setKey(capacity, "totalBeds", *in.TotalCap)
		}
	}
	contact := append(bson.D{}, in.Contact...)
	if in.AltPhone != nil {
		contact = append(contact, bson.E{Key: "alternatePhone", Value: *in.AltPhone})
	}
	location := append(bson.D{}, in.Location...)
	if in.Landmark != nil {
		location = append(location, bson.E{Key: "landmark", Value: *in.Landmark})
	}
	if in.MapLink != nil {
		location = append(location, bson.E{Key: "mapLink", Value: *in.MapLink})
	}
	rooms := bson.A{}
	for _, rc := range in.Rooms {
		rooms = append(rooms, append(bson.D{{Key: "_id", Value: bson.NewObjectID()}}, roomDoc(rc, in.Deposit, true)...))
	}
	photos := bson.A{}
	for _, p := range in.Photos {
		photos = append(photos, append(bson.D{{Key: "_id", Value: bson.NewObjectID()}}, p.(bson.D)...))
	}
	f := bson.D{}
	if len(suspension) > 0 {
		f = append(f, bson.E{Key: "suspension", Value: suspension})
	}
	f = append(f, bson.E{Key: "capacitySummary", Value: capacity}, bson.E{Key: "contact", Value: contact}, bson.E{Key: "createdBy", Value: actor})
	if in.Desc != nil {
		f = append(f, bson.E{Key: "description", Value: *in.Desc})
	}
	f = append(f, bson.E{Key: "facilities", Value: strArray(in.Facilities)})
	if in.FoodSet {
		f = append(f, bson.E{Key: "food", Value: in.Food})
	}
	f = append(f, bson.E{Key: "hostelType", Value: in.HostelType}, bson.E{Key: "location", Value: location}, bson.E{Key: "name", Value: in.Name}, bson.E{Key: "ownerId", Value: ownerID})
	if pan != nil {
		f = append(f, bson.E{Key: "panNumber", Value: *pan})
	}
	f = append(f, bson.E{Key: "parentHostelId", Value: mainID}, bson.E{Key: "photos", Value: photos})
	if in.PricingSet {
		f = append(f, bson.E{Key: "pricing", Value: in.Pricing})
	}
	if in.Deposit != nil {
		f = append(f, bson.E{Key: "securityDeposit", Value: *in.Deposit})
	}
	f = append(f, bson.E{Key: "roomConfigurations", Value: rooms}, bson.E{Key: "roomTypes", Value: strArray(in.RoomTypes)}, bson.E{Key: "rules", Value: strArray(in.Rules)})
	if shortStays != nil {
		f = append(f, bson.E{Key: "shortStays", Value: shortStays})
	}
	if in.Floors != nil {
		f = append(f, bson.E{Key: "totalFloors", Value: *in.Floors})
	}
	if in.Year != nil {
		f = append(f, bson.E{Key: "yearEstablished", Value: *in.Year})
	}
	return append(f, bson.E{Key: "slug", Value: slug}, bson.E{Key: "status", Value: "PENDING_APPROVAL"}, bson.E{Key: "updatedBy", Value: actor}, bson.E{Key: "verificationStatus", Value: "PENDING"})
}

// notifyBranch is notifyPlatformOfBranch: the staff who approve hostels, best-effort.
func (a *Admin) notifyBranch(c *gin.Context, branch, phone, main string) {
	cur, err := a.DB.Collection("users").Find(c, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "role", Value: "SUPERADMIN"}, {Key: "status", Value: "ACTIVE"}},
		options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}).SetLimit(200))
	if err != nil {
		return
	}
	var staff []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if cur.All(c, &staff) != nil {
		return
	}
	call := phone
	if call == "" {
		call = "the branch"
	}
	for _, m := range staff {
		_, _ = a.Notify.CreateInApp(c, notifications.Input{ActionURL: "/platform/hostels", Body: branch + ", a branch of " + main + ". Call " + call + " before approving.", Category: "HOSTEL_APPROVAL",
			Title: "Branch waiting for a call", UserID: m.ID.Hex()})
	}
}
