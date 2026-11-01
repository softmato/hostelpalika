// Package khata is modules/finance/khata.service for the kitchen and the resident:
// what a resident takes on credit and the cook hands over. The staff screen is Phase 6.
package khata

import (
	"context"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/kitchen"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

const (
	maxWaiting = 10
	pageCook   = "/cook/khata"
	pageMine   = "/resident/khata"
	pageStaff  = "/hostel-admin/khata"
)

type Handler struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Notify *notifications.Service
	RT     *realtime.Client
	Bump   realtime.Bumper
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.GET("/cook/khata", httpx.ETag(), h.orders)
	v1.POST("/cook/khata/:id", h.decide)
	v1.GET("/resident/finance/khata", httpx.ETag(), h.mine)
	v1.POST("/resident/finance/khata", h.act)
}

type item struct {
	ID     bson.ObjectID  `bson:"_id"`
	Active *bool          `bson:"active"`
	Image  *bson.ObjectID `bson:"imageAssetId"`
	Name   string         `bson:"name"`
	Price  int64          `bson:"price"`
}

type itemOut struct {
	Active       bool   `json:"active"`
	ID           string `json:"id"`
	ImageAssetID any    `json:"imageAssetId"`
	Name         string `json:"name"`
	Price        int64  `json:"price"`
}

func (x *item) live() bool { return x.Active == nil || *x.Active }

func (x *item) out() itemOut {
	var image any
	if x.Image != nil {
		image = x.Image.Hex()
	}
	return itemOut{x.live(), x.ID.Hex(), image, x.Name, x.Price}
}

type entry struct {
	ID        bson.ObjectID  `bson:"_id"`
	Amount    int64          `bson:"amount"`
	CreatedAt time.Time      `bson:"createdAt"`
	DecidedAt *time.Time     `bson:"decidedAt"`
	InvoiceID *bson.ObjectID `bson:"invoiceId"`
	Name      string         `bson:"name"`
	Note      *string        `bson:"note"`
	Quantity  int64          `bson:"quantity"`
	Resident  bson.ObjectID  `bson:"residentId"`
	Status    string         `bson:"status"`
	UnitPrice int64          `bson:"unitPrice"`
}

type resident struct {
	ID     bson.ObjectID `bson:"_id"`
	First  string        `bson:"firstName"`
	Hostel bson.ObjectID `bson:"hostelId"`
	Khata  *struct {
		Status string `bson:"status"`
	} `bson:"khata"`
	Last   string         `bson:"lastName"`
	Room   *string        `bson:"roomNumber"`
	UserID *bson.ObjectID `bson:"userId"`
}

func (r *resident) name() string {
	if n := strings.TrimSpace(r.First + " " + r.Last); n != "" {
		return n
	}
	return "Resident"
}

type personOut struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	RoomNumber any    `json:"roomNumber"`
}

type entryOut struct {
	Amount    int64  `json:"amount"`
	Billed    bool   `json:"billed"`
	CreatedAt string `json:"createdAt"`
	DecidedAt any    `json:"decidedAt"`
	ID        string `json:"id"`
	Name      string `json:"name"`
	Note      any    `json:"note"`
	Quantity  int64  `json:"quantity"`
	Resident  any    `json:"resident"`
	Status    string `json:"status"`
	UnitPrice int64  `json:"unitPrice"`
}

func (e *entry) out(r *resident) entryOut {
	var decided, note, who any
	if e.DecidedAt != nil {
		decided = httpx.ISO(*e.DecidedAt)
	}
	if e.Note != nil {
		note = *e.Note
	}
	if r != nil {
		var room any
		if r.Room != nil {
			room = *r.Room
		}
		who = personOut{r.ID.Hex(), r.name(), room}
	}
	return entryOut{e.Amount, e.InvoiceID != nil, httpx.ISO(e.CreatedAt), decided, e.ID.Hex(), e.Name, note, e.Quantity, who, e.Status, e.UnitPrice}
}

