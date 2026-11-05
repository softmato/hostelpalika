package store

import (
	"context"
	"errors"
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
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

func mustRe(s string) *regexp.Regexp { return regexp.MustCompile(s) }

var (
	slugRe = mustRe(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	linkRe = mustRe(`(?i)^https?://`)
)

func (h *Handler) adminSummary(c *gin.Context) {
	if _, ok := h.superadmin(c); !ok {
		return
	}
	count := func(coll string, f bson.D) int64 {
		n, _ := h.col(coll).CountDocuments(c, f) // a count that fails reads as 0, never a 500 on the dashboard tile
		return n
	}
	httpx.OK(c, ordered.Map{{Key: "summary", Value: ordered.Map{
		{Key: "categories", Value: count("storecategories", bson.D{})},
		{Key: "live", Value: count("storeproducts", bson.D{{Key: "isActive", Value: true}})},
		{Key: "openOrders", Value: count("storeorders", bson.D{{Key: "status", Value: bson.D{{Key: "$in", Value: openStatuses}}}})},
		{Key: "outOfStock", Value: count("storeproducts", bson.D{{Key: "isActive", Value: true}, {Key: "stockQuantity", Value: bson.D{{Key: "$lte", Value: 0}}}, {Key: "trackStock", Value: true}})},
		{Key: "products", Value: count("storeproducts", bson.D{})},
	}}}, "Store summary loaded")
}

func (h *Handler) adminConfig(c *gin.Context) {
	if _, ok := h.superadmin(c); !ok {
		return
	}
	httpx.OK(c, ordered.Map{{Key: "config", Value: h.Config.Store(c)}}, "Store settings loaded")
}

// saveConfig is saveStoreConfig: the body is merged over the live config and
// parsed whole. The issues are written here, field by field, because zschema
// only answers yes or no.
func (h *Handler) saveConfig(c *gin.Context) {
	actor, ok := h.superadmin(c)
	if !ok {
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	merged := append(ordered.Map{}, h.Config.Store(c)...)
	if in, ok := body.(map[string]any); ok {
		for k, v := range in {
			merged = merged.Set(k, v)
		}
	}
	m := plainMap(merged)
	f := valid.NewForm(m)
	f.Str("currency", valid.S{Trim: true, Min: 3, Max: 3})
	f.Num("deliveryFee", valid.N{Int: true, Min: valid.P(0), Max: valid.P(1000000)})
	f.Num("freeDeliveryThreshold", valid.N{Int: true, Min: valid.P(0), Max: valid.P(100000000)})
	f.Bool("isOpen", false, nil)
	f.Str("closedMessage", valid.S{Trim: true, Max: 300})
	f.Str("deliveryEstimate", valid.S{Trim: true, Max: 120})
	f.Nest("deliverySchedule", false, func(s *valid.Form) {
		s.Num("morningCutoffHour", valid.N{Int: true, Min: valid.P(0), Max: valid.P(23)})
		s.Str("morningArrivalText", valid.S{Trim: true, Max: 120})
		s.Num("eveningCutoffHour", valid.N{Int: true, Min: valid.P(0), Max: valid.P(23)})
		s.Str("eveningArrivalText", valid.S{Trim: true, Max: 120})
		s.Str("timezone", valid.S{Trim: true, Min: 1})
		s.Str("cutoffCopy", valid.S{Trim: true, Max: 300})
	})
	f.Num("maxOrderTotal", valid.N{Int: true, Min: valid.P(100000), Max: valid.P(100000000)})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	next, ok := platformconfig.ParseStore(merged)
	if !ok {
		httpx.Fail(c, httpx.NewError(422, "VALIDATION_ERROR", "Validation failed", nil))
		return
	}
	now := h.Now().UTC().Truncate(time.Millisecond)
	if _, err := h.col("platformsettings").UpdateOne(c, bson.D{{Key: "key", Value: "store"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "key", Value: "store"}, {Key: "updatedBy", Value: actor.Hex()}, {Key: "value", Value: next}, {Key: "updatedAt", Value: now}}},
			{Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}}, options.UpdateOne().SetUpsert(true)); err != nil {
		httpx.Fail(c, err)
		return
	}
	h.Config.Invalidate()
	httpx.OK(c, ordered.Map{{Key: "config", Value: next}}, "Store settings saved")
}

func (h *Handler) adminCategories(c *gin.Context) {
	if _, ok := h.superadmin(c); !ok {
		return
	}
	cats, err := h.listCategories(c, false)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "categories", Value: cats}}, "Categories loaded")
}

