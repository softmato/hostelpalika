// Package store is modules/store: the supply store the platform runs for
// hostels (catalogue, cart, cash-on-delivery orders) and its superadmin side.
// Every amount is NPR paisa, an integer.
package store

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/push"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

type Handler struct {
	DB      *mongo.Database
	Guards  *authz.Guards
	Config  *platformconfig.Service
	Notify  *notifications.Service
	Push    *push.Sender
	Mail    *email.Sender
	Audit   *audit.Log
	RT      *realtime.Client
	Bump    realtime.Bumper
	SiteURL string
	Now     func() time.Time
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	e := httpx.ETag()
	v1.GET("/store/home", e, h.home)
	v1.GET("/store/categories", e, h.categories)
	v1.GET("/store/shelves", e, h.shelves)
	v1.GET("/store/products", e, h.products)
	v1.GET("/store/products/:handle", e, h.product)
	v1.GET("/store/cart", e, h.cart)
	v1.DELETE("/store/cart", h.clearCart)
	v1.GET("/store/cart/count", e, h.cartCount)
	v1.POST("/store/cart/items", h.addItem)
	v1.PATCH("/store/cart/items/:productId", h.updateItem)
	v1.DELETE("/store/cart/items/:productId", h.removeItem)
	v1.GET("/store/checkout", e, h.checkout)
	v1.GET("/store/orders", e, h.orders)
	v1.POST("/store/orders", h.placeOrder)
	v1.GET("/store/orders/:orderId", e, h.order)
	v1.POST("/store/orders/:orderId/cancel", h.cancelOrder)

	v1.GET("/platform/store/summary", e, h.adminSummary)
	v1.GET("/platform/store/config", e, h.adminConfig)
	v1.PATCH("/platform/store/config", h.saveConfig)
	v1.GET("/platform/store/categories", e, h.adminCategories)
	v1.POST("/platform/store/categories", h.createCategory)
	v1.PATCH("/platform/store/categories/:categoryId", h.updateCategory)
	v1.DELETE("/platform/store/categories/:categoryId", h.deleteCategory)
	v1.GET("/platform/store/products", e, h.adminProducts)
	v1.POST("/platform/store/products", h.createProduct)
	v1.PATCH("/platform/store/products/:productId", h.updateProduct)
	v1.DELETE("/platform/store/products/:productId", h.deleteProduct)
	v1.GET("/platform/store/orders", e, h.adminOrders)
	v1.PATCH("/platform/store/orders/:orderId/status", h.orderStatus)
}

func storeErr(status int, code, msg string) error { return httpx.NewError(status, code, msg, nil) }

// objectID is storeObjectId.
func objectID(v, label string) (bson.ObjectID, error) {
	id, err := bson.ObjectIDFromHex(v)
	if err != nil {
		return id, storeErr(422, "INVALID_OBJECT_ID", "Invalid "+label+".")
	}
	return id, nil
}

/* Config, pricing, lifecycle ------------------------------------------------ */

type schedule struct {
	MorningCutoffHour  int    `json:"morningCutoffHour"`
	MorningArrivalText string `json:"morningArrivalText"`
	EveningCutoffHour  int    `json:"eveningCutoffHour"`
	EveningArrivalText string `json:"eveningArrivalText"`
}

type storeConfig struct {
	Currency              string   `json:"currency"`
	DeliveryFee           int64    `json:"deliveryFee"`
	FreeDeliveryThreshold int64    `json:"freeDeliveryThreshold"`
	IsOpen                bool     `json:"isOpen"`
	ClosedMessage         string   `json:"closedMessage"`
	DeliveryEstimate      string   `json:"deliveryEstimate"`
	DeliverySchedule      schedule `json:"deliverySchedule"`
	MaxOrderTotal         int64    `json:"maxOrderTotal"`
}

func (h *Handler) config(ctx context.Context) storeConfig {
	var c storeConfig
	_ = platformconfig.Decode(h.Config.Store(ctx), &c) // Store already fell back to the defaults
	return c
}

var nepal = time.FixedZone("NPT", 5*3600+45*60)

func formatHour(hour int) string {
	n := hour % 24
	d := n % 12
	if d == 0 {
		d = 12
	}
	if n < 12 {
		return strconv.Itoa(d) + " AM"
	}
	return strconv.Itoa(d) + " PM"
}

