package store

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/push"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

/* Cart ----------------------------------------------------------------------- */

// buyer is requireHostelAdminPrincipal + resolveStoreHostelId.
func (h *Handler) buyer(c *gin.Context) (*authz.Principal, bson.ObjectID, bool) {
	p, err := h.Guards.RequireHostelAdmin(c)
	if err != nil {
		httpx.Fail(c, err)
		return nil, bson.ObjectID{}, false
	}
	id, err := hostelScope(p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return nil, id, false
	}
	return p, id, true
}

func hostelScope(p *authz.Principal, requested string) (bson.ObjectID, error) {
	if requested != "" {
		if !authz.CanAccessHostel(p, requested) {
			return bson.ObjectID{}, storeErr(404, "NOT_FOUND", "Not found.")
		}
		return objectID(requested, "hostel id")
	}
	if len(p.HostelIDs) == 1 {
		return objectID(p.HostelIDs[0], "hostel id")
	}
	return bson.ObjectID{}, storeErr(422, "HOSTEL_SCOPE_REQUIRED", "Choose which hostel this order is for.")
}

type cartItem struct {
	AddedAt   *time.Time    `bson:"addedAt"`
	ProductID bson.ObjectID `bson:"productId"`
	Quantity  int64         `bson:"quantity"`
}

type cartRow struct {
	ID        bson.ObjectID `bson:"_id"`
	Items     []cartItem    `bson:"items"`
	UpdatedAt *time.Time    `bson:"updatedAt"`
}

// cartLine is one line of readCart, kept typed for placeOrder.
type cartLine struct {
	item      cartItem
	product   productRow
	quantity  int64
	limitedBy string
}

func (l cartLine) out() ordered.Map {
	o := ordered.Map{}
	if l.item.AddedAt != nil {
		o = append(o, ordered.Pair{Key: "addedAt", Value: httpx.ISO(*l.item.AddedAt)})
	}
	var limited any
	if l.limitedBy != "none" {
		limited = l.limitedBy
	}
	return append(o, ordered.Map{{Key: "availableQuantity", Value: l.quantity}, {Key: "lineTotal", Value: l.quantity * l.product.Price}, {Key: "limitedBy", Value: limited},
		{Key: "product", Value: l.product.out(nil)}, {Key: "quantity", Value: l.quantity}, {Key: "requestedQuantity", Value: l.item.Quantity}, {Key: "unitPrice", Value: l.product.Price}}...)
}

type cartView struct {
	lines   []cartLine
	totals  totals
	updated *time.Time
	removed []string
	cfg     storeConfig
}

func (v cartView) out(h *Handler, clamped any, withClamped bool) ordered.Map {
	items := make([]ordered.Map, len(v.lines))
	for i, l := range v.lines {
		items[i] = l.out()
	}
	cart := ordered.Map{{Key: "config", Value: publicConfig(v.cfg, h.Now())}, {Key: "items", Value: items}, {Key: "totals", Value: v.totals.out()}}
	if v.updated != nil && len(v.lines) > 0 {
		cart = append(cart, ordered.Pair{Key: "updatedAt", Value: httpx.ISO(*v.updated)})
	}
	o := ordered.Map{{Key: "cart", Value: cart}, {Key: "removed", Value: v.removed}}
	if withClamped {
		o = append(o, ordered.Pair{Key: "clamped", Value: clamped})
	}
	return o
}

// readCart quotes the cart live from the catalogue; products gone dead are
// dropped from the row (best effort, as in TS).
func (h *Handler) readCart(ctx context.Context, hostel bson.ObjectID) (cartView, error) {
	v := cartView{cfg: h.config(ctx), removed: []string{}}
	var cart cartRow
	err := h.col("storecarts").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}).Decode(&cart)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return v, err
	}
	if len(cart.Items) == 0 {
		return v, nil
	}
	ids := bson.A{}
	for _, it := range cart.Items {
		ids = append(ids, it.ProductID)
	}
	products, err := findAll[productRow](ctx, h.col("storeproducts"), bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "isActive", Value: true}})
	if err != nil {
		return v, err
	}
	byID := map[bson.ObjectID]productRow{}
	for _, p := range products {
		byID[p.ID] = p
	}
	dead := bson.A{}
	var buyable []line
	for _, it := range cart.Items {
		p, ok := byID[it.ProductID]
		if !ok {
			v.removed = append(v.removed, it.ProductID.Hex())
			dead = append(dead, it.ProductID)
			continue
		}
		q, reason := p.clamp(it.Quantity)
		v.lines = append(v.lines, cartLine{item: it, product: p, quantity: q, limitedBy: reason})
		if q > 0 {
			buyable = append(buyable, line{q, p.Price})
		}
	}
	if len(dead) > 0 {
		_, _ = h.col("storecarts").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}, bson.D{{Key: "$pull", Value: bson.D{{Key: "items", Value: bson.D{{Key: "productId", Value: bson.D{{Key: "$in", Value: dead}}}}}}}})
	}
	v.totals, v.updated = cartTotals(buyable, v.cfg), cart.UpdatedAt
	return v, nil
}

func (h *Handler) cart(c *gin.Context) {
	_, hostel, ok := h.buyer(c)
	if !ok {
		return
	}
	v, err := h.readCart(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, v.out(h, nil, false), "Cart loaded")
}

func (h *Handler) cartCount(c *gin.Context) {
	_, hostel, ok := h.buyer(c)
	if !ok {
		return
	}
	var cart cartRow
	if err := h.col("storecarts").FindOne(c, bson.D{{Key: "hostelId", Value: hostel}}).Decode(&cart); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, err)
		return
	}
	var n int64
	for _, it := range cart.Items {
		n += it.Quantity
	}
	httpx.OK(c, ordered.Map{{Key: "itemCount", Value: n}, {Key: "lineCount", Value: len(cart.Items)}}, "Cart count loaded")
}