// link is linkUrl: empty, a path, or http(s).
func link(f *valid.Form, key string) (string, bool) {
	v, ok := f.Str(key, valid.S{Opt: true, Trim: true, Max: 500})
	if ok && v != "" && !strings.HasPrefix(v, "/") && !linkRe.MatchString(v) {
		f.Is.Add(key, "Link must start with / or http(s)://")
		return "", false
	}
	return v, ok
}

func slug(f *valid.Form, opt bool) (string, bool) {
	if s, ok := f.M["slug"].(string); ok { // trim().toLowerCase() run before min/regex
		f.M["slug"] = strings.ToLower(s)
	}
	return f.Str("slug", valid.S{Opt: opt, Trim: true, Min: 1, Max: 180, Re: slugRe, ReMsg: "Use lowercase letters, numbers and hyphens."})
}

// categoryFields reads storeCategoryCreateSchema, or its .partial() for an update.
func categoryFields(body any, partial bool) (bson.D, error) {
	f := valid.NewForm(body)
	set := bson.D{}
	put := func(k string, v any, ok bool) {
		if ok {
			set = append(set, bson.E{Key: k, Value: v})
		}
	}
	var cube *string
	if !partial {
		s := "cube"
		cube = &s
	}
	icon, ok := f.Str("icon", valid.S{Opt: true, Trim: true, Max: 60})
	if !ok && !f.Present("icon") && cube != nil {
		icon, ok = *cube, true
	}
	put("icon", icon, ok)
	v, ok := f.Str("imageAssetId", valid.S{Opt: true, Trim: true, Max: 160})
	put("imageAssetId", v, ok)
	v, ok = link(f, "imageUrl")
	put("imageUrl", v, ok)
	var def *bool
	if !partial {
		t := true
		def = &t
	}
	if partial && !f.Present("isActive") {
		// left alone
	} else if b, ok := f.Bool("isActive", false, def); ok {
		put("isActive", b, true)
	}
	name, ok := f.Str("name", valid.S{Opt: partial, Trim: true, Min: 1, Max: 80})
	put("name", name, ok)
	n := valid.N{Opt: partial, Coerce: true, Int: true, Min: valid.P(-1000), Max: valid.P(1000)}
	if !partial {
		n.Default = valid.P(0)
	}
	if !partial || f.Present("priority") {
		pr, ok := f.Num("priority", n)
		put("priority", int64(pr), ok)
	}
	s, ok := slug(f, partial)
	put("slug", s, ok)
	if err := f.Err(); err != nil {
		return nil, err
	}
	if partial && len(set) == 0 {
		return nil, nothingToUpdate()
	}
	return set, nil
}

func nothingToUpdate() error {
	var is valid.Issues
	is.Add("", "Nothing to update.")
	return is.Err()
}

func (h *Handler) slugFree(ctx context.Context, coll, s, label string, except *bson.ObjectID) error {
	f := bson.D{{Key: "slug", Value: s}}
	if except != nil {
		f = append(f, bson.E{Key: "_id", Value: bson.D{{Key: "$ne", Value: *except}}})
	}
	n, err := h.col(coll).CountDocuments(ctx, f)
	if err != nil {
		return err
	}
	if n > 0 {
		return storeErr(409, "SLUG_TAKEN", "Another "+label+` already uses the handle "`+s+`".`)
	}
	return nil
}

func get(d bson.D, key string) (any, bool) {
	for _, e := range d {
		if e.Key == key {
			return e.Value, true
		}
	}
	return nil, false
}

func (h *Handler) changed(ctx context.Context, action, entityType string, id bson.ObjectID, actor bson.ObjectID, meta bson.D) {
	_ = h.Audit.Write(ctx, audit.Entry{ActorID: actor, Action: action, EntityType: entityType, EntityID: id.Hex(), Metadata: meta})
	h.publish(ctx, realtime.Change{Global: true, Platform: true})
}