func (h *Handler) items(ctx context.Context, hostel bson.ObjectID) ([]item, error) {
	var row struct {
		Items []item `bson:"khataItems"`
	}
	err := h.DB.Collection("hostelsettings").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}).Decode(&row)
	if err != nil && err != mongo.ErrNoDocuments {
		return nil, err
	}
	return row.Items, nil
}

func (h *Handler) changed(ctx context.Context, hostel bson.ObjectID) {
	realtime.PublishResourceChange(ctx, h.RT, h.Bump, realtime.Change{HostelIDs: []string{hostel.Hex()}, Topics: []realtime.Topic{realtime.Payments}})
}

func (h *Handler) notify(ctx context.Context, users []string, title, body string, hostel bson.ObjectID, page string, data ordered.Map, waits bool) {
	kind := "NORMAL"
	if waits {
		kind = "ACTION"
	}
	for _, id := range users {
		_, _ = h.Notify.CreateInApp(ctx, notifications.Input{ActionURL: page, Body: body, Category: "KHATA", Data: data, HostelID: hostel.Hex(), Kind: kind, Title: title, UserID: id})
	}
}

func (h *Handler) staff(c *gin.Context) (*authz.Principal, error) {
	p, err := h.Guards.Require(c)
	if err != nil {
		return nil, err
	}
	if err := authz.AssertRoles(p, authz.Cook, authz.HostelAdmin, authz.Warden); err != nil {
		return nil, err
	}
	return p, nil
}

type ordersOut struct {
	Recent  []entryOut `json:"recent"`
	Waiting []entryOut `json:"waiting"`
}

func (h *Handler) orders(c *gin.Context) {
	p, err := h.staff(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := kitchen.HostelFor(p, valid.Query(c)["hostelId"])
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	coll := h.DB.Collection("khataentries")
	cur, err := coll.Find(c, bson.D{{Key: "hostelId", Value: hostel}, {Key: "status", Value: "REQUESTED"}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: 1}}).SetLimit(200))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var waiting []entry
	if err := cur.All(c, &waiting); err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err = coll.Find(c, bson.D{{Key: "decidedAt", Value: bson.D{{Key: "$gte", Value: time.Now().Add(-24 * time.Hour)}}}, {Key: "hostelId", Value: hostel}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"GIVEN", "DECLINED"}}}}},
		options.Find().SetSort(bson.D{{Key: "decidedAt", Value: -1}}).SetLimit(50))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var recent []entry
	if err := cur.All(c, &recent); err != nil {
		httpx.Fail(c, err)
		return
	}
	ids := bson.A{}
	for i := range waiting {
		ids = append(ids, waiting[i].Resident)
	}
	for i := range recent {
		ids = append(ids, recent[i].Resident)
	}
	cur, err = h.DB.Collection("residents").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []resident
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	people := map[bson.ObjectID]*resident{}
	for i := range rows {
		people[rows[i].ID] = &rows[i]
	}
	out := ordersOut{make([]entryOut, len(recent)), make([]entryOut, len(waiting))}
	for i := range recent {
		out.Recent[i] = recent[i].out(people[recent[i].Resident])
	}
	for i := range waiting {
		out.Waiting[i] = waiting[i].out(people[waiting[i].Resident])
	}
	httpx.OK(c, out, "Khata asks")
}

