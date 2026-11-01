// Package stock is modules/stock for the kitchen: what is left, what the cook used
// today, adding a slip and undoing it. The store side (buying, sending, counting,
// suppliers, reports) lands with Phase 6.
package stock

import (
	"context"
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

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

const (
	linesMax = 60
	qtyMax   = 100_000
	whatMax  = 120
)

var objectIDRe = regexp.MustCompile(`(?i)^[a-f\d]{24}$`)

type Handler struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Notify *notifications.Service
	RT     *realtime.Client
	Bump   realtime.Bumper
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.GET("/cook/stock", httpx.ETag(), h.home)
	v1.POST("/cook/stock", h.create)
	v1.POST("/cook/stock/entries/:id/undo", h.undo)
}

func fail(status int, code, message string) error { return httpx.NewError(status, code, message, nil) }

type place struct {
	id, name string
}

type actor struct {
	active bson.ObjectID
	group  bson.ObjectID
	places []place
	userID string
}

// resolve is resolveStockActor for a cook; the kitchen only ever sees its own building.
func (h *Handler) resolve(c *gin.Context) (*actor, error) {
	p, err := h.Guards.Require(c)
	if err != nil {
		return nil, err
	}
	if err := authz.AssertRoles(p, authz.Cook); err != nil {
		return nil, err
	}
	active := ""
	if len(p.HostelIDs) > 0 {
		active = p.HostelIDs[0]
	}
	id, err := bson.ObjectIDFromHex(active)
	if err != nil {
		return nil, fail(422, "HOSTEL_SCOPE_REQUIRED", "This cook account is not linked to a hostel.")
	}
	var settings struct {
		On *bool `bson:"cookCanUseStock"`
	}
	err = h.DB.Collection("hostelsettings").FindOne(c, bson.D{{Key: "hostelId", Value: id}}).Decode(&settings)
	if err != nil && err != mongo.ErrNoDocuments {
		return nil, err
	}
	if settings.On != nil && !*settings.On {
		return nil, fail(403, "STOCK_OFF_FOR_COOK", "The owner has turned off stock for the kitchen.")
	}
	var hostel struct {
		Parent *bson.ObjectID `bson:"parentHostelId"`
	}
	err = h.DB.Collection("hostels").FindOne(c, bson.D{{Key: "_id", Value: id}}).Decode(&hostel)
	if err == mongo.ErrNoDocuments {
		return nil, fail(404, "HOSTEL_NOT_FOUND", "Hostel not found.")
	}
	if err != nil {
		return nil, err
	}
	group := id
	if hostel.Parent != nil {
		group = *hostel.Parent
	}
	cur, err := h.DB.Collection("hostels").Find(c, bson.D{{Key: "$or", Value: bson.A{bson.D{{Key: "_id", Value: group}}, bson.D{{Key: "parentHostelId", Value: group}}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}})
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID   bson.ObjectID `bson:"_id"`
		Name *string       `bson:"name"`
	}
	if err := cur.All(c, &rows); err != nil {
		return nil, err
	}
	places := make([]place, len(rows))
	for i, r := range rows {
		places[i] = place{r.ID.Hex(), "Hostel"}
		if r.Name != nil && *r.Name != "" {
			places[i].name = *r.Name
		}
	}
	return &actor{id, group, places, p.UserID}, nil
}

func (a *actor) nameOf(id, fallback string) string {
	for _, x := range a.places {
		if x.id == id {
			return x.name
		}
	}
	return fallback
}

type item struct {
	ID       bson.ObjectID `bson:"_id"`
	Active   bool          `bson:"active"`
	Kind     string        `bson:"kind"`
	LowAt    *float64      `bson:"lowAt"`
	Name     string        `bson:"name"`
	PackSize *float64      `bson:"packSize"`
	PackUnit *string       `bson:"packUnit"`
	Unit     string        `bson:"unit"`
}