func (h *Handler) createCategory(c *gin.Context) {
	actor, ok := h.superadmin(c)
	if !ok {
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	set, err := categoryFields(body, false)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	s, _ := get(set, "slug")
	if err := h.slugFree(c, "storecategories", s.(string), "category", nil); err != nil {
		httpx.Fail(c, err)
		return
	}
	now := h.Now().UTC().Truncate(time.Millisecond)
	id := bson.NewObjectID()
	doc := append(bson.D{{Key: "_id", Value: id}}, set...)
	doc = append(doc, bson.E{Key: "createdBy", Value: actor}, bson.E{Key: "updatedBy", Value: actor}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := h.col("storecategories").InsertOne(c, doc); err != nil {
		httpx.Fail(c, err)
		return
	}
	var row categoryRow
	if err := h.col("storecategories").FindOne(c, bson.D{{Key: "_id", Value: id}}).Decode(&row); err != nil {
		httpx.Fail(c, err)
		return
	}
	h.changed(c, "STORE_CATEGORY_CREATED", "StoreCategory", id, actor, bson.D{{Key: "name", Value: row.Name}})
	httpx.Write(c, 201, ordered.Map{{Key: "category", Value: row.out()}}, "Category created")
}

func (h *Handler) updateCategory(c *gin.Context) {
	actor, ok := h.superadmin(c)
	if !ok {
		return
	}
	id, err := objectID(c.Param("categoryId"), "category id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	set, err := categoryFields(body, true)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if s, ok := get(set, "slug"); ok && s != "" {
		if err := h.slugFree(c, "storecategories", s.(string), "category", &id); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	set = append(set, bson.E{Key: "updatedBy", Value: actor}, bson.E{Key: "updatedAt", Value: h.Now().UTC()})
	var row categoryRow
	err = h.col("storecategories").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: set}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, storeErr(404, "CATEGORY_NOT_FOUND", "That category was not found."))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.changed(c, "STORE_CATEGORY_UPDATED", "StoreCategory", id, actor, bson.D{{Key: "name", Value: row.Name}})
	httpx.OK(c, ordered.Map{{Key: "category", Value: row.out()}}, "Category updated")
}

func (h *Handler) deleteCategory(c *gin.Context) {
	actor, ok := h.superadmin(c)
	if !ok {
		return
	}
	raw := c.Param("categoryId")
	id, err := objectID(raw, "category id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	inUse, err := h.col("storeproducts").CountDocuments(c, bson.D{{Key: "categoryId", Value: id}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if inUse > 0 {
		what := " products are"
		if inUse == 1 {
			what = " product is"
		}
		httpx.Fail(c, storeErr(409, "CATEGORY_IN_USE", strconv.FormatInt(inUse, 10)+what+" still in this category. Move or delete them first, or switch the category off instead."))
		return
	}
	var row categoryRow
	err = h.col("storecategories").FindOneAndDelete(c, bson.D{{Key: "_id", Value: id}}).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, storeErr(404, "CATEGORY_NOT_FOUND", "That category was not found."))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.changed(c, "STORE_CATEGORY_DELETED", "StoreCategory", id, actor, bson.D{{Key: "name", Value: row.Name}})
	httpx.OK(c, ordered.Map{{Key: "categoryId", Value: raw}}, "Category deleted")
}