func (h *Handler) decide(c *gin.Context) {
	p, err := h.staff(c)
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
	action, _ := f.Enum("action", false, nil, "GIVE", "DECLINE")
	requested, _ := f.Str("hostelId", valid.S{Opt: true})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := kitchen.HostelFor(p, requested)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	notFound := httpx.NewError(404, "KHATA_ENTRY_NOT_FOUND", "That ask was not found.", nil)
	raw := c.Param("id")
	id, err := bson.ObjectIDFromHex(raw)
	if err != nil {
		httpx.Fail(c, notFound)
		return
	}
	status := "DECLINED"
	if action == "GIVE" {
		status = "GIVEN"
	}
	me, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	coll := h.DB.Collection("khataentries")
	var e entry
	err = coll.FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: hostel}, {Key: "status", Value: "REQUESTED"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "decidedAt", Value: now}, {Key: "decidedBy", Value: me}, {Key: "status", Value: status}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&e)
	if err == mongo.ErrNoDocuments {
		switch exists := coll.FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: hostel}}).Err(); exists {
		case nil:
			httpx.Fail(c, httpx.NewError(409, "KHATA_ENTRY_DECIDED", "Someone already answered this ask.", nil))
		case mongo.ErrNoDocuments:
			httpx.Fail(c, notFound)
		default:
			httpx.Fail(c, exists)
		}
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var r resident
	err = h.DB.Collection("residents").FindOne(c, bson.D{{Key: "_id", Value: e.Resident}}).Decode(&r)
	if err != nil && err != mongo.ErrNoDocuments {
		httpx.Fail(c, err)
		return
	}
	if r.UserID != nil {
		count := strconv.FormatInt(e.Quantity, 10)
		title, text := e.Name+" not available", "Nothing was added to your khata."
		if action == "GIVE" {
			title, text = e.Name+" ×"+count+" given", "Rs "+money.GroupUS(e.Amount)+" added to your khata — it goes on next month's bill."
		}
		h.notify(c, []string{r.UserID.Hex()}, title, text, hostel, pageMine, ordered.Map{{Key: "entryId", Value: raw}, {Key: "type", Value: "KHATA_ASK_ANSWERED"}}, false)
	}
	h.Notify.SettleAction(c, "KHATA", bson.D{{Key: "entryId", Value: raw}, {Key: "type", Value: "KHATA_ASK"}}, action)
	h.changed(c, hostel)
	msg := "Marked not available"
	if action == "GIVE" {
		msg = "Given"
	}
	httpx.OK(c, e.out(nil), msg)
}

// --- resident -------------------------------------------------------------------

func (h *Handler) current(c *gin.Context) (*authz.Principal, *resident, error) {
	p, err := h.Guards.RequireResident(c)
	if err != nil {
		return nil, nil, err
	}
	rec, err := residents.Current(c, h.DB, p)
	if err != nil {
		return nil, nil, err
	}
	var r resident
	if err := h.DB.Collection("residents").FindOne(c, bson.D{{Key: "_id", Value: rec.ID}}).Decode(&r); err != nil {
		return nil, nil, err
	}
	return p, &r, nil
}

func (r *resident) status() string {
	if r.Khata != nil && r.Khata.Status != "" {
		return r.Khata.Status
	}
	return "NONE"
}

type billOut struct {
	Amount    int64  `json:"amount"`
	InvoiceID string `json:"invoiceId"`
	Items     int64  `json:"items"`
	Label     string `json:"label"`
	Paid      bool   `json:"paid"`
}

type mineOut struct {
	Bills    []billOut  `json:"bills"`
	Entries  []entryOut `json:"entries"`
	Items    []itemOut  `json:"items"`
	Status   string     `json:"status"`
	Unbilled int64      `json:"unbilled"`
}