func (h *Handler) liveProduct(ctx context.Context, raw string) (productRow, error) {
	var p productRow
	id, err := objectID(raw, "product id")
	if err != nil {
		return p, err
	}
	err = h.col("storeproducts").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isActive", Value: true}}).Decode(&p)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return p, storeErr(404, "PRODUCT_NOT_FOUND", "That product is no longer available.")
	}
	return p, err
}

func (h *Handler) respondCart(c *gin.Context, hostel bson.ObjectID, reason, msg string) {
	v, err := h.readCart(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var clamped any
	if reason != "none" {
		clamped = reason
	}
	httpx.OK(c, v.out(h, clamped, true), msg)
}

func (h *Handler) addItem(c *gin.Context) {
	p, hostel, ok := h.buyer(c)
	if !ok {
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	productID, _ := f.Str("productId", valid.S{Trim: true, Min: 1})
	qty, _ := f.Num("quantity", valid.N{Coerce: true, Int: true, Min: valid.P(1), Max: valid.P(10000), Default: valid.P(1)})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	cfg := h.config(c)
	if !cfg.IsOpen {
		httpx.Fail(c, storeErr(409, "STORE_CLOSED", cfg.ClosedMessage))
		return
	}
	prod, err := h.liveProduct(c, productID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := h.Now().UTC().Truncate(time.Millisecond)
	user, _ := bson.ObjectIDFromHex(p.UserID)
	carts := h.col("storecarts")
	var cart cartRow
	err = carts.FindOneAndUpdate(c, bson.D{{Key: "hostelId", Value: hostel}},
		bson.D{{Key: "$setOnInsert", Value: bson.D{{Key: "hostelId", Value: hostel}, {Key: "items", Value: bson.A{}}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&cart)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var existing int64
	idx := slices.IndexFunc(cart.Items, func(it cartItem) bool { return it.ProductID == prod.ID })
	if idx >= 0 {
		existing = cart.Items[idx].Quantity
	}
	q, reason := prod.clamp(existing + int64(qty))
	if q == 0 {
		httpx.Fail(c, storeErr(409, "PRODUCT_OUT_OF_STOCK", prod.Name+" is out of stock."))
		return
	}
	if idx >= 0 {
		_, err = carts.UpdateOne(c, bson.D{{Key: "_id", Value: cart.ID}, {Key: "items.productId", Value: prod.ID}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "items.$.quantity", Value: q}, {Key: "updatedBy", Value: user}, {Key: "updatedAt", Value: now}}}})
	} else {
		_, err = carts.UpdateOne(c, bson.D{{Key: "_id", Value: cart.ID}},
			bson.D{{Key: "$push", Value: bson.D{{Key: "items", Value: bson.D{{Key: "productId", Value: prod.ID}, {Key: "quantity", Value: q}, {Key: "addedAt", Value: now}}}}},
				{Key: "$set", Value: bson.D{{Key: "updatedBy", Value: user}, {Key: "updatedAt", Value: now}}}})
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.respondCart(c, hostel, reason, "Added to cart")
}

func (h *Handler) pullItem(ctx context.Context, hostel, user bson.ObjectID, raw string) error {
	id, err := objectID(raw, "product id")
	if err != nil {
		return err
	}
	_, err = h.col("storecarts").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: hostel}},
		bson.D{{Key: "$pull", Value: bson.D{{Key: "items", Value: bson.D{{Key: "productId", Value: id}}}}}, {Key: "$set", Value: bson.D{{Key: "updatedBy", Value: user}, {Key: "updatedAt", Value: h.Now().UTC()}}}})
	return err
}

func (h *Handler) updateItem(c *gin.Context) {
	p, hostel, ok := h.buyer(c)
	if !ok {
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	qty, _ := f.Num("quantity", valid.N{Coerce: true, Int: true, Min: valid.P(0), Max: valid.P(10000)})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	user, _ := bson.ObjectIDFromHex(p.UserID)
	remove := func() {
		if err := h.pullItem(c, hostel, user, c.Param("productId")); err != nil {
			httpx.Fail(c, err)
			return
		}
		h.respondCart(c, hostel, "none", "Cart updated")
	}
	if qty == 0 {
		remove()
		return
	}
	prod, err := h.liveProduct(c, c.Param("productId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q, reason := prod.clamp(int64(qty))
	if q == 0 {
		remove()
		return
	}
	res, err := h.col("storecarts").UpdateOne(c, bson.D{{Key: "hostelId", Value: hostel}, {Key: "items.productId", Value: prod.ID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "items.$.quantity", Value: q}, {Key: "updatedBy", Value: user}, {Key: "updatedAt", Value: h.Now().UTC()}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if res.MatchedCount == 0 {
		httpx.Fail(c, storeErr(404, "CART_ITEM_NOT_FOUND", "That item is not in your cart."))
		return
	}
	h.respondCart(c, hostel, reason, "Cart updated")
}

func (h *Handler) removeItem(c *gin.Context) {
	p, hostel, ok := h.buyer(c)
	if !ok {
		return
	}
	user, _ := bson.ObjectIDFromHex(p.UserID)
	if err := h.pullItem(c, hostel, user, c.Param("productId")); err != nil {
		httpx.Fail(c, err)
		return
	}
	h.respondCart(c, hostel, "none", "Removed from cart")
}

func (h *Handler) clearCart(c *gin.Context) {
	p, hostel, ok := h.buyer(c)
	if !ok {
		return
	}
	user, _ := bson.ObjectIDFromHex(p.UserID)
	if _, err := h.col("storecarts").UpdateOne(c, bson.D{{Key: "hostelId", Value: hostel}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "items", Value: bson.A{}}, {Key: "updatedBy", Value: user}, {Key: "updatedAt", Value: h.Now().UTC()}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	h.respondCart(c, hostel, "none", "Cart emptied")
}

/* Orders --------------------------------------------------------------------- */

type delivery struct {
	AddressLine string  `bson:"addressLine"`
	City        *string `bson:"city,omitempty"`
	ContactName string  `bson:"contactName"`
	Note        *string `bson:"note,omitempty"`
	Phone       string  `bson:"phone"`
}

type orderItem struct {
	ImageAssetID    *string       `bson:"imageAssetId"`
	ImageURL        *string       `bson:"imageUrl"`
	LineTotal       int64         `bson:"lineTotal"`
	Name            string        `bson:"name"`
	ProductID       bson.ObjectID `bson:"productId"`
	Quantity        int64         `bson:"quantity"`
	StockAfterOrder *int64        `bson:"stockAfterOrder"`
	Unit            *string       `bson:"unit"`
	UnitPrice       int64         `bson:"unitPrice"`
}

type timelineEntry struct {
	At     *time.Time `bson:"at"`
	Note   *string    `bson:"note"`
	Status string     `bson:"status"`
}

type orderRow struct {
	ID              bson.ObjectID   `bson:"_id"`
	CancelledAt     *time.Time      `bson:"cancelledAt"`
	CancelledReason *string         `bson:"cancelledReason"`
	CreatedAt       *time.Time      `bson:"createdAt"`
	Delivery        delivery        `bson:"delivery"`
	DeliveredAt     *time.Time      `bson:"deliveredAt"`
	DeliveryFee     int64           `bson:"deliveryFee"`
	DeliveryPromise *string         `bson:"deliveryPromise"`
	HostelID        bson.ObjectID   `bson:"hostelId"`
	Items           []orderItem     `bson:"items"`
	OrderNumber     string          `bson:"orderNumber"`
	PaymentMethod   string          `bson:"paymentMethod"`
	PaymentStatus   string          `bson:"paymentStatus"`
	PlacedBy        bson.ObjectID   `bson:"placedBy"`
	Status          string          `bson:"status"`
	Subtotal        int64           `bson:"subtotal"`
	Timeline        []timelineEntry `bson:"timeline"`
	Total           int64           `bson:"total"`
	UpdatedAt       *time.Time      `bson:"updatedAt"`
}

func isoOrNil(t *time.Time) any {
	if t == nil {
		return nil
	}
	return httpx.ISO(*t)
}

func (o orderRow) itemCount() int64 {
	var n int64
	for _, it := range o.Items {
		n += it.Quantity
	}
	return n
}

func (o orderRow) promise() string { return or(o.DeliveryPromise, "the promised window") }

// out is serializeOrder.
func (o orderRow) out() ordered.Map {
	m := ordered.Map{{Key: "cancelledAt", Value: isoOrNil(o.CancelledAt)}, {Key: "cancelledReason", Value: or(o.CancelledReason, "")}, {Key: "canCancel", Value: buyerCanCancel(o.Status)}}
	if o.CreatedAt != nil {
		m = append(m, ordered.Pair{Key: "createdAt", Value: httpx.ISO(*o.CreatedAt)})
	}
	items := make([]ordered.Map, len(o.Items))
	for i, it := range o.Items {
		var stock any
		if it.StockAfterOrder != nil {
			stock = *it.StockAfterOrder
		}
		items[i] = ordered.Map{{Key: "imageAssetId", Value: or(it.ImageAssetID, "")}, {Key: "imageUrl", Value: or(it.ImageURL, "")}, {Key: "lineTotal", Value: it.LineTotal},
			{Key: "name", Value: it.Name}, {Key: "productId", Value: it.ProductID.Hex()}, {Key: "quantity", Value: it.Quantity}, {Key: "stockAfterOrder", Value: stock},
			{Key: "unit", Value: or(it.Unit, "piece")}, {Key: "unitPrice", Value: it.UnitPrice}}
	}
	timeline := make([]ordered.Map, len(o.Timeline))
	for i, t := range o.Timeline {
		e := ordered.Map{}
		if t.At != nil {
			e = append(e, ordered.Pair{Key: "at", Value: httpx.ISO(*t.At)})
		}
		label, ok := statusLabel[t.Status]
		if !ok {
			label = t.Status
		}
		timeline[i] = append(e, ordered.Map{{Key: "note", Value: or(t.Note, "")}, {Key: "status", Value: t.Status}, {Key: "statusLabel", Value: label}}...)
	}
	m = append(m, ordered.Map{{Key: "deliveredAt", Value: isoOrNil(o.DeliveredAt)},
		{Key: "delivery", Value: ordered.Map{{Key: "addressLine", Value: o.Delivery.AddressLine}, {Key: "city", Value: or(o.Delivery.City, "")}, {Key: "contactName", Value: o.Delivery.ContactName},
			{Key: "note", Value: or(o.Delivery.Note, "")}, {Key: "phone", Value: o.Delivery.Phone}}},
		{Key: "deliveryFee", Value: o.DeliveryFee}, {Key: "deliveryPromise", Value: or(o.DeliveryPromise, "")}, {Key: "hostelId", Value: o.HostelID.Hex()}, {Key: "id", Value: o.ID.Hex()},
		{Key: "itemCount", Value: o.itemCount()}, {Key: "items", Value: items}, {Key: "orderNumber", Value: o.OrderNumber}, {Key: "paymentMethod", Value: o.PaymentMethod},
		{Key: "paymentStatus", Value: o.PaymentStatus}, {Key: "status", Value: o.Status}, {Key: "statusLabel", Value: statusLabel[o.Status]}, {Key: "subtotal", Value: o.Subtotal},
		{Key: "timeline", Value: timeline}, {Key: "total", Value: o.Total}}...)
	if o.UpdatedAt != nil {
		m = append(m, ordered.Pair{Key: "updatedAt", Value: httpx.ISO(*o.UpdatedAt)})
	}
	return m
}

var deliveryPhone = mustRe(`^[0-9+][0-9\s-]*$`)

func (h *Handler) placeOrder(c *gin.Context) {
	p, hostel, ok := h.buyer(c)
	if !ok {
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	var d delivery
	f.Nest("delivery", false, func(sub *valid.Form) {
		d.AddressLine, _ = sub.Str("addressLine", valid.S{Trim: true, Min: 1, Max: 300})
		if v, ok := sub.Str("city", valid.S{Opt: true, Trim: true, Max: 120}); ok {
			d.City = &v
		}
		d.ContactName, _ = sub.Str("contactName", valid.S{Trim: true, Min: 1, Max: 120})
		if v, ok := sub.Str("note", valid.S{Opt: true, Trim: true, Max: 500}); ok {
			d.Note = &v
		}
		d.Phone, _ = sub.Str("phone", valid.S{Trim: true, Min: 7, Max: 20, Re: deliveryPhone, ReMsg: "Use digits, spaces or hyphens."})
	})
	method := "COD"
	if f.Present("paymentMethod") && f.M["paymentMethod"] != "COD" {
		f.Is.Add("paymentMethod", `Invalid input: expected "COD"`)
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	cfg := h.config(c)
	now := h.Now().UTC().Truncate(time.Millisecond)
	promise := deliveryPromise(cfg, now)
	if !cfg.IsOpen {
		httpx.Fail(c, storeErr(409, "STORE_CLOSED", cfg.ClosedMessage))
		return
	}
	v, err := h.readCart(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var lines []cartLine
	for _, l := range v.lines {
		if l.quantity > 0 {
			lines = append(lines, l)
		}
	}
	if len(lines) == 0 {
		httpx.Fail(c, storeErr(422, "CART_EMPTY", "Your cart is empty."))
		return
	}
	for _, l := range v.lines {
		if l.quantity < l.item.Quantity {
			verb := "are"
			if l.quantity == 1 {
				verb = "is"
			}
			httpx.Fail(c, storeErr(409, "CART_QUANTITY_UNAVAILABLE", fmt.Sprintf("Only %d × %s %s available. Update your cart and try again.", l.quantity, l.product.Name, verb)))
			return
		}
	}
	if v.totals.Total > cfg.MaxOrderTotal {
		httpx.Fail(c, storeErr(422, "ORDER_TOTAL_TOO_LARGE", "This order is above the store's single-order limit. Please split it or get in touch."))
		return
	}
	user, _ := bson.ObjectIDFromHex(p.UserID)
	arrives, _ := promise.Get("arrivesText")
	var order orderRow
	// Stock, the order number, the order and the emptied cart land together:
	// TS reserved stock first and gave it back by hand when a later step failed.
	err = appmongo.InTx(c, h.DB, func(ctx context.Context) error {
		items := bson.A{}
		order = orderRow{ID: bson.NewObjectID(), CreatedAt: &now, Delivery: d, DeliveryFee: v.totals.DeliveryFee, HostelID: hostel, PaymentMethod: method,
			PaymentStatus: "PENDING", PlacedBy: user, Status: "PLACED", Subtotal: v.totals.Subtotal, Total: v.totals.Total, UpdatedAt: &now}
		a := arrives.(string)
		order.DeliveryPromise = &a
		for _, l := range lines {
			var after *int64
			if l.product.TrackStock {
				var left struct {
					Stock int64 `bson:"stockQuantity"`
				}
				err := h.col("storeproducts").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: l.product.ID}, {Key: "stockQuantity", Value: bson.D{{Key: "$gte", Value: l.quantity}}}},
					bson.D{{Key: "$inc", Value: bson.D{{Key: "stockQuantity", Value: -l.quantity}}}},
					options.FindOneAndUpdate().SetReturnDocument(options.After).SetProjection(bson.D{{Key: "stockQuantity", Value: 1}})).Decode(&left)
				if errors.Is(err, mongo.ErrNoDocuments) {
					return storeErr(409, "PRODUCT_OUT_OF_STOCK", l.product.Name+" sold out while you were checking out.")
				}
				if err != nil {
					return err
				}
				after = &left.Stock
			}
			assetID, url := "", ""
			if len(l.product.Images) > 0 {
				assetID, url = or(l.product.Images[0].AssetID, ""), or(l.product.Images[0].URL, "")
			}
			unit := l.product.unit()
			it := orderItem{ImageAssetID: &assetID, ImageURL: &url, LineTotal: l.quantity * l.product.Price, Name: l.product.Name, ProductID: l.product.ID,
				Quantity: l.quantity, StockAfterOrder: after, Unit: &unit, UnitPrice: l.product.Price}
			order.Items = append(order.Items, it)
			var stock any
			if after != nil {
				stock = *after
			}
			items = append(items, bson.D{{Key: "productId", Value: it.ProductID}, {Key: "name", Value: it.Name}, {Key: "unit", Value: unit}, {Key: "imageAssetId", Value: assetID},
				{Key: "imageUrl", Value: url}, {Key: "unitPrice", Value: it.UnitPrice}, {Key: "quantity", Value: it.Quantity}, {Key: "lineTotal", Value: it.LineTotal}, {Key: "stockAfterOrder", Value: stock}})
		}
		number, err := h.orderNumber(ctx, hostel, now)
		if err != nil {
			return err
		}
		order.OrderNumber = number
		empty := ""
		order.Timeline = []timelineEntry{{At: &now, Note: &empty, Status: "PLACED"}}
		dd := bson.D{{Key: "contactName", Value: d.ContactName}, {Key: "phone", Value: d.Phone}, {Key: "addressLine", Value: d.AddressLine}}
		if d.City != nil {
			dd = append(dd, bson.E{Key: "city", Value: *d.City})
		}
		if d.Note != nil {
			dd = append(dd, bson.E{Key: "note", Value: *d.Note})
		}
		if _, err := h.col("storeorders").InsertOne(ctx, bson.D{{Key: "_id", Value: order.ID}, {Key: "orderNumber", Value: number}, {Key: "hostelId", Value: hostel}, {Key: "placedBy", Value: user},
			{Key: "items", Value: items}, {Key: "subtotal", Value: order.Subtotal}, {Key: "deliveryFee", Value: order.DeliveryFee}, {Key: "total", Value: order.Total}, {Key: "deliveryPromise", Value: a},
			{Key: "delivery", Value: dd}, {Key: "paymentMethod", Value: method}, {Key: "paymentStatus", Value: "PENDING"}, {Key: "status", Value: "PLACED"},
			{Key: "timeline", Value: bson.A{bson.D{{Key: "status", Value: "PLACED"}, {Key: "at", Value: now}, {Key: "byUserId", Value: user}, {Key: "note", Value: ""}}}},
			{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
			return err
		}
		_, err = h.col("storecarts").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}, bson.D{{Key: "$set", Value: bson.D{{Key: "items", Value: bson.A{}}, {Key: "updatedAt", Value: now}}}})
		return err
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.notifyPlaced(c, order)
	h.audit(c, "STORE_ORDER_PLACED", order, user)
	h.publish(c, realtime.Change{HostelIDs: []string{hostel.Hex()}, Platform: true})
	httpx.Write(c, 201, ordered.Map{{Key: "order", Value: order.out()}}, "Order placed")
}

// orderNumber is allocateOrderNumber: SO-YYMM-0001-ABCD, a per-hostel counter per UTC month.
func (h *Handler) orderNumber(ctx context.Context, hostel bson.ObjectID, now time.Time) (string, error) {
	period := now.Format("2006-01")
	var counter struct {
		Sequence int `bson:"sequence"`
	}
	err := h.col("receiptcounters").FindOneAndUpdate(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "kind", Value: "STORE_ORDER"}, {Key: "period", Value: period}},
		bson.D{{Key: "$inc", Value: bson.D{{Key: "sequence", Value: 1}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: now}}}, {Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&counter)
	if err != nil {
		return "", err
	}
	hex := hostel.Hex()
	return fmt.Sprintf("SO-%s-%04d-%s", now.Format("0601"), counter.Sequence, strings.ToUpper(hex[len(hex)-4:])), nil
}

type orderQuery struct {
	page   pagination.Query
	status string
	hostel string
}

func readOrderQuery(c *gin.Context, platform bool) (orderQuery, error) {
	q := valid.Query(c)
	var is valid.Issues
	out := orderQuery{page: valid.Page(q, &is), status: "all"}
	if v := valid.QueryEnum(q, "status", &is, "all", "open", "PLACED", "CONFIRMED", "PACKED", "SHIPPED", "DELIVERED", "CANCELLED"); v != nil {
		out.status = *v
	}
	if platform {
		if v := valid.QueryString(q, "hostelId", 0, 40, &is); v != nil {
			out.hostel = *v
		}
	}
	return out, is.Err()
}

func statusFilter(status string) bson.D {
	switch status {
	case "all":
		return bson.D{}
	case "open":
		return bson.D{{Key: "status", Value: bson.D{{Key: "$in", Value: openStatuses}}}}
	}
	return bson.D{{Key: "status", Value: status}}
}

var newestFirst = bson.D{{Key: "createdAt", Value: -1}}

func (h *Handler) pageOrders(ctx context.Context, filter bson.D, page pagination.Query) ([]orderRow, int64, error) {
	r := pagination.RangeOf(page)
	rows, err := findAll[orderRow](ctx, h.col("storeorders"), filter, options.Find().SetSort(newestFirst).SetSkip(int64(r.Skip)).SetLimit(int64(r.Limit)))
	if err != nil {
		return nil, 0, err
	}
	total, err := h.col("storeorders").CountDocuments(ctx, filter)
	return rows, total, err
}

func hostelIDs(p *authz.Principal) (bson.A, error) {
	out := bson.A{}
	for _, id := range p.HostelIDs {
		oid, err := objectID(id, "hostel id")
		if err != nil {
			return nil, err
		}
		out = append(out, oid)
	}
	return out, nil
}

func (h *Handler) orders(c *gin.Context) {
	p, err := h.Guards.RequireHostelAdmin(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q, err := readOrderQuery(c, false)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var ids bson.A
	if req := c.Query("hostelId"); req != "" {
		id, err := hostelScope(p, req)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		ids = bson.A{id}
	} else if ids, err = hostelIDs(p); err != nil {
		httpx.Fail(c, err)
		return
	}
	scope := bson.E{Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}}
	rows, total, err := h.pageOrders(c, append(bson.D{scope}, statusFilter(q.status)...), q.page)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	open, err := h.col("storeorders").CountDocuments(c, bson.D{scope, {Key: "status", Value: bson.D{{Key: "$in", Value: openStatuses}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]ordered.Map, len(rows))
	for i, o := range rows {
		out[i] = o.out()
	}
	httpx.OK(c, ordered.Map{{Key: "orders", Value: out}, {Key: "pagination", Value: pagination.MetaOf(q.page, int(total))},
		{Key: "summary", Value: ordered.Map{{Key: "open", Value: open}, {Key: "total", Value: total}}}}, "Orders loaded")
}

// ownOrder is an order of one of the caller's hostels; anyone else's is 404.
func (h *Handler) ownOrder(c *gin.Context, p *authz.Principal) (orderRow, error) {
	var o orderRow
	id, err := objectID(c.Param("orderId"), "order id")
	if err != nil {
		return o, err
	}
	ids, err := hostelIDs(p)
	if err != nil {
		return o, err
	}
	err = h.col("storeorders").FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}}}).Decode(&o)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return o, storeErr(404, "ORDER_NOT_FOUND", "That order was not found.")
	}
	return o, err
}

func (h *Handler) order(c *gin.Context) {
	p, err := h.Guards.RequireHostelAdmin(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	o, err := h.ownOrder(c, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "order", Value: o.out()}}, "Order loaded")
}

func (h *Handler) cancelOrder(c *gin.Context) {
	p, err := h.Guards.RequireHostelAdmin(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	o, err := h.ownOrder(c, p)
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
	reason, has := f.Str("reason", valid.S{Opt: true, Trim: true, Max: 500})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	if !buyerCanCancel(o.Status) {
		msg := "That order is already cancelled."
		if o.Status != "CANCELLED" {
			msg = "This order is " + strings.ToLower(statusLabel[o.Status]) + " — call us and we will sort it out."
		}
		httpx.Fail(c, storeErr(409, "ORDER_NOT_CANCELLABLE", msg))
		return
	}
	if !has {
		reason = "Cancelled by the hostel"
	}
	user, _ := bson.ObjectIDFromHex(p.UserID)
	updated, err := h.applyStatus(c, o, "CANCELLED", user, reason)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.afterStatus(c, updated, "STORE_ORDER_CANCELLED", user)
	httpx.OK(c, ordered.Map{{Key: "order", Value: updated.out()}}, "Order cancelled")
}

// applyStatus moves the order on and, when it is cancelled, returns its stock.
// The move is conditional on the status it was read in, so two cancels racing
// cannot both put the stock back (TS updated by id alone).
func (h *Handler) applyStatus(ctx context.Context, o orderRow, status string, actor bson.ObjectID, note string) (orderRow, error) {
	now := h.Now().UTC().Truncate(time.Millisecond)
	set := bson.D{{Key: "status", Value: status}, {Key: "updatedAt", Value: now}}
	switch status {
	case "DELIVERED":
		set = append(set, bson.E{Key: "deliveredAt", Value: now}, bson.E{Key: "paymentStatus", Value: "PAID"})
	case "CANCELLED":
		set = append(set, bson.E{Key: "cancelledAt", Value: now}, bson.E{Key: "cancelledReason", Value: note})
	}
	var updated orderRow
	err := appmongo.InTx(ctx, h.DB, func(ctx context.Context) error {
		err := h.col("storeorders").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: o.ID}, {Key: "status", Value: o.Status}},
			bson.D{{Key: "$push", Value: bson.D{{Key: "timeline", Value: bson.D{{Key: "status", Value: status}, {Key: "at", Value: now}, {Key: "byUserId", Value: actor}, {Key: "note", Value: note}}}}}, {Key: "$set", Value: set}},
			options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&updated)
		if errors.Is(err, mongo.ErrNoDocuments) {
			return storeErr(409, "ORDER_CHANGED", "This order was just updated by someone else. Refresh and try again.")
		}
		if err != nil || status != "CANCELLED" {
			return err
		}
		for _, it := range o.Items {
			if _, err := h.col("storeproducts").UpdateOne(ctx, bson.D{{Key: "_id", Value: it.ProductID}, {Key: "trackStock", Value: true}},
				bson.D{{Key: "$inc", Value: bson.D{{Key: "stockQuantity", Value: it.Quantity}}}}); err != nil {
				return err
			}
		}
		return nil
	})
	return updated, err
}

func (h *Handler) afterStatus(ctx context.Context, o orderRow, action string, actor bson.ObjectID) {
	_, _ = h.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/store/order/" + o.ID.Hex(), Body: o.OrderNumber + " is now " + strings.ToLower(statusLabel[o.Status]) + ".",
		Category: "STORE_ORDER", Data: ordered.Map{{Key: "orderId", Value: o.ID.Hex()}, {Key: "status", Value: o.Status}}, HostelID: o.HostelID.Hex(), Kind: "NORMAL",
		Title: "Supply order update", UserID: o.PlacedBy.Hex()})
	h.mailStatus(ctx, o)
	h.audit(ctx, action, o, actor)
	h.publish(ctx, realtime.Change{HostelIDs: []string{o.HostelID.Hex()}, Platform: true})
}