func (h *Handler) adminProducts(c *gin.Context) {
	if _, ok := h.superadmin(c); !ok {
		return
	}
	q, err := readListQuery(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	filter := bson.D{}
	if q.Category != "" {
		var row categoryRow
		catID := bson.NewObjectID() // matches nothing when the slug is unknown
		if h.col("storecategories").FindOne(c, bson.D{{Key: "slug", Value: toLower(q.Category)}}).Decode(&row) == nil {
			catID = row.ID
		}
		filter = append(filter, bson.E{Key: "categoryId", Value: catID})
	}
	if q.Search != "" {
		filter = append(filter, bson.E{Key: "$or", Value: searchOr(q.Search, "name", "slug", "tags")})
	}
	r := pagination.RangeOf(q.Page)
	products, err := findAll[productRow](c, h.col("storeproducts"), filter, options.Find().SetSort(bson.D{{Key: "priority", Value: -1}, {Key: "createdAt", Value: -1}}).SetSkip(int64(r.Skip)).SetLimit(int64(r.Limit)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	total, err := h.col("storeproducts").CountDocuments(c, filter)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	live, err := h.col("storeproducts").CountDocuments(c, bson.D{{Key: "isActive", Value: true}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cats, err := findAll[categoryRow](c, h.col("storecategories"), bson.D{})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	byID := map[bson.ObjectID]*categoryRow{}
	for i := range cats {
		byID[cats[i].ID] = &cats[i]
	}
	out := make([]ordered.Map, len(products))
	for i, p := range products {
		out[i] = append(p.out(byID[p.CategoryID]), ordered.Pair{Key: "isActive", Value: p.IsActive}, ordered.Pair{Key: "stockOnHand", Value: p.StockQuantity})
	}
	httpx.OK(c, ordered.Map{{Key: "pagination", Value: pagination.MetaOf(q.Page, int(total))}, {Key: "products", Value: out},
		{Key: "summary", Value: ordered.Map{{Key: "live", Value: live}, {Key: "total", Value: total}}}}, "Products loaded")
}

// productFields reads storeProductCreateSchema, or the update schema
// (.partial(), compareAtPrice nullable). Keys come back in schema order.
func productFields(body any, partial bool) (bson.D, bool, error) {
	f := valid.NewForm(body)
	set := bson.D{}
	clearCompare := false
	put := func(k string, v any, ok bool) {
		if ok {
			set = append(set, bson.E{Key: k, Value: v})
		}
	}
	num := func(key string, min, max float64, def *float64, opt bool) {
		if partial && !f.Present(key) {
			return
		}
		n := valid.N{Opt: opt || partial, Coerce: true, Int: true, Min: valid.P(min), Max: valid.P(max)}
		if !partial {
			n.Default = def
		}
		v, ok := f.Num(key, n)
		if ok {
			put(key, int64(v), true)
		}
	}
	str := func(key string, o valid.S, def *string) {
		o.Opt = o.Opt || partial || def != nil

		v, ok := f.Str(key, o)
		if !ok && def != nil && !f.Present(key) {
			v, ok = *def, true
		}
		put(key, v, ok)
	}
	boolean := func(key string, def bool) {
		if partial && !f.Present(key) {
			return
		}
		var d *bool
		if !partial {
			d = &def
		}
		if v, ok := f.Bool(key, false, d); ok {
			put(key, v, true)
		}
	}
	str("categoryId", valid.S{Trim: true, Min: 1}, nil)
	if f.Present("compareAtPrice") && f.M["compareAtPrice"] == nil && partial {
		clearCompare = true
	} else {
		num("compareAtPrice", 0, 100000000, nil, true)
	}
	str("description", valid.S{Opt: true, Trim: true, Max: 4000}, nil)
	if !partial || f.Present("images") {
		arr, _ := f.Array("images", partial, !partial)
		if arr != nil || !partial {
			f.Size("images", len(arr), 0, 8, "", false)
			imgs := bson.A{}
			for i, raw := range arr {
				sub := valid.NewForm(raw)
				im := bson.D{}
				a, aok := sub.Str("assetId", valid.S{Opt: true, Trim: true, Max: 160})
				if aok {
					im = append(im, bson.E{Key: "assetId", Value: a})
				}
				u, uok := link(sub, "url")
				if uok {
					im = append(im, bson.E{Key: "url", Value: u})
				}
				if sub.Err() == nil && a == "" && u == "" {
					sub.Is.Add("", "An image needs either an uploaded asset or a URL.")
				}
				f.Join("images."+strconv.Itoa(i), sub)
				imgs = append(imgs, im)
			}
			put("images", imgs, true)
		}
	}
	boolean("isActive", true)
	boolean("isFeatured", false)
	num("maxOrderQuantity", 0, 10000, valid.P(0), false)
	num("minOrderQuantity", 1, 10000, valid.P(1), false)
	str("name", valid.S{Trim: true, Min: 1, Max: 160}, nil)
	num("price", 0, 100000000, nil, false)
	num("priority", -1000, 1000, valid.P(0), false)
	if s, ok := slug(f, partial); ok {
		put("slug", s, true)
	}
	num("stockQuantity", 0, 1000000, valid.P(0), false)
	str("summary", valid.S{Opt: true, Trim: true, Max: 200}, nil)
	if !partial || f.Present("tags") {
		arr, _ := f.Array("tags", partial, !partial)
		f.Size("tags", len(arr), 0, 20, "", false)
		tags := bson.A{}
		for i, raw := range arr {
			sub := valid.NewForm(map[string]any{"t": raw})
			t, _ := sub.Str("t", valid.S{Trim: true, Min: 1, Max: 40})
			f.JoinScalar("tags."+strconv.Itoa(i), sub)
			tags = append(tags, t)
		}
		put("tags", tags, true)
	}
	boolean("trackStock", true)
	piece := "piece"
	if partial {
		str("unit", valid.S{Trim: true, Max: 24}, nil)
	} else {
		str("unit", valid.S{Trim: true, Max: 24}, &piece)
	}
	if err := f.Err(); err != nil {
		return nil, false, err
	}
	if partial {
		if len(set) == 0 && !clearCompare {
			return nil, false, nothingToUpdate()
		}
		return set, clearCompare, nil
	}
	var is valid.Issues
	mx, _ := get(set, "maxOrderQuantity")
	mn, _ := get(set, "minOrderQuantity")
	if mx.(int64) != 0 && mx.(int64) < mn.(int64) {
		is.Add("maxOrderQuantity", "The maximum per order cannot be below the minimum.")
	}
	if cp, ok := get(set, "compareAtPrice"); ok {
		pr, _ := get(set, "price")
		if cp.(int64) <= pr.(int64) {
			is.Add("compareAtPrice", "The struck-through price has to be above the price being charged.")
		}
	}
	return set, false, is.Err()
}

func (h *Handler) productOut(ctx context.Context, id bson.ObjectID) (productRow, ordered.Map, error) {
	var p productRow
	if err := h.col("storeproducts").FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&p); err != nil {
		return p, nil, err
	}
	var cat categoryRow
	if h.col("storecategories").FindOne(ctx, bson.D{{Key: "_id", Value: p.CategoryID}}).Decode(&cat) == nil {
		return p, p.out(&cat), nil
	}
	return p, p.out(nil), nil
}

func (h *Handler) categoryExists(ctx context.Context, raw string) (bson.ObjectID, error) {
	id, err := objectID(raw, "category id")
	if err != nil {
		return id, err
	}
	n, err := h.col("storecategories").CountDocuments(ctx, bson.D{{Key: "_id", Value: id}})
	if err == nil && n == 0 {
		err = storeErr(422, "CATEGORY_NOT_FOUND", "Choose a category that exists.")
	}
	return id, err
}

func (h *Handler) createProduct(c *gin.Context) {
	actor, ok := h.superadmin(c)
	if !ok {
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	set, _, err := productFields(body, false)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	s, _ := get(set, "slug")
	if err := h.slugFree(c, "storeproducts", s.(string), "product", nil); err != nil {
		httpx.Fail(c, err)
		return
	}
	raw, _ := get(set, "categoryId")
	catID, err := h.categoryExists(c, raw.(string))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	for i := range set {
		if set[i].Key == "categoryId" {
			set[i].Value = catID
		}
	}
	now := h.Now().UTC().Truncate(time.Millisecond)
	id := bson.NewObjectID()
	doc := append(bson.D{{Key: "_id", Value: id}}, set...)
	doc = append(doc, bson.E{Key: "createdBy", Value: actor}, bson.E{Key: "updatedBy", Value: actor}, bson.E{Key: "isDemoData", Value: false},
		bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := h.col("storeproducts").InsertOne(c, doc); err != nil {
		httpx.Fail(c, err)
		return
	}
	p, out, err := h.productOut(c, id)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.changed(c, "STORE_PRODUCT_CREATED", "StoreProduct", id, actor, bson.D{{Key: "name", Value: p.Name}, {Key: "price", Value: p.Price}})
	httpx.Write(c, 201, ordered.Map{{Key: "product", Value: out}}, "Product created")
}

func (h *Handler) updateProduct(c *gin.Context) {
	actor, ok := h.superadmin(c)
	if !ok {
		return
	}
	id, err := objectID(c.Param("productId"), "product id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	set, clearCompare, err := productFields(body, true)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var existing productRow
	err = h.col("storeproducts").FindOne(c, bson.D{{Key: "_id", Value: id}}).Decode(&existing)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, storeErr(404, "PRODUCT_NOT_FOUND", "That product was not found."))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if s, ok := get(set, "slug"); ok && s != "" {
		if err := h.slugFree(c, "storeproducts", s.(string), "product", &id); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	// The limits are checked against the merged row: a partial update can
	// break a rule the stored product satisfies on its own.
	mx, mn, price, compare := existing.maxOrder(), existing.minOrder(), existing.Price, existing.CompareAtPrice
	if v, ok := get(set, "maxOrderQuantity"); ok {
		mx = v.(int64)
	}
	if v, ok := get(set, "minOrderQuantity"); ok {
		mn = v.(int64)
	}
	if v, ok := get(set, "price"); ok {
		price = v.(int64)
	}
	if v, ok := get(set, "compareAtPrice"); ok {
		cp := v.(int64)
		compare = &cp
	}
	if clearCompare {
		compare = nil
	}
	if mx > 0 && mx < mn {
		httpx.Fail(c, storeErr(422, "INVALID_ORDER_LIMITS", "The maximum per order cannot be below the minimum."))
		return
	}
	if compare != nil && *compare <= price {
		httpx.Fail(c, storeErr(422, "INVALID_COMPARE_PRICE", "The struck-through price has to be above the price being charged."))
		return
	}
	catID := existing.CategoryID
	if raw, ok := get(set, "categoryId"); ok {
		if catID, err = h.categoryExists(c, raw.(string)); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	upd := bson.D{}
	for _, e := range set {
		if e.Key != "categoryId" {
			upd = append(upd, e)
		}
	}
	upd = append(upd, bson.E{Key: "categoryId", Value: catID}, bson.E{Key: "updatedBy", Value: actor}, bson.E{Key: "updatedAt", Value: h.Now().UTC()})
	update := bson.D{{Key: "$set", Value: upd}}
	if clearCompare {
		update = append(update, bson.E{Key: "$unset", Value: bson.D{{Key: "compareAtPrice", Value: ""}}})
	}
	if _, err := h.col("storeproducts").UpdateOne(c, bson.D{{Key: "_id", Value: id}}, update); err != nil {
		httpx.Fail(c, err)
		return
	}
	p, out, err := h.productOut(c, id)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.changed(c, "STORE_PRODUCT_UPDATED", "StoreProduct", id, actor, bson.D{{Key: "name", Value: p.Name}, {Key: "price", Value: p.Price}})
	httpx.OK(c, ordered.Map{{Key: "product", Value: out}}, "Product updated")
}

func (h *Handler) deleteProduct(c *gin.Context) {
	actor, ok := h.superadmin(c)
	if !ok {
		return
	}
	raw := c.Param("productId")
	id, err := objectID(raw, "product id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var p productRow
	err = h.col("storeproducts").FindOneAndDelete(c, bson.D{{Key: "_id", Value: id}}).Decode(&p)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, storeErr(404, "PRODUCT_NOT_FOUND", "That product was not found."))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if _, err := h.col("storecarts").UpdateMany(c, bson.D{}, bson.D{{Key: "$pull", Value: bson.D{{Key: "items", Value: bson.D{{Key: "productId", Value: id}}}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	h.changed(c, "STORE_PRODUCT_DELETED", "StoreProduct", id, actor, bson.D{{Key: "name", Value: p.Name}})
	httpx.OK(c, ordered.Map{{Key: "productId", Value: raw}}, "Product deleted")
}

// plainMap turns an ordered config (nested too) into what valid.Form reads.
func plainMap(o ordered.Map) map[string]any {
	m := map[string]any{}
	for _, p := range o {
		if sub, ok := p.Value.(ordered.Map); ok {
			m[p.Key] = plainMap(sub)
		} else {
			m[p.Key] = p.Value
		}
	}
	return m
}