// view is getResidentKhata. It re-reads the resident, because act may have just
// changed their khata status.
func (h *Handler) view(ctx context.Context, id bson.ObjectID) (*mineOut, error) {
	var r resident
	if err := h.DB.Collection("residents").FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&r); err != nil {
		return nil, err
	}
	items, err := h.items(ctx, r.Hostel)
	if err != nil {
		return nil, err
	}
	coll := h.DB.Collection("khataentries")
	cur, err := coll.Find(ctx, bson.D{{Key: "residentId", Value: r.ID}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(100))
	if err != nil {
		return nil, err
	}
	var entries []entry
	if err := cur.All(ctx, &entries); err != nil {
		return nil, err
	}
	cur, err = coll.Aggregate(ctx, bson.A{
		bson.D{{Key: "$match", Value: bson.D{{Key: "invoiceId", Value: bson.D{{Key: "$ne", Value: nil}}}, {Key: "residentId", Value: r.ID}, {Key: "status", Value: "GIVEN"}}}},
		bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$invoiceId"}, {Key: "amount", Value: bson.D{{Key: "$sum", Value: "$amount"}}}, {Key: "items", Value: bson.D{{Key: "$sum", Value: "$quantity"}}}}}},
	})
	if err != nil {
		return nil, err
	}
	var billed []struct {
		ID     bson.ObjectID `bson:"_id"`
		Amount int64         `bson:"amount"`
		Items  int64         `bson:"items"`
	}
	if err := cur.All(ctx, &billed); err != nil {
		return nil, err
	}
	out := &mineOut{Bills: []billOut{}, Entries: make([]entryOut, len(entries)), Items: []itemOut{}, Status: r.status()}
	if len(billed) > 0 {
		ids := bson.A{}
		sums := map[bson.ObjectID]int{}
		for i, b := range billed {
			ids = append(ids, b.ID)
			sums[b.ID] = i
		}
		cur, err := h.DB.Collection("invoices").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "VOID"}}}})
		if err != nil {
			return nil, err
		}
		var invoices []struct {
			ID     bson.ObjectID `bson:"_id"`
			Period *string       `bson:"period"`
			Status string        `bson:"status"`
		}
		if err := cur.All(ctx, &invoices); err != nil {
			return nil, err
		}
		sort.SliceStable(invoices, func(i, j int) bool {
			a, b := "", ""
			if invoices[i].Period != nil {
				a = *invoices[i].Period
			}
			if invoices[j].Period != nil {
				b = *invoices[j].Period
			}
			return a > b
		})
		for _, inv := range invoices {
			label := "Bill"
			if inv.Period != nil && *inv.Period != "" {
				label = bs.FormatPeriod(*inv.Period)
				if label == "" {
					label = *inv.Period
				}
			}
			sum := billed[sums[inv.ID]]
			out.Bills = append(out.Bills, billOut{sum.Amount, inv.ID.Hex(), sum.Items, label, inv.Status == "PAID"})
		}
	}
	for i := range entries {
		out.Entries[i] = entries[i].out(nil)
		if entries[i].Status == "GIVEN" && entries[i].InvoiceID == nil {
			out.Unbilled += entries[i].Amount
		}
	}
	for i := range items {
		if items[i].live() {
			out.Items = append(out.Items, items[i].out())
		}
	}
	return out, nil
}