func (h *Handler) audit(ctx context.Context, action string, o orderRow, actor bson.ObjectID) {
	_ = h.Audit.Write(ctx, audit.Entry{ActorID: actor, Action: action, EntityType: "StoreOrder", EntityID: o.ID.Hex(), HostelID: o.HostelID,
		Metadata: bson.D{{Key: "orderNumber", Value: o.OrderNumber}, {Key: "status", Value: o.Status}, {Key: "total", Value: o.Total}}})
}

func (h *Handler) checkout(c *gin.Context) {
	p, hostel, ok := h.buyer(c)
	if !ok {
		return
	}
	v, err := h.readCart(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var prev struct {
		Delivery *delivery `bson:"delivery"`
	}
	_ = h.col("storeorders").FindOne(c, bson.D{{Key: "hostelId", Value: hostel}}, options.FindOne().SetSort(newestFirst).SetProjection(bson.D{{Key: "delivery", Value: 1}})).Decode(&prev)
	var hs struct {
		Name     string `bson:"name"`
		Location *struct {
			Address, Area, City *string
		} `bson:"location"`
		Contact *struct{ Phone *string } `bson:"contact"`
	}
	_ = h.col("hostels").FindOne(c, bson.D{{Key: "_id", Value: hostel}}).Decode(&hs)
	var u struct {
		Name  *string `bson:"name"`
		Phone *string `bson:"phone"`
	}
	uid, _ := bson.ObjectIDFromHex(p.UserID)
	_ = h.col("users").FindOne(c, bson.D{{Key: "_id", Value: uid}}).Decode(&u)
	first := func(vals ...*string) string {
		for _, v := range vals {
			if v != nil {
				return *v
			}
		}
		return ""
	}
	var addr, area, city, phone *string
	if hs.Location != nil {
		addr, area, city = hs.Location.Address, hs.Location.Area, hs.Location.City
	}
	if hs.Contact != nil {
		phone = hs.Contact.Phone
	}
	var parts []string
	for _, s := range []*string{addr, area} {
		if s != nil && *s != "" {
			parts = append(parts, *s)
		}
	}
	joined, name := strings.Join(parts, ", "), hs.Name
	d := ordered.Map{{Key: "addressLine", Value: joined}, {Key: "city", Value: first(city)}, {Key: "contactName", Value: first(u.Name, &name)}, {Key: "note", Value: ""}, {Key: "phone", Value: first(phone, u.Phone)}}
	if pd := prev.Delivery; pd != nil {
		d = ordered.Map{{Key: "addressLine", Value: pd.AddressLine}, {Key: "city", Value: first(pd.City, city)}, {Key: "contactName", Value: pd.ContactName}, {Key: "note", Value: ""}, {Key: "phone", Value: pd.Phone}}
	}
	cart, _ := v.out(h, nil, false).Get("cart")
	httpx.OK(c, ordered.Map{{Key: "cart", Value: cart}, {Key: "delivery", Value: d}, {Key: "deliveryEstimate", Value: v.cfg.DeliveryEstimate}, {Key: "deliveryPromise", Value: deliveryPromise(v.cfg, h.Now())},
		{Key: "paymentMethods", Value: []ordered.Map{{{Key: "available", Value: true}, {Key: "description", Value: "Pay the courier when the order arrives."}, {Key: "id", Value: "COD"}, {Key: "label", Value: "Cash on delivery"}}}}}, "Checkout loaded")
}

/* Fulfilment (platform) ------------------------------------------------------ */

func (h *Handler) superadmin(c *gin.Context) (bson.ObjectID, bool) {
	p, err := h.Guards.RequireSuperadmin(c)
	if err != nil {
		httpx.Fail(c, err)
		return bson.ObjectID{}, false
	}
	id, _ := bson.ObjectIDFromHex(p.UserID)
	return id, true
}

func (h *Handler) adminOrders(c *gin.Context) {
	if _, ok := h.superadmin(c); !ok {
		return
	}
	q, err := readOrderQuery(c, true)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	filter := statusFilter(q.status)
	if q.hostel != "" {
		id, err := objectID(q.hostel, "hostel id")
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		filter = append(filter, bson.E{Key: "hostelId", Value: id})
	}
	rows, total, err := h.pageOrders(c, filter, q.page)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	open, err := h.col("storeorders").CountDocuments(c, bson.D{{Key: "status", Value: bson.D{{Key: "$in", Value: openStatuses}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err := h.col("storeorders").Aggregate(c, mongo.Pipeline{{{Key: "$match", Value: bson.D{{Key: "status", Value: "DELIVERED"}}}},
		{{Key: "$group", Value: bson.D{{Key: "_id", Value: nil}, {Key: "total", Value: bson.D{{Key: "$sum", Value: "$total"}}}}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var revenue []struct {
		Total int64 `bson:"total"`
	}
	if err := cur.All(c, &revenue); err != nil {
		httpx.Fail(c, err)
		return
	}
	var delivered int64
	if len(revenue) > 0 {
		delivered = revenue[0].Total
	}
	names, err := h.hostelNames(c, rows)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]ordered.Map, len(rows))
	for i, o := range rows {
		out[i] = append(o.out(), ordered.Pair{Key: "hostelName", Value: names[o.HostelID]})
	}
	httpx.OK(c, ordered.Map{{Key: "orders", Value: out}, {Key: "pagination", Value: pagination.MetaOf(q.page, int(total))},
		{Key: "summary", Value: ordered.Map{{Key: "deliveredRevenue", Value: delivered}, {Key: "open", Value: open}, {Key: "total", Value: total}}}}, "Orders loaded")
}

func (h *Handler) hostelNames(ctx context.Context, rows []orderRow) (map[bson.ObjectID]string, error) {
	ids := bson.A{}
	for _, o := range rows {
		ids = append(ids, o.HostelID)
	}
	out := map[bson.ObjectID]string{}
	if len(ids) == 0 {
		return out, nil
	}
	hs, err := findAll[struct {
		ID   bson.ObjectID `bson:"_id"`
		Name string        `bson:"name"`
	}](ctx, h.col("hostels"), bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}))
	for _, x := range hs {
		out[x.ID] = x.Name
	}
	return out, err
}

func (h *Handler) orderStatus(c *gin.Context) {
	actor, ok := h.superadmin(c)
	if !ok {
		return
	}
	id, err := objectID(c.Param("orderId"), "order id")
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
	note, _ := f.Str("note", valid.S{Opt: true, Trim: true, Max: 500})
	status, _ := f.Enum("status", false, nil, "CONFIRMED", "PACKED", "SHIPPED", "DELIVERED", "CANCELLED")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	var o orderRow
	err = h.col("storeorders").FindOne(c, bson.D{{Key: "_id", Value: id}}).Decode(&o)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, storeErr(404, "ORDER_NOT_FOUND", "That order was not found."))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if !canTransition(o.Status, status) {
		httpx.Fail(c, storeErr(409, "INVALID_ORDER_TRANSITION", "An order that is "+strings.ToLower(statusLabel[o.Status])+" cannot move to "+strings.ToLower(statusLabel[status])+"."))
		return
	}
	updated, err := h.applyStatus(c, o, status, actor, note)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.afterStatus(c, updated, "STORE_ORDER_STATUS_CHANGED", actor)
	httpx.OK(c, ordered.Map{{Key: "order", Value: updated.out()}}, "Order updated")
}

/* Notifications -------------------------------------------------------------- */

type recipients struct {
	buyerEmail, buyerName, hostelName string
	platformEmails, platformIDs       []string
}

func (h *Handler) recipients(ctx context.Context, o orderRow) recipients {
	r := recipients{buyerName: o.Delivery.ContactName, hostelName: "A hostel"}
	var buyer struct {
		Email *string `bson:"email"`
		Name  *string `bson:"name"`
	}
	_ = h.col("users").FindOne(ctx, bson.D{{Key: "_id", Value: o.PlacedBy}}).Decode(&buyer)
	var hostel struct {
		Name    string                   `bson:"name"`
		Contact *struct{ Email *string } `bson:"contact"`
	}
	hostelFound := h.col("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: o.HostelID}}).Decode(&hostel) == nil
	if hostelFound {
		r.hostelName = hostel.Name
	}
	if buyer.Name != nil {
		r.buyerName = *buyer.Name
	}
	if buyer.Email != nil {
		r.buyerEmail = strings.ToLower(strings.TrimSpace(*buyer.Email))
	} else if hostel.Contact != nil && hostel.Contact.Email != nil {
		r.buyerEmail = strings.ToLower(strings.TrimSpace(*hostel.Contact.Email))
	}
	staff, _ := findAll[struct {
		ID    bson.ObjectID `bson:"_id"`
		Email *string       `bson:"email"`
	}](ctx, h.col("users"), bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "role", Value: "SUPERADMIN"}, {Key: "status", Value: "ACTIVE"}})
	seen := map[string]bool{}
	for _, s := range staff {
		r.platformIDs = append(r.platformIDs, s.ID.Hex())
		if s.Email != nil {
			if e := strings.ToLower(strings.TrimSpace(*s.Email)); e != "" && !seen[e] {
				seen[e] = true
				r.platformEmails = append(r.platformEmails, e)
			}
		}
	}
	return r
}

// imageURL is publicOrderImageUrl: an absolute link, or a public asset's URL.
func (h *Handler) imageURL(ctx context.Context, it orderItem) string {
	url := or(it.ImageURL, "")
	if strings.HasPrefix(url, "http://") || strings.HasPrefix(url, "https://") {
		return url
	}
	asset := or(it.ImageAssetID, "")
	if asset == "" {
		return url
	}
	var a struct {
		AccessLevel string `bson:"accessLevel"`
		PublicURL   string `bson:"publicUrl"`
	}
	if id, err := bson.ObjectIDFromHex(asset); err == nil && h.col("fileassets").FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&a) == nil &&
		a.AccessLevel == "PUBLIC" && strings.HasPrefix(a.PublicURL, "http") {
		return a.PublicURL
	}
	return url
}

func (h *Handler) emailItems(ctx context.Context, o orderRow) []email.StoreItem {
	out := make([]email.StoreItem, len(o.Items))
	for i, it := range o.Items {
		out[i] = email.StoreItem{ImageURL: h.imageURL(ctx, it), LineTotal: it.LineTotal, Name: it.Name, Quantity: it.Quantity, StockAfterOrder: it.StockAfterOrder, Unit: or(it.Unit, "piece"), UnitPrice: it.UnitPrice}
	}
	return out
}

func (o orderRow) facts(hostelName string, items []email.StoreItem) email.StoreOrderFacts {
	return email.StoreOrderFacts{Address: o.Delivery.AddressLine, ContactName: o.Delivery.ContactName, DeliveryPromise: o.promise(), HostelName: hostelName,
		Note: or(o.Delivery.Note, ""), OrderNumber: o.OrderNumber, Phone: o.Delivery.Phone, DeliveryFee: o.DeliveryFee, Subtotal: o.Subtotal, Total: o.Total, Items: items}
}

// notifyPlaced is notifyOrderPlaced: bells and pushes for the platform, a push
// and an email for the buyer, an email for the platform. Never fails the order.
func (h *Handler) notifyPlaced(ctx context.Context, o orderRow) {
	r := h.recipients(ctx, o)
	items := h.emailItems(ctx, o)
	summary := strconv.FormatInt(o.itemCount(), 10) + " items · " + money.FormatStoreNPR(o.Total)
	data := ordered.Map{{Key: "orderId", Value: o.ID.Hex()}, {Key: "orderNumber", Value: o.OrderNumber}}
	for _, id := range r.platformIDs {
		_, _ = h.Notify.CreateInApp(ctx, notifications.Input{Body: summary + " · deliver by " + o.promise() + ".", Category: "STORE_ORDER", Data: data, Kind: "ACTION",
			Priority: "NORMAL", NoPush: true, Title: "New order · " + r.hostelName, UserID: id})
	}
	pushData := map[string]any{"orderId": o.ID.Hex(), "orderNumber": o.OrderNumber}
	image := ""
	for _, it := range items {
		if it.ImageURL != "" {
			image = it.ImageURL
			break
		}
	}
	h.Push.ToUsers(ctx, []string{o.PlacedBy.Hex()}, push.Payload{Body: summary + " · " + o.promise(), Category: "STORE_ORDER", Data: pushData, ImageURL: image, Priority: "NORMAL", Title: "Order placed · " + o.OrderNumber})
	h.Push.ToUsers(ctx, r.platformIDs, push.Payload{Body: summary + " · deliver by " + o.promise(), Category: "STORE_ORDER", Data: pushData, Priority: "NORMAL", Title: "New order · " + r.hostelName})
	facts := o.facts(r.hostelName, items)
	if r.buyerEmail != "" {
		created := httpx.ISO(*o.CreatedAt)
		m := email.StoreOrderPlacedBuyer(facts, created, h.SiteURL+"/store/order/"+o.ID.Hex())
		h.Mail.Send(ctx, email.Message{Category: m.Category, To: []string{r.buyerEmail}, Subject: m.Subject, HTML: m.HTML})
	}
	if len(r.platformEmails) > 0 {
		m := email.StoreOrderReceivedPlatform(facts, r.buyerName, h.SiteURL+"/platform/store/orders")
		h.Mail.Send(ctx, email.Message{Category: m.Category, To: r.platformEmails, Subject: m.Subject, HTML: m.HTML})
	}
}

// mailStatus is notifyOrderStatusEmail: confirmed, shipped, delivered, cancelled only.
func (h *Handler) mailStatus(ctx context.Context, o orderRow) {
	switch o.Status {
	case "CONFIRMED", "SHIPPED", "DELIVERED", "CANCELLED":
	default:
		return
	}
	r := h.recipients(ctx, o)
	if r.buyerEmail == "" {
		return
	}
	m := email.StoreOrderStatusBuyer(o.Status, o.OrderNumber, h.SiteURL+"/store/order/"+o.ID.Hex(), o.promise(), or(o.Delivery.Note, ""), or(o.CancelledReason, ""), o.Total, h.emailItems(ctx, o))
	h.Mail.Send(ctx, email.Message{Category: m.Category, To: []string{r.buyerEmail}, Subject: m.Subject, HTML: m.HTML})
}