type line struct {
	ItemID    bson.ObjectID `bson:"itemId"`
	Name      string        `bson:"name"`
	PackQty   *float64      `bson:"packQty"`
	PackUnit  *string       `bson:"packUnit"`
	Qty       float64       `bson:"qty"`
	Rate      *float64      `bson:"rate"`
	ReceivedQ *float64      `bson:"receivedQty"`
	SystemQty *float64      `bson:"systemQty"`
	Unit      string        `bson:"unit"`
}

type entry struct {
	ID           bson.ObjectID  `bson:"_id"`
	ApprovedBy   *string        `bson:"approvedByName"`
	CancelReason *string        `bson:"cancelReason"`
	CreatedAt    time.Time      `bson:"createdAt"`
	HostelID     bson.ObjectID  `bson:"hostelId"`
	Kind         string         `bson:"kind"`
	Lines        []line         `bson:"lines"`
	Note         string         `bson:"note"`
	On           time.Time      `bson:"on"`
	ReceivedAt   *time.Time     `bson:"receivedAt"`
	ReceivedBy   *string        `bson:"receivedByName"`
	RecordedBy   bson.ObjectID  `bson:"recordedBy"`
	RecordedName string         `bson:"recordedByName"`
	RecordedRole *string        `bson:"recordedRole"`
	Status       string         `bson:"status"`
	ToHostelID   *bson.ObjectID `bson:"toHostelId"`
	UseFor       *string        `bson:"useFor"`
	WasteReason  *string        `bson:"wasteReason"`
}

func roundQty(v float64) float64 { return math.Floor(v*100+0.5) / 100 }

// foldLeft is foldStock's `left` at one place. The running total is what TS keeps;
// the period columns wait for the store screens.
func foldLeft(entries []entry, kinds map[bson.ObjectID]string, here bson.ObjectID) map[bson.ObjectID]float64 {
	type event struct {
		at     time.Time
		item   bson.ObjectID
		delta  float64
		isCnt  bool
		qty    float64
		system *float64
		place  bson.ObjectID
	}
	events := []event{}
	for i := range entries {
		e := &entries[i]
		if e.Status == "CANCELLED" || (e.Kind == "COUNT" && e.Status == "PENDING") {
			continue
		}
		for _, l := range e.Lines {
			if _, known := kinds[l.ItemID]; !known {
				continue
			}
			ev := event{at: e.CreatedAt, item: l.ItemID, place: e.HostelID, qty: l.Qty}
			switch e.Kind {
			case "BUY", "OPENING":
				ev.delta = l.Qty
			case "USE", "WASTE":
				ev.delta = -l.Qty
			case "COUNT":
				ev.isCnt, ev.system = true, l.SystemQty
			case "SEND":
				ev.delta = -l.Qty
				if e.ToHostelID != nil && e.Status != "PENDING" {
					got := l.Qty
					if l.ReceivedQ != nil {
						got = *l.ReceivedQ
					}
					at := e.CreatedAt
					if e.ReceivedAt != nil {
						at = *e.ReceivedAt
					}
					events = append(events, event{at: at, item: l.ItemID, place: *e.ToHostelID, delta: got})
				}
			default:
				continue
			}
			events = append(events, ev)
		}
	}
	sort.SliceStable(events, func(i, j int) bool { return events[i].at.Before(events[j].at) })
	left := map[bson.ObjectID]float64{}
	for _, ev := range events {
		if ev.place != here {
			continue
		}
		delta := ev.delta
		if ev.isCnt {
			if ev.system != nil {
				delta = ev.qty - *ev.system
			} else {
				delta = ev.qty - left[ev.item]
			}
		}
		left[ev.item] += delta
	}
	for id := range left {
		if kinds[id] == "DAILY" {
			left[id] = 0
		} else {
			left[id] = roundQty(left[id])
		}
	}
	return left
}