// deliveryPromise is resolveDeliveryPromise, on Nepal wall-clock time.
func deliveryPromise(c storeConfig, now time.Time) ordered.Map {
	s := c.DeliverySchedule
	hour := now.In(nepal).Hour()
	switch {
	case hour < s.MorningCutoffHour:
		return ordered.Map{{Key: "arrivesText", Value: s.MorningArrivalText}, {Key: "cutoffText", Value: "Order by " + formatHour(s.MorningCutoffHour) + " for delivery " + s.MorningArrivalText + "."}, {Key: "placedBefore", Value: "morning"}}
	case hour < s.EveningCutoffHour:
		return ordered.Map{{Key: "arrivesText", Value: s.MorningArrivalText}, {Key: "cutoffText", Value: "Order by " + formatHour(s.EveningCutoffHour) + " for delivery " + s.MorningArrivalText + "."}, {Key: "placedBefore", Value: "evening"}}
	}
	return ordered.Map{{Key: "arrivesText", Value: s.EveningArrivalText}, {Key: "cutoffText", Value: "Orders placed after " + formatHour(s.EveningCutoffHour) + " arrive " + s.EveningArrivalText + "."}, {Key: "placedBefore", Value: "next-day"}}
}

func publicConfig(c storeConfig, now time.Time) ordered.Map {
	return ordered.Map{{Key: "closedMessage", Value: c.ClosedMessage}, {Key: "currency", Value: c.Currency}, {Key: "deliveryPromise", Value: deliveryPromise(c, now)},
		{Key: "deliveryEstimate", Value: c.DeliveryEstimate}, {Key: "deliveryFee", Value: c.DeliveryFee}, {Key: "freeDeliveryThreshold", Value: c.FreeDeliveryThreshold}, {Key: "isOpen", Value: c.IsOpen}}
}

type line struct{ Quantity, UnitPrice int64 }

type totals struct {
	DeliveryFee, FreeDeliveryRemaining int64
	HasFreeDelivery                    bool
	ItemCount, Subtotal, Total         int64
}

func (t totals) out() ordered.Map {
	return ordered.Map{{Key: "deliveryFee", Value: t.DeliveryFee}, {Key: "freeDeliveryRemaining", Value: t.FreeDeliveryRemaining}, {Key: "hasFreeDelivery", Value: t.HasFreeDelivery},
		{Key: "itemCount", Value: t.ItemCount}, {Key: "subtotal", Value: t.Subtotal}, {Key: "total", Value: t.Total}}
}

// cartTotals is store-pricing.ts cartTotals: integers only, nothing divides.
func cartTotals(lines []line, c storeConfig) totals {
	var sub, count int64
	for _, l := range lines {
		sub += l.Quantity * l.UnitPrice
		count += l.Quantity
	}
	if sub == 0 {
		return totals{}
	}
	free := c.FreeDeliveryThreshold > 0 && sub >= c.FreeDeliveryThreshold
	fee := c.DeliveryFee
	if free {
		fee = 0
	}
	var remaining int64
	if !free && c.FreeDeliveryThreshold != 0 {
		remaining = max(c.FreeDeliveryThreshold-sub, 0)
	}
	return totals{DeliveryFee: fee, FreeDeliveryRemaining: remaining, HasFreeDelivery: fee == 0, ItemCount: count, Subtotal: sub, Total: sub + fee}
}

// clampQuantity is store-pricing.ts clampQuantity; stock nil = untracked.
func clampQuantity(requested, maxOrder, minOrder int64, stock *int64) (int64, string) {
	q, reason := max(requested, max(minOrder, 1)), "none"
	if maxOrder > 0 && q > maxOrder {
		q, reason = maxOrder, "max"
	}
	if stock != nil && q > *stock {
		q, reason = *stock, "stock"
	}
	return max(q, 0), reason
}

var transitions = map[string][]string{
	"CANCELLED": {}, "CONFIRMED": {"PACKED", "SHIPPED", "CANCELLED"}, "DELIVERED": {},
	"PACKED": {"SHIPPED", "CANCELLED"}, "PLACED": {"CONFIRMED", "PACKED", "CANCELLED"}, "SHIPPED": {"DELIVERED"},
}

var openStatuses = bson.A{"PLACED", "CONFIRMED", "PACKED", "SHIPPED"}

var statusLabel = map[string]string{"CANCELLED": "Cancelled", "CONFIRMED": "Confirmed", "DELIVERED": "Delivered",
	"PACKED": "Packed", "PLACED": "Order placed", "SHIPPED": "Out for delivery"}

func canTransition(from, to string) bool {
	for _, s := range transitions[from] {
		if s == to {
			return true
		}
	}
	return false
}

