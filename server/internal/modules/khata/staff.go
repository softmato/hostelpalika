package khata

import (
	"context"
	"errors"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// The staff side of khata: the warden's screen, the item list, opening accounts.

func (h *Handler) registerStaff(v1 *gin.RouterGroup) {
	v1.GET("/hostel-admin/finance/khata", h.overview)
	v1.PUT("/hostel-admin/finance/khata", h.saveItems)
	v1.POST("/hostel-admin/finance/khata/residents/:residentId", h.decideAccount)
}

type accountOut struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	RequestedAt any    `json:"requestedAt"`
	RoomNumber  any    `json:"roomNumber"`
	Unbilled    int64  `json:"unbilled"`
}

type overviewOut struct {
	Accounts []accountOut `json:"accounts"`
	Items    []itemOut    `json:"items"`
	Requests []accountOut `json:"requests"`
	Recent   []entryOut   `json:"recent"`
	Waiting  []entryOut   `json:"waiting"`
}

// staffView is getKhataOverview: everything the warden's Khata screen draws, in one read.
func (h *Handler) staffView(ctx context.Context, hostel bson.ObjectID) (*overviewOut, error) {
	items, err := h.items(ctx, hostel)
	if err != nil {
		return nil, err
	}
	cur, err := h.DB.Collection("residents").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
		{Key: "khata.status", Value: bson.D{{Key: "$in", Value: bson.A{"REQUESTED", "ACTIVE"}}}}},
		options.Find().SetProjection(bson.D{{Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}, {Key: "roomNumber", Value: 1}, {Key: "khata", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var people []struct {
		ID    bson.ObjectID `bson:"_id"`
		First string        `bson:"firstName"`
		Last  string        `bson:"lastName"`
		Room  *string       `bson:"roomNumber"`
		Khata struct {
			RequestedAt *time.Time `bson:"requestedAt"`
			Status      string     `bson:"status"`
		} `bson:"khata"`
	}
	if err := cur.All(ctx, &people); err != nil {
		return nil, err
	}
	cur, err = h.DB.Collection("khataentries").Aggregate(ctx, bson.A{
		bson.D{{Key: "$match", Value: bson.D{{Key: "hostelId", Value: hostel}, {Key: "invoiceId", Value: nil}, {Key: "status", Value: "GIVEN"}}}},
		bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$residentId"}, {Key: "amount", Value: bson.D{{Key: "$sum", Value: "$amount"}}}}}},
	})
	if err != nil {
		return nil, err
	}
	var sums []struct {
		ID     bson.ObjectID `bson:"_id"`
		Amount int64         `bson:"amount"`
	}
	if err := cur.All(ctx, &sums); err != nil {
		return nil, err
	}
	unbilled := map[bson.ObjectID]int64{}
	for _, s := range sums {
		unbilled[s.ID] = s.Amount
	}
	orders, err := h.listOrders(ctx, hostel)
	if err != nil {
		return nil, err
	}
	out := &overviewOut{Accounts: []accountOut{}, Items: make([]itemOut, len(items)), Requests: []accountOut{}, Recent: orders.Recent, Waiting: orders.Waiting}
	for i := range items {
		out.Items[i] = items[i].out()
	}
	for i := range people {
		r := &people[i]
		var asked, room any
		if r.Khata.RequestedAt != nil {
			asked = httpx.ISO(*r.Khata.RequestedAt)
		}
		if r.Room != nil {
			room = *r.Room
		}
		row := accountOut{r.ID.Hex(), (&resident{First: r.First, Last: r.Last}).name(), asked, room, unbilled[r.ID]}
		switch {
		case r.Khata.Status == "ACTIVE":
			out.Accounts = append(out.Accounts, row)
		case r.Khata.Status == "REQUESTED":
			out.Requests = append(out.Requests, row)
		}
	}
	// ponytail: strings.Compare stands in for localeCompare; names here are plain ASCII in practice.
	sort.SliceStable(out.Accounts, func(i, j int) bool {
		a, b := out.Accounts[i], out.Accounts[j]
		if a.Unbilled != b.Unbilled {
			return a.Unbilled > b.Unbilled
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	return out, nil
}

func (h *Handler) overview(c *gin.Context) {
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
	cache.Respond(c, h.Cache, p.HostelIDs, p.UserID, "khata:"+hostel.Hex(), "Khata", func() (*overviewOut, error) { return h.staffView(c, hostel) })
}

var hex24 = regexp.MustCompile(`(?i)^[a-f\d]{24}$`)

func (h *Handler) saveItems(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "recordCash")
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
	list, _ := f.Array("items", false, false)
	next := bson.A{}
	out := []itemOut{}
	for i, raw := range list {
		sub := valid.NewForm(raw)
		yes := true
		active, _ := sub.Bool("active", true, &yes)
		id, _ := sub.Str("id", valid.S{Opt: true})
		var image *bson.ObjectID
		if v, ok := sub.M["imageAssetId"]; ok && v != nil {
			if s, _ := sub.Str("imageAssetId", valid.S{Re: hex24, ReSrc: `/^[a-f\d]{24}$/i`}); s != "" {
				oid, _ := bson.ObjectIDFromHex(strings.ToLower(s))
				image = &oid
			}
		}
		name, _ := sub.Str("name", valid.S{Trim: true, Min: 1, Max: 40})
		price, _ := sub.Num("price", valid.N{Int: true, Min: valid.P(1), Max: valid.P(100000)})
		f.Join("items."+strconv.Itoa(i), sub)
		oid, err := bson.ObjectIDFromHex(id)
		if err != nil {
			oid = bson.NewObjectID()
		}
		var img any
		if image != nil {
			img = *image
		}
		next = append(next, bson.D{{Key: "_id", Value: oid}, {Key: "name", Value: name}, {Key: "price", Value: int64(price)}, {Key: "active", Value: active}, {Key: "imageAssetId", Value: img}})
		x := item{ID: oid, Active: &active, Image: image, Name: name, Price: int64(price)}
		out = append(out, x.out())
	}
	f.Size("items", len(list), 0, 60, "", false)
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
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := h.DB.Collection("hostelsettings").UpdateOne(c, bson.D{{Key: "hostelId", Value: hostel}}, bson.D{
		{Key: "$set", Value: bson.D{{Key: "khataItems", Value: next}, {Key: "updatedBy", Value: actor}, {Key: "updatedAt", Value: now}}},
		{Key: "$setOnInsert", Value: bson.D{{Key: "createdBy", Value: actor}, {Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}},
	}, options.UpdateOne().SetUpsert(true)); err != nil {
		httpx.Fail(c, err)
		return
	}
	h.changed(c, hostel)
	httpx.OK(c, ordered.Map{{Key: "items", Value: out}}, "Khata items saved")
}

func (h *Handler) decideAccount(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "recordCash")
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
	action, _ := f.Enum("action", false, nil, "APPROVE", "DECLINE", "CLOSE")
	requested, _ := f.Str("hostelId", valid.S{Opt: true})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, requested)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	raw := c.Param("residentId")
	missing := finance.Err("KHATA_ENTRY_NOT_FOUND", "Resident was not found.")
	id, err := bson.ObjectIDFromHex(raw)
	if err != nil {
		httpx.Fail(c, missing)
		return
	}
	status := map[string]string{"APPROVE": "ACTIVE", "DECLINE": "DECLINED", "CLOSE": "CLOSED"}[action]
	actor, _ := bson.ObjectIDFromHex(p.UserID)
	var r resident
	err = h.DB.Collection("residents").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "khata.decidedAt", Value: time.Now().UTC().Truncate(time.Millisecond)}, {Key: "khata.decidedBy", Value: actor}, {Key: "khata.status", Value: status},
			{Key: "updatedAt", Value: time.Now().UTC().Truncate(time.Millisecond)}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After).SetProjection(bson.D{{Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}, {Key: "userId", Value: 1}})).Decode(&r)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			err = missing
		}
		httpx.Fail(c, err)
		return
	}
	if r.UserID != nil {
		title, text := "Khata", "Your khata is closed. Anything already taken stays on your next bill."
		switch status {
		case "ACTIVE":
			title, text = "Your khata is open", "Ask for items from the Khata screen. What you take is added to next month's bill."
		case "DECLINED":
			text = "The hostel did not open a khata for you."
		}
		h.notify(c, []string{r.UserID.Hex()}, title, text, hostel, pageMine, ordered.Map{{Key: "residentId", Value: raw}, {Key: "type", Value: "KHATA_ACCOUNT"}}, false)
	}
	h.Notify.SettleAction(c, "KHATA", bson.D{{Key: "residentId", Value: raw}, {Key: "type", Value: "KHATA_REQUEST"}}, action)
	h.changed(c, hostel)
	httpx.OK(c, ordered.Map{{Key: "residentId", Value: raw}, {Key: "status", Value: status}}, "Khata updated")
}