// book is readBook.
func (h *Handler) book(ctx context.Context, a *actor) ([]item, []entry, map[bson.ObjectID]float64, error) {
	cur, err := h.DB.Collection("stockitems").Find(ctx, bson.D{{Key: "groupHostelId", Value: a.group}}, options.Find().SetSort(bson.D{{Key: "active", Value: -1}, {Key: "name", Value: 1}}))
	if err != nil {
		return nil, nil, nil, err
	}
	var items []item
	if err := cur.All(ctx, &items); err != nil {
		return nil, nil, nil, err
	}
	cur, err = h.DB.Collection("stockentries").Find(ctx, bson.D{{Key: "groupHostelId", Value: a.group}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: 1}}))
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
	return items, docs, foldLeft(docs, kinds, a.active), nil
}

func dayKey(t time.Time) string { return t.UTC().Format("2006-01-02") }

func canUndo(a *actor, e *entry, mine bool) bool {
	return e.Status != "CANCELLED" && mine && (e.Kind == "USE" || e.Kind == "WASTE") && dayKey(e.On) == dayKey(bs.Today(time.Now()))
}

func ptrAny[T any](p *T) any {
	if p == nil {
		return nil
	}
	return *p
}

// serialize is serializeEntry as a cook sees a slip: never any money.
func serialize(a *actor, e *entry) ordered.Map {
	mine := e.RecordedBy.Hex() == a.userID
	lines := make([]ordered.Map, len(e.Lines))
	for i, l := range e.Lines {
		lines[i] = ordered.Map{{Key: "amount", Value: nil}, {Key: "itemId", Value: l.ItemID.Hex()}, {Key: "name", Value: l.Name}, {Key: "packQty", Value: ptrAny(l.PackQty)}, {Key: "packUnit", Value: ptrAny(l.PackUnit)}, {Key: "qty", Value: l.Qty},
			{Key: "rate", Value: nil}, {Key: "receivedQty", Value: ptrAny(l.ReceivedQ)}, {Key: "systemQty", Value: ptrAny(l.SystemQty)}, {Key: "unit", Value: l.Unit}}
	}
	name := e.RecordedName
	if name == "" {
		name = "Staff"
		if e.RecordedRole != nil && *e.RecordedRole == "COOK" {
			name = "Kitchen"
		}
	}
	var received, toID, toName any
	if e.ReceivedAt != nil {
		received = httpx.ISO(*e.ReceivedAt)
	}
	if e.ToHostelID != nil {
		toID = e.ToHostelID.Hex()
		toName = a.nameOf(e.ToHostelID.Hex(), "Hostel")
	}
	return ordered.Map{{Key: "amount", Value: nil}, {Key: "approvedByName", Value: ptrAny(e.ApprovedBy)}, {Key: "bill", Value: nil}, {Key: "canApprove", Value: false}, {Key: "canCancel", Value: canUndo(a, e, mine)}, {Key: "canReceive", Value: false},
		{Key: "cancelReason", Value: ptrAny(e.CancelReason)}, {Key: "createdAt", Value: httpx.ISO(e.CreatedAt)}, {Key: "hostelId", Value: e.HostelID.Hex()}, {Key: "hostelName", Value: a.nameOf(e.HostelID.Hex(), "Hostel")}, {Key: "id", Value: e.ID.Hex()},
		{Key: "kind", Value: e.Kind}, {Key: "lines", Value: lines}, {Key: "mine", Value: mine}, {Key: "note", Value: e.Note}, {Key: "on", Value: dayKey(e.On)}, {Key: "receivedAt", Value: received}, {Key: "receivedByName", Value: ptrAny(e.ReceivedBy)},
		{Key: "recordedByName", Value: name}, {Key: "recordedRole", Value: ptrAny(e.RecordedRole)}, {Key: "status", Value: e.Status}, {Key: "supplier", Value: ""}, {Key: "toHostelId", Value: toID}, {Key: "toHostelName", Value: toName},
		{Key: "useFor", Value: ptrAny(e.UseFor)}, {Key: "wasteReason", Value: ptrAny(e.WasteReason)}}
}

type itemOut struct {
	ID       string  `json:"id"`
	Left     float64 `json:"left"`
	Low      bool    `json:"low"`
	Name     string  `json:"name"`
	PackSize any     `json:"packSize"`
	PackUnit any     `json:"packUnit"`
	Unit     string  `json:"unit"`
}