func buyerCanCancel(status string) bool {
	return status == "PLACED" || status == "CONFIRMED" || status == "PACKED"
}

/* Catalogue rows ------------------------------------------------------------ */

type categoryRow struct {
	ID           bson.ObjectID `bson:"_id"`
	Icon         *string       `bson:"icon"`
	ImageAssetID *string       `bson:"imageAssetId"`
	ImageURL     *string       `bson:"imageUrl"`
	IsActive     bool          `bson:"isActive"`
	Name         string        `bson:"name"`
	Priority     int64         `bson:"priority"`
	Slug         string        `bson:"slug"`
}

func or(p *string, def string) string {
	if p == nil {
		return def
	}
	return *p
}

func (c categoryRow) out() ordered.Map {
	return ordered.Map{{Key: "icon", Value: or(c.Icon, "cube")}, {Key: "id", Value: c.ID.Hex()}, {Key: "imageAssetId", Value: or(c.ImageAssetID, "")},
		{Key: "imageUrl", Value: or(c.ImageURL, "")}, {Key: "isActive", Value: c.IsActive}, {Key: "name", Value: c.Name}, {Key: "priority", Value: c.Priority}, {Key: "slug", Value: c.Slug}}
}

type image struct {
	AssetID *string `bson:"assetId,omitempty"`
	URL     *string `bson:"url,omitempty"`
}

type productRow struct {
	ID               bson.ObjectID `bson:"_id"`
	CategoryID       bson.ObjectID `bson:"categoryId"`
	CompareAtPrice   *int64        `bson:"compareAtPrice"`
	CreatedAt        *time.Time    `bson:"createdAt"`
	Description      *string       `bson:"description"`
	Images           []image       `bson:"images"`
	IsActive         bool          `bson:"isActive"`
	IsFeatured       bool          `bson:"isFeatured"`
	MaxOrderQuantity *int64        `bson:"maxOrderQuantity"`
	MinOrderQuantity *int64        `bson:"minOrderQuantity"`
	Name             string        `bson:"name"`
	Price            int64         `bson:"price"`
	Slug             string        `bson:"slug"`
	StockQuantity    int64         `bson:"stockQuantity"`
	Summary          *string       `bson:"summary"`
	Tags             []string      `bson:"tags"`
	TrackStock       bool          `bson:"trackStock"`
	Unit             *string       `bson:"unit"`
}

func (p productRow) maxOrder() int64 {
	if p.MaxOrderQuantity == nil {
		return 0
	}
	return *p.MaxOrderQuantity
}

func (p productRow) minOrder() int64 {
	if p.MinOrderQuantity == nil {
		return 1
	}
	return *p.MinOrderQuantity
}

func (p productRow) stock() *int64 {
	if !p.TrackStock {
		return nil
	}
	s := p.StockQuantity
	return &s
}

func (p productRow) clamp(requested int64) (int64, string) {
	return clampQuantity(requested, p.maxOrder(), p.minOrder(), p.stock())
}

func (p productRow) unit() string { return or(p.Unit, "piece") }

// out is serializeStoreProduct; cat nil is "no category passed".
func (p productRow) out(cat *categoryRow) ordered.Map {
	name, slug := "", ""
	if cat != nil {
		name, slug = cat.Name, cat.Slug
	}
	var compare any
	if p.CompareAtPrice != nil {
		compare = *p.CompareAtPrice
	}
	o := ordered.Map{{Key: "categoryId", Value: p.CategoryID.Hex()}, {Key: "categoryName", Value: name}, {Key: "categorySlug", Value: slug}, {Key: "compareAtPrice", Value: compare}}
	if p.CreatedAt != nil {
		o = append(o, ordered.Pair{Key: "createdAt", Value: httpx.ISO(*p.CreatedAt)})
	}
	images := make([]ordered.Map, len(p.Images))
	for i, im := range p.Images {
		images[i] = ordered.Map{{Key: "assetId", Value: or(im.AssetID, "")}, {Key: "url", Value: or(im.URL, "")}}
	}
	var stock any
	if p.TrackStock {
		stock = p.StockQuantity
	}
	tags := p.Tags
	if tags == nil {
		tags = []string{}
	}
	return append(o, ordered.Map{{Key: "description", Value: or(p.Description, "")}, {Key: "id", Value: p.ID.Hex()}, {Key: "images", Value: images},
		{Key: "inStock", Value: !p.TrackStock || p.StockQuantity > 0}, {Key: "isFeatured", Value: p.IsFeatured}, {Key: "maxOrderQuantity", Value: p.maxOrder()},
		{Key: "minOrderQuantity", Value: p.minOrder()}, {Key: "name", Value: p.Name}, {Key: "price", Value: p.Price}, {Key: "slug", Value: p.Slug},
		{Key: "stockQuantity", Value: stock}, {Key: "summary", Value: or(p.Summary, "")}, {Key: "tags", Value: tags}, {Key: "trackStock", Value: p.TrackStock}, {Key: "unit", Value: p.unit()}}...)
}