func (h *Handler) mine(c *gin.Context) {
	_, r, err := h.current(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.view(c, r.ID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Khata")
}

func (h *Handler) act(c *gin.Context) {
	_, r, err := h.current(c)
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
	action, itemID, entryID, note := "", "", "", ""
	quantity := int64(0)
	if f.M != nil {
		action, _ = f.M["action"].(string)
		switch action {
		case "OPEN":
		case "ASK":
			itemID, _ = f.Str("itemId", valid.S{})
			note, _ = f.Str("note", valid.S{Opt: true, Trim: true, Max: 120})
			n, _ := f.Num("quantity", valid.N{Int: true, Min: valid.P(1), Max: valid.P(20)})
			quantity = int64(n)
		case "CANCEL":
			entryID, _ = f.Str("entryId", valid.S{})
		default:
			f.Is.Add("action", "Invalid discriminator value. Expected 'OPEN' | 'ASK' | 'CANCEL'")
		}
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.apply(c, r, action, itemID, entryID, note, quantity); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.view(c, r.ID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Khata updated")
}

func where(r *resident, format string) string {
	if r.Room == nil || *r.Room == "" {
		return ""
	}
	return strings.ReplaceAll(format, "%", *r.Room)
}

func (h *Handler) apply(c *gin.Context, r *resident, action, itemID, entryID, note string, quantity int64) error {
	status := r.status()
	now := time.Now().UTC().Truncate(time.Millisecond)
	switch action {
	case "OPEN":
		if status == "ACTIVE" || status == "REQUESTED" {
			return nil
		}
		if _, err := h.DB.Collection("residents").UpdateOne(c, bson.D{{Key: "_id", Value: r.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "khata", Value: bson.D{{Key: "requestedAt", Value: now}, {Key: "status", Value: "REQUESTED"}}}, {Key: "updatedAt", Value: now}}}}); err != nil {
			return err
		}
		staff, err := residents.HostelStaffUserIDs(c, h.DB, r.Hostel, false)
		if err != nil {
			return err
		}
		h.notify(c, staff, "Khata request", r.name()+where(r, " (room %)")+" asked to open a khata.", r.Hostel, pageStaff, ordered.Map{{Key: "residentId", Value: r.ID.Hex()}, {Key: "type", Value: "KHATA_REQUEST"}}, true)
		h.changed(c, r.Hostel)
		return nil
	case "CANCEL":
		decided := httpx.NewError(409, "KHATA_ENTRY_DECIDED", "It was already answered.", nil)
		id, err := bson.ObjectIDFromHex(entryID)
		if err != nil {
			return decided
		}
		res, err := h.DB.Collection("khataentries").UpdateOne(c, bson.D{{Key: "_id", Value: id}, {Key: "residentId", Value: r.ID}, {Key: "status", Value: "REQUESTED"}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "decidedAt", Value: now}, {Key: "status", Value: "CANCELLED"}, {Key: "updatedAt", Value: now}}}})
		if err != nil {
			return err
		}
		if res.ModifiedCount == 0 {
			return decided
		}
		h.Notify.SettleAction(c, "KHATA", bson.D{{Key: "entryId", Value: entryID}, {Key: "type", Value: "KHATA_ASK"}}, "CANCEL")
		h.changed(c, r.Hostel)
		return nil
	}
	if status != "ACTIVE" {
		return httpx.NewError(409, "KHATA_NOT_ACTIVE", "Your khata is not open yet.", nil)
	}
	items, err := h.items(c, r.Hostel)
	if err != nil {
		return err
	}
	var found *item
	for i := range items {
		if items[i].ID.Hex() == itemID && items[i].live() {
			found = &items[i]
			break
		}
	}
	if found == nil {
		return httpx.NewError(404, "KHATA_ITEM_NOT_FOUND", "That item is not on the list any more.", nil)
	}
	coll := h.DB.Collection("khataentries")
	waiting, err := coll.CountDocuments(c, bson.D{{Key: "residentId", Value: r.ID}, {Key: "status", Value: "REQUESTED"}})
	if err != nil {
		return err
	}
	if waiting >= maxWaiting {
		return httpx.NewError(409, "KHATA_ENTRY_DECIDED", "You have "+strconv.FormatInt(waiting, 10)+" asks waiting. Wait for the cook to answer them first.", nil)
	}
	id := bson.NewObjectID()
	doc := bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: r.Hostel}, {Key: "residentId", Value: r.ID}, {Key: "itemId", Value: found.ID}, {Key: "name", Value: found.Name}, {Key: "unitPrice", Value: found.Price}, {Key: "quantity", Value: quantity}, {Key: "amount", Value: found.Price * quantity}}
	if note != "" {
		doc = append(doc, bson.E{Key: "note", Value: note})
	}
	doc = append(doc, bson.E{Key: "status", Value: "REQUESTED"}, bson.E{Key: "invoiceId", Value: nil}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := coll.InsertOne(c, doc); err != nil {
		return err
	}
	cur, err := h.DB.Collection("cookaccounts").Find(c, bson.D{{Key: "hostelId", Value: r.Hostel}, {Key: "status", Value: "ACTIVE"}, {Key: "userId", Value: bson.D{{Key: "$ne", Value: nil}}}})
	if err != nil {
		return err
	}
	var cooks []struct {
		UserID bson.ObjectID `bson:"userId"`
	}
	if err := cur.All(c, &cooks); err != nil {
		return err
	}
	audience, page := []string{}, pageCook
	for _, x := range cooks {
		audience = append(audience, x.UserID.Hex())
	}
	if len(audience) == 0 {
		page = pageStaff
		if audience, err = residents.HostelStaffUserIDs(c, h.DB, r.Hostel, false); err != nil {
			return err
		}
	}
	text := r.name() + where(r, ", room %") + " asked on khata."
	if note != "" {
		text += " “" + note + "”"
	}
	h.notify(c, audience, found.Name+" ×"+strconv.FormatInt(quantity, 10), text, r.Hostel, page, ordered.Map{{Key: "entryId", Value: id.Hex()}, {Key: "type", Value: "KHATA_ASK"}}, true)
	h.changed(c, r.Hostel)
	return nil
}