type todayOut struct {
	At      string  `json:"at"`
	By      string  `json:"by"`
	CanUndo bool    `json:"canUndo"`
	EntryID string  `json:"entryId"`
	ItemID  string  `json:"itemId"`
	Kind    string  `json:"kind"`
	Name    string  `json:"name"`
	Qty     float64 `json:"qty"`
	Unit    string  `json:"unit"`
}

type homeOut struct {
	HostelName string     `json:"hostelName"`
	Items      []itemOut  `json:"items"`
	Today      []todayOut `json:"today"`
}

func (h *Handler) home(c *gin.Context) {
	a, err := h.resolve(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	items, docs, left, err := h.book(c, a)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	ranks := map[string]int{}
	recent := docs
	if len(recent) > 300 {
		recent = recent[len(recent)-300:]
	}
	for i := range recent {
		e := &recent[i]
		if e.Kind != "USE" || e.Status == "CANCELLED" || e.HostelID != a.active {
			continue
		}
		for _, l := range e.Lines {
			ranks[l.ItemID.Hex()]++
		}
	}
	out := homeOut{a.nameOf(a.active.Hex(), "Your hostel"), []itemOut{}, []todayOut{}}
	for i := range items {
		x := &items[i]
		if !x.Active || x.Kind != "STORE" {
			continue
		}
		n := left[x.ID]
		out.Items = append(out.Items, itemOut{x.ID.Hex(), n, x.LowAt != nil && n < *x.LowAt, x.Name, ptrAny(x.PackSize), ptrAny(x.PackUnit), x.Unit})
	}
	sort.SliceStable(out.Items, func(i, j int) bool {
		a, b := out.Items[i], out.Items[j]
		if ranks[a.ID] != ranks[b.ID] {
			return ranks[a.ID] > ranks[b.ID]
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	today := dayKey(bs.Today(time.Now()))
	for i := len(docs) - 1; i >= 0; i-- {
		e := &docs[i]
		if (e.Kind != "USE" && e.Kind != "WASTE") || e.Status == "CANCELLED" || e.HostelID != a.active || dayKey(e.On) != today {
			continue
		}
		mine := e.RecordedBy.Hex() == a.userID
		by := e.RecordedName
		switch {
		case mine:
			by = "You"
		case by == "":
			by = "Staff"
			if e.RecordedRole != nil && *e.RecordedRole == "COOK" {
				by = "Kitchen"
			}
		}
		for _, l := range e.Lines {
			out.Today = append(out.Today, todayOut{httpx.ISO(e.CreatedAt), by, canUndo(a, e, mine), e.ID.Hex(), l.ItemID.Hex(), e.Kind, l.Name, l.Qty, l.Unit})
		}
	}
	httpx.OK(c, out, "Kitchen stock loaded")
}

type parsedLine struct {
	item    string
	packQty *float64
	qty     float64
}

func parseQty(sub *valid.Form, key string, optional, positive bool) *float64 {
	v, present := sub.M[key]
	if !present && optional {
		return nil
	}
	n, ok := v.(float64)
	if !ok {
		sub.Is.Add(key, "Write how much.")
		sub.Hard = true
		return nil
	}
	if n < 0 {
		sub.Is.Add(key, "Write how much.")
	}
	if n > qtyMax {
		sub.Is.Add(key, "That is too much. Check it.")
	}
	if positive && n <= 0 {
		sub.Is.Add(key, "Write how much.")
	}
	return &n
}

var unitLabels = map[string][2]string{"BOTTLE": {"bottle", "bottles"}, "CYLINDER": {"cylinder", "cylinders"}, "DOZEN": {"dozen", "dozen"}, "KG": {"kg", "kg"}, "LITRE": {"L", "L"}, "PACKET": {"packet", "packets"}, "PIECE": {"pc", "pcs"}, "SACK": {"sack", "sacks"}, "TIN": {"tin", "tins"}}

// formatQty is the shared formatQty: `25 kg`, `1 sack`, `2.5 L`.
func formatQty(qty float64, unit string) string {
	r := roundQty(qty)
	label, ok := unitLabels[unit]
	if !ok {
		low := strings.ToLower(unit)
		label = [2]string{low, low}
	}
	whole := int64(math.Abs(r))
	number := money.GroupIN(whole)
	if frac := math.Abs(r) - float64(whole); frac > 0 {
		number += strings.TrimPrefix(strconv.FormatFloat(roundQty(frac), 'f', -1, 64), "0")
	}
	if r < 0 {
		number = "-" + number
	}
	if math.Abs(r) == 1 {
		return number + " " + label[0]
	}
	return number + " " + label[1]
}

func (h *Handler) byRequest(ctx context.Context, a *actor, key string) (*entry, error) {
	if key == "" {
		return nil, nil
	}
	me, err := httpx.OID(a.userID, "user id")
	if err != nil {
		return nil, err
	}
	var e entry
	err = h.DB.Collection("stockentries").FindOne(ctx, bson.D{{Key: "clientRequestId", Value: key}, {Key: "groupHostelId", Value: a.group}, {Key: "recordedBy", Value: me}}).Decode(&e)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &e, nil
}

func (h *Handler) changed(ctx context.Context, hostels ...string) {
	realtime.PublishResourceChange(ctx, h.RT, h.Bump, realtime.Change{HostelIDs: hostels, Topics: []realtime.Topic{realtime.Food}})
}

// receivers is receivers(hostelId, "manageStock"): the owner and the wardens with the grant.
func (h *Handler) receivers(ctx context.Context, hostel bson.ObjectID) ([]string, error) {
	var row struct {
		Owner *bson.ObjectID `bson:"ownerId"`
	}
	err := h.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}}).Decode(&row)
	if err != nil && err != mongo.ErrNoDocuments {
		return nil, err
	}
	cur, err := h.DB.Collection("hostelmembers").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
		{Key: "permissions", Value: bson.D{{Key: "$in", Value: authz.GrantingPermissionKeys("manageStock")}}}, {Key: "role", Value: "WARDEN"}, {Key: "status", Value: "ACTIVE"}})
	if err != nil {
		return nil, err
	}
	var wardens []struct {
		UserID bson.ObjectID `bson:"userId"`
	}
	if err := cur.All(ctx, &wardens); err != nil {
		return nil, err
	}
	out := []string{}
	if row.Owner != nil {
		out = append(out, row.Owner.Hex())
	}
	for _, w := range wardens {
		if !slices.Contains(out, w.UserID.Hex()) {
			out = append(out, w.UserID.Hex())
		}
	}
	return out, nil
}