func findAll[T any](ctx context.Context, coll *mongo.Collection, filter any, opts ...options.Lister[options.FindOptions]) ([]T, error) {
	cur, err := coll.Find(ctx, filter, opts...)
	if err != nil {
		return nil, err
	}
	out := []T{}
	return out, cur.All(ctx, &out)
}

func (h *Handler) col(name string) *mongo.Collection { return h.DB.Collection(name) }

var byPriority = options.Find().SetSort(bson.D{{Key: "priority", Value: -1}, {Key: "name", Value: 1}})

// productCounts: products per category, active only or all.
func (h *Handler) productCounts(ctx context.Context, activeOnly bool) (map[bson.ObjectID]int64, error) {
	pipe := mongo.Pipeline{{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$categoryId"}, {Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}}}}}}
	if activeOnly {
		pipe = append(mongo.Pipeline{{{Key: "$match", Value: bson.D{{Key: "isActive", Value: true}}}}}, pipe...)
	}
	cur, err := h.col("storeproducts").Aggregate(ctx, pipe)
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID    bson.ObjectID `bson:"_id"`
		Count int64         `bson:"count"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := map[bson.ObjectID]int64{}
	for _, r := range rows {
		out[r.ID] = r.Count
	}
	return out, nil
}

// listCategories is listStoreCategories (active) and listCategoriesForAdmin (all).
func (h *Handler) listCategories(ctx context.Context, activeOnly bool) ([]ordered.Map, error) {
	filter := bson.D{}
	if activeOnly {
		filter = bson.D{{Key: "isActive", Value: true}}
	}
	cats, err := findAll[categoryRow](ctx, h.col("storecategories"), filter, byPriority)
	if err != nil {
		return nil, err
	}
	counts, err := h.productCounts(ctx, activeOnly)
	if err != nil {
		return nil, err
	}
	out := make([]ordered.Map, len(cats))
	for i, c := range cats {
		out[i] = append(c.out(), ordered.Pair{Key: "productCount", Value: counts[c.ID]})
	}
	return out, nil
}

func (h *Handler) categoriesByID(ctx context.Context, products []productRow) (map[bson.ObjectID]*categoryRow, error) {
	ids := bson.A{}
	seen := map[bson.ObjectID]bool{}
	for _, p := range products {
		if !seen[p.CategoryID] {
			seen[p.CategoryID] = true
			ids = append(ids, p.CategoryID)
		}
	}
	out := map[bson.ObjectID]*categoryRow{}
	if len(ids) == 0 {
		return out, nil
	}
	cats, err := findAll[categoryRow](ctx, h.col("storecategories"), bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}})
	for i := range cats {
		out[cats[i].ID] = &cats[i]
	}
	return out, err
}

func escapeRegex(s string) string { return regexp.QuoteMeta(s) }

type listQuery struct {
	Page     pagination.Query
	Category string
	Featured bool
	Search   string
	Sort     string
}

var sorts = map[string]bson.D{
	"newest":      {{Key: "createdAt", Value: -1}},
	"price-asc":   {{Key: "price", Value: 1}, {Key: "_id", Value: 1}},
	"price-desc":  {{Key: "price", Value: -1}, {Key: "_id", Value: 1}},
	"recommended": {{Key: "priority", Value: -1}, {Key: "createdAt", Value: -1}},
}

// readListQuery is storeProductListQuerySchema.
func readListQuery(c *gin.Context) (listQuery, error) {
	q := valid.Query(c)
	var is valid.Issues
	out := listQuery{Page: valid.Page(q, &is), Sort: "recommended"}
	if v := valid.QueryString(q, "category", 0, 80, &is); v != nil {
		out.Category = *v
	}
	if raw, ok := q["featured"]; ok {
		if raw != "true" && raw != "false" {
			is.Add("featured", "Invalid input")
		}
		out.Featured = raw == "true"
	}
	if v := valid.QueryString(q, "search", 0, 120, &is); v != nil {
		out.Search = *v
	}
	if v := valid.QueryEnum(q, "sort", &is, "recommended", "price-asc", "price-desc", "newest"); v != nil {
		out.Sort = *v
	}
	return out, is.Err()
}

func searchOr(search string, fields ...string) bson.A {
	re := bson.Regex{Pattern: escapeRegex(search), Options: "i"}
	out := bson.A{}
	for _, f := range fields {
		out = append(out, bson.D{{Key: f, Value: re}})
	}
	return out
}

// listProducts is listStoreProducts.
func (h *Handler) listProducts(ctx context.Context, q listQuery) (ordered.Map, error) {
	filter := bson.D{{Key: "isActive", Value: true}}
	var cat *categoryRow
	if q.Category != "" {
		var row categoryRow
		err := h.col("storecategories").FindOne(ctx, bson.D{{Key: "isActive", Value: true}, {Key: "slug", Value: toLower(q.Category)}}).Decode(&row)
		if errors.Is(err, mongo.ErrNoDocuments) {
			return ordered.Map{{Key: "category", Value: nil}, {Key: "pagination", Value: pagination.MetaOf(q.Page, 0)}, {Key: "products", Value: []any{}}}, nil
		}
		if err != nil {
			return nil, err
		}
		cat = &row
		filter = append(filter, bson.E{Key: "categoryId", Value: row.ID})
	}
	if q.Featured {
		filter = append(filter, bson.E{Key: "isFeatured", Value: true})
	}
	text := q.Search != "" && q.Sort == "recommended" && q.Category == ""
	sort := sorts[q.Sort]
	find := options.Find()
	if q.Search != "" {
		if text {
			filter = append(filter, bson.E{Key: "$text", Value: bson.D{{Key: "$search", Value: q.Search}}})
			sort = bson.D{{Key: "score", Value: bson.D{{Key: "$meta", Value: "textScore"}}}}
			find.SetProjection(bson.D{{Key: "score", Value: bson.D{{Key: "$meta", Value: "textScore"}}}})
		} else {
			filter = append(filter, bson.E{Key: "$or", Value: searchOr(q.Search, "name", "summary", "tags")})
		}
	}
	r := pagination.RangeOf(q.Page)
	products, err := findAll[productRow](ctx, h.col("storeproducts"), filter, find.SetSort(sort).SetSkip(int64(r.Skip)).SetLimit(int64(r.Limit)))
	if err != nil {
		return nil, err
	}
	total, err := h.col("storeproducts").CountDocuments(ctx, filter)
	if err != nil {
		return nil, err
	}
	cats, err := h.categoriesByID(ctx, products)
	if err != nil {
		return nil, err
	}
	out := make([]ordered.Map, len(products))
	for i, p := range products {
		out[i] = p.out(cats[p.CategoryID])
	}
	var catOut any
	if cat != nil {
		catOut = cat.out()
	}
	return ordered.Map{{Key: "category", Value: catOut}, {Key: "pagination", Value: pagination.MetaOf(q.Page, int(total))}, {Key: "products", Value: out}}, nil
}

func toLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

func (h *Handler) admin(c *gin.Context) bool {
	if _, err := h.Guards.RequireHostelAdmin(c); err != nil {
		httpx.Fail(c, err)
		return false
	}
	return true
}

func (h *Handler) categories(c *gin.Context) {
	if !h.admin(c) {
		return
	}
	cats, err := h.listCategories(c, true)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "categories", Value: cats}}, "Categories loaded")
}

func (h *Handler) products(c *gin.Context) {
	if !h.admin(c) {
		return
	}
	q, err := readListQuery(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.listProducts(c, q)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Products loaded")
}

func (h *Handler) home(c *gin.Context) {
	if !h.admin(c) {
		return
	}
	cfg := h.config(c)
	cats, err := h.listCategories(c, true)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	size8, size10 := 8, 10
	featured, err := h.listProducts(c, listQuery{Featured: true, Page: pagination.Query{PageSize: &size8}, Sort: "recommended"})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	latest, err := h.listProducts(c, listQuery{Page: pagination.Query{PageSize: &size10}, Sort: "newest"})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f, _ := featured.Get("products")
	l, _ := latest.Get("products")
	httpx.OK(c, ordered.Map{{Key: "categories", Value: cats}, {Key: "config", Value: publicConfig(cfg, h.Now())}, {Key: "featured", Value: f}, {Key: "latest", Value: l}}, "Store loaded")
}

const shelfSize = 12

func (h *Handler) shelves(c *gin.Context) {
	if !h.admin(c) {
		return
	}
	cats, err := findAll[categoryRow](c, h.col("storecategories"), bson.D{{Key: "isActive", Value: true}}, byPriority)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if len(cats) == 0 {
		httpx.OK(c, ordered.Map{{Key: "shelves", Value: []any{}}}, "Departments loaded")
		return
	}
	search := ""
	if raw, ok := c.GetQuery("search"); ok {
		search = valid.Trim(raw)
	}
	ids := bson.A{}
	for _, cat := range cats {
		ids = append(ids, cat.ID)
	}
	match := bson.D{{Key: "categoryId", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "isActive", Value: true}}
	if search != "" {
		match = append(match, bson.E{Key: "$or", Value: searchOr(search, "name", "summary", "tags")})
	}
	cur, err := h.col("storeproducts").Aggregate(c, mongo.Pipeline{
		{{Key: "$match", Value: match}},
		{{Key: "$sort", Value: bson.D{{Key: "priority", Value: -1}, {Key: "createdAt", Value: -1}}}},
		{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$categoryId"}, {Key: "products", Value: bson.D{{Key: "$push", Value: "$$ROOT"}}}, {Key: "total", Value: bson.D{{Key: "$sum", Value: 1}}}}}},
		{{Key: "$project", Value: bson.D{{Key: "products", Value: bson.D{{Key: "$slice", Value: bson.A{"$products", shelfSize}}}}, {Key: "total", Value: 1}}}},
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var grouped []struct {
		ID       bson.ObjectID `bson:"_id"`
		Products []productRow  `bson:"products"`
		Total    int64         `bson:"total"`
	}
	if err := cur.All(c, &grouped); err != nil {
		httpx.Fail(c, err)
		return
	}
	byCat := map[bson.ObjectID]int{}
	for i, g := range grouped {
		byCat[g.ID] = i
	}
	shelves := []ordered.Map{}
	for i := range cats {
		cat := &cats[i]
		var total int64
		products := []ordered.Map{}
		if gi, ok := byCat[cat.ID]; ok {
			total = grouped[gi].Total
			for _, p := range grouped[gi].Products {
				products = append(products, p.out(cat))
			}
		}
		// A search hides empty departments; browsing keeps them.
		if search != "" && len(products) == 0 {
			continue
		}
		shelves = append(shelves, ordered.Map{{Key: "category", Value: append(cat.out(), ordered.Pair{Key: "productCount", Value: total})}, {Key: "products", Value: products}, {Key: "total", Value: total}})
	}
	httpx.OK(c, ordered.Map{{Key: "shelves", Value: shelves}}, "Departments loaded")
}

func (h *Handler) product(c *gin.Context) {
	if !h.admin(c) {
		return
	}
	handle := c.Param("handle")
	filter := bson.D{{Key: "isActive", Value: true}, {Key: "slug", Value: toLower(handle)}}
	if id, err := bson.ObjectIDFromHex(handle); err == nil {
		filter = bson.D{{Key: "_id", Value: id}, {Key: "isActive", Value: true}}
	}
	var p productRow
	err := h.col("storeproducts").FindOne(c, filter).Decode(&p)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, storeErr(404, "PRODUCT_NOT_FOUND", "That product is no longer available."))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var cat *categoryRow
	var row categoryRow
	if h.col("storecategories").FindOne(c, bson.D{{Key: "_id", Value: p.CategoryID}}).Decode(&row) == nil {
		cat = &row
	}
	related, err := findAll[productRow](c, h.col("storeproducts"), bson.D{{Key: "_id", Value: bson.D{{Key: "$ne", Value: p.ID}}}, {Key: "categoryId", Value: p.CategoryID}, {Key: "isActive", Value: true}},
		options.Find().SetSort(bson.D{{Key: "priority", Value: -1}, {Key: "createdAt", Value: -1}}).SetLimit(4))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rel := make([]ordered.Map, len(related))
	for i, r := range related {
		rel[i] = r.out(cat)
	}
	httpx.OK(c, ordered.Map{{Key: "product", Value: p.out(cat)}, {Key: "related", Value: rel}}, "Product loaded")
}

// publish tells the store screens to refetch (REALTIME_TOPIC.STORE).
func (h *Handler) publish(ctx context.Context, ch realtime.Change) {
	ch.Topics = []realtime.Topic{realtime.Store}
	realtime.PublishResourceChange(ctx, h.RT, h.Bump, ch)
}