// warnIfLow tells the store when a slip takes an item below its line.
func (h *Handler) warnIfLow(ctx context.Context, a *actor, items []item, before, spent map[bson.ObjectID]float64, entryID string) {
	crossed := []*item{}
	for i := range items {
		x := &items[i]
		was := before[x.ID]
		used, took := spent[x.ID]
		if x.Kind == "STORE" && x.LowAt != nil && took && was >= *x.LowAt && was-used < *x.LowAt {
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
		parts[i] = x.Name + ": " + formatQty(math.Max(0, before[x.ID]-spent[x.ID]), x.Unit) + " left"
	}
	users, err := h.receivers(ctx, a.active)
	if err != nil {
		return
	}
	body := strings.Join(parts, ", ") + " in " + a.nameOf(a.active.Hex(), "the hostel") + ". Buy more soon."
	for _, id := range users {
		_, _ = h.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/hostel-admin/stock", Body: body, Category: "STOCK", Data: ordered.Map{{Key: "entryId", Value: entryID}, {Key: "type", Value: "STOCK"}}, HostelID: a.active.Hex(), Kind: "NORMAL", Title: title, UserID: id})
	}
}

func (h *Handler) create(c *gin.Context) {
	a0, err0 := h.Guards.Require(c)
	if err0 != nil {
		httpx.Fail(c, err0)
		return
	}
	if err := authz.AssertRoles(a0, authz.Cook); err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	request, _ := f.Str("clientRequestId", valid.S{Opt: true, Trim: true, Min: 8, Max: 64})
	use := "USE"
	kind, _ := f.Enum("kind", false, &use, "USE", "WASTE")
	parsed := []parsedLine{}
	if list, ok := f.Array("lines", false, false); ok {
		for i, raw := range list {
			path := "lines." + strconv.Itoa(i)
			m, isObj := raw.(map[string]any)
			if !isObj {
				f.Is.Add(path, valid.Type("object", valid.Received(raw, false)))
				continue
			}
			sub := &valid.Form{M: m}
			id, present := m["itemId"]
			s, isStr := id.(string)
			switch {
			case !present || !isStr:
				sub.Is.Add("itemId", valid.Type("string", valid.Received(id, !present)))
			case !objectIDRe.MatchString(s):
				sub.Is.Add("itemId", "Invalid id.")
			}
			pack := parseQty(sub, "packQty", true, false)
			qty := parseQty(sub, "qty", false, true)
			f.Join(path, sub)
			if qty != nil {
				parsed = append(parsed, parsedLine{s, pack, *qty})
			}
		}
		f.Size("lines", len(list), 1, linesMax, "Pick what you used.", false)
	}
	note, _ := f.Str("note", valid.S{Opt: true, Trim: true, Max: 200})
	waste, _ := f.Enum("wasteReason", true, nil, "SPOILED", "EXPIRED", "DAMAGED", "OTHER")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	a, err := h.resolve(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if e, err := h.byRequest(c, a, request); err != nil {
		httpx.Fail(c, err)
		return
	} else if e != nil {
		httpx.OK(c, serialize(a, e), "Already saved")
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	ids := bson.A{}
	for _, l := range parsed {
		id, _ := bson.ObjectIDFromHex(l.item)
		ids = append(ids, id)
	}
	cur, err := h.DB.Collection("stockitems").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "active", Value: true}, {Key: "groupHostelId", Value: a.group}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var items []item
	if err := cur.All(c, &items); err != nil {
		httpx.Fail(c, err)
		return
	}
	byID := map[string]*item{}
	for i := range items {
		byID[strings.ToLower(items[i].ID.Hex())] = &items[i]
	}
	type merged struct {
		id      string
		packQty *float64
		qty     float64
	}
	order := []*merged{}
	seen := map[string]*merged{}
	for _, l := range parsed {
		x := byID[strings.ToLower(l.item)]
		if x == nil {
			httpx.Fail(c, fail(404, "ITEM_NOT_FOUND", "One of the items is not there any more. Pick again."))
			return
		}
		if x.Kind == "DAILY" {
			httpx.Fail(c, fail(422, "DAILY_NOT_TRACKED", x.Name+" is a daily item. It is used the day it comes, so it is not entered again."))
			return
		}
		inPacks := l.packQty != nil && x.PackUnit != nil && *x.PackUnit != "" && x.PackSize != nil && *x.PackSize != 0
		qty := l.qty
		if inPacks {
			qty = *l.packQty * *x.PackSize
		}
		if prev, ok := seen[l.item]; ok {
			if prev.packQty != nil && inPacks {
				sum := *prev.packQty + *l.packQty
				prev.packQty = &sum
			} else {
				prev.packQty = nil
			}
			prev.qty += qty
			continue
		}
		m := &merged{id: l.item, qty: qty}
		if inPacks {
			m.packQty = l.packQty
		}
		seen[l.item] = m
		order = append(order, m)
	}
	_, _, left, err := h.book(c, a)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	me, err := httpx.OID(a.userID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var user struct {
		Name string `bson:"name"`
	}
	if err := h.DB.Collection("users").FindOne(c, bson.D{{Key: "_id", Value: me}}).Decode(&user); err != nil && err != mongo.ErrNoDocuments {
		httpx.Fail(c, err)
		return
	}
	lines := bson.A{}
	spent := map[bson.ObjectID]float64{}
	for _, m := range order {
		x := byID[strings.ToLower(m.id)]
		qty := roundQty(m.qty)
		var pack, packUnit any
		if m.packQty != nil {
			pack = *m.packQty
			packUnit = *x.PackUnit
		}
		lines = append(lines, bson.D{{Key: "itemId", Value: x.ID}, {Key: "name", Value: x.Name}, {Key: "packQty", Value: pack}, {Key: "packUnit", Value: packUnit}, {Key: "qty", Value: qty}, {Key: "rate", Value: nil}, {Key: "receivedQty", Value: nil}, {Key: "systemQty", Value: nil}, {Key: "unit", Value: x.Unit}})
		spent[x.ID] = qty
	}
	var useFor, wasteVal, requestVal any
	if kind == "USE" {
		useFor = "KITCHEN"
	} else {
		if waste == "" {
			waste = "SPOILED"
		}
		wasteVal = waste
	}
	if request != "" {
		requestVal = request
	}
	id := bson.NewObjectID()
	doc := bson.D{{Key: "_id", Value: id}, {Key: "groupHostelId", Value: a.group}, {Key: "hostelId", Value: a.active}, {Key: "kind", Value: kind}, {Key: "status", Value: "DONE"}, {Key: "on", Value: bs.Today(now)}, {Key: "lines", Value: lines}, {Key: "amount", Value: nil},
		{Key: "total", Value: nil}, {Key: "paid", Value: nil}, {Key: "discount", Value: 0}, {Key: "tax", Value: 0}, {Key: "expenseId", Value: nil}, {Key: "photoAssetId", Value: nil}, {Key: "supplierId", Value: nil}, {Key: "toHostelId", Value: nil}, {Key: "useFor", Value: useFor}, {Key: "wasteReason", Value: wasteVal}}
	if note != "" {
		doc = append(doc, bson.E{Key: "note", Value: note})
	}
	doc = append(doc, bson.E{Key: "recordedBy", Value: me}, bson.E{Key: "recordedByName", Value: user.Name}, bson.E{Key: "recordedRole", Value: "COOK"}, bson.E{Key: "clientRequestId", Value: requestVal}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := h.DB.Collection("stockentries").InsertOne(c, doc); err != nil {
		if mongo.IsDuplicateKeyError(err) {
			if e, rerr := h.byRequest(c, a, request); rerr == nil && e != nil {
				httpx.OK(c, serialize(a, e), "Already saved")
				return
			}
		}
		httpx.Fail(c, err)
		return
	}
	h.warnIfLow(c, a, items, left, spent, id.Hex())
	h.changed(c, a.active.Hex())
	var e entry
	if err := h.DB.Collection("stockentries").FindOne(c, bson.D{{Key: "_id", Value: id}}).Decode(&e); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, 201, serialize(a, &e), "Saved")
}

func (h *Handler) undo(c *gin.Context) {
	a, err := h.resolve(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	raw := c.Param("id")
	id, err := bson.ObjectIDFromHex(raw)
	if err != nil {
		httpx.Fail(c, fail(404, "ENTRY_NOT_FOUND", "Not found."))
		return
	}
	coll := h.DB.Collection("stockentries")
	var old entry
	err = coll.FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "groupHostelId", Value: a.group}}).Decode(&old)
	if err != nil && err != mongo.ErrNoDocuments {
		httpx.Fail(c, err)
		return
	}
	if err != nil || !canUndo(a, &old, old.RecordedBy.Hex() == a.userID) {
		httpx.Fail(c, fail(404, "ENTRY_NOT_CANCELLABLE", "You cannot cancel this."))
		return
	}
	me, err := httpx.OID(a.userID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	var updated entry
	err = coll.FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "CANCELLED"}}}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "cancelReason", Value: "Undone by the kitchen"}, {Key: "cancelledAt", Value: now}, {Key: "cancelledBy", Value: me}, {Key: "status", Value: "CANCELLED"}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&updated)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, fail(409, "ENTRY_NOT_CANCELLABLE", "This is already cancelled."))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.Notify.SettleAction(c, "STOCK", bson.D{{Key: "entryId", Value: raw}}, "CANCEL")
	h.changed(c, old.HostelID.Hex())
	httpx.OK(c, serialize(a, &updated), "Undone")
}
