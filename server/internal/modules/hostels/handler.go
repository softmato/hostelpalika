package hostels

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
	"github.com/softmato/hostelpalika/server/internal/platform/zschema"
)

// Handler is the public hostel routes under app/api/v1/public/hostels.
type Handler struct {
	public *Public
}

func NewHandler(public *Public) *Handler { return &Handler{public} }

func (h *Handler) Register(v1 *gin.RouterGroup) {
	p := v1.Group("/public/hostels")
	p.GET("", h.list) // cache.Respond sets the ETag
	p.GET("/compare", httpx.ETag(), h.compare)
	p.GET("/sitemap", h.sitemap)
	p.GET("/locations", h.locations)
	p.GET("/near", h.near)
	p.GET("/:slug", h.bySlug)
}

// parseList is publicHostelListQuerySchema, fields in declared order.
func parseList(q map[string]string) (ListQuery, error) {
	var is valid.Issues
	var out ListQuery
	out.Area = valid.QueryString(q, "area", 1, 120, &is)
	out.City = valid.QueryString(q, "city", 1, 120, &is)
	out.Facility = valid.QueryString(q, "facility", 1, 500, &is)
	out.Food = valid.QueryEnum(q, "food", &is, "veg", "non-veg")
	out.MaxPrice = valid.QueryNumber(q, "maxPrice", true, &is)
	out.MinPrice = valid.QueryNumber(q, "minPrice", true, &is)
	out.Q = valid.QueryString(q, "q", 1, 160, &is)
	out.RoomType = valid.QueryString(q, "roomType", 1, 80, &is)
	out.Stay = valid.QueryEnum(q, "stay", &is, "short")
	out.Type = valid.QueryEnum(q, "type", &is, "BOYS", "GIRLS", "CO_LIVING")
	return out, is.Err()
}

func (h *Handler) list(c *gin.Context) {
	q, err := parseList(valid.Query(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.PublicCache(c)
	// One shared copy per query for everyone (P11-17): "public" is never bumped,
	// so a listing edit shows within cache.TTL, the s-maxage it already promised.
	cache.Respond(c, h.public.Cache, []string{"public"}, "", "hostels?"+c.Request.URL.RawQuery, "Public hostels loaded",
		func() (ordered.Map, error) { return h.public.List(c, q) })
}

func (h *Handler) bySlug(c *gin.Context) {
	out, err := h.public.BySlug(c, c.Param("slug"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.PublicCache(c)
	httpx.OK(c, out, "Public hostel loaded")
}

var objectIDRe = regexp.MustCompile(`(?i)^[a-f\d]{24}$`)

// parseCompare is publicHostelCompareQuerySchema: a trimmed non-empty string,
// split on commas, piped into 2–3 ObjectIds.
func parseCompare(q map[string]string) ([]string, error) {
	var is valid.Issues
	raw, ok := q["ids"]
	if !ok {
		is.Add("ids", valid.Type("string", "undefined"))
		return nil, is.Err()
	}
	s := zschema.JSTrim(raw)
	if s == "" {
		is.Add("ids", valid.TooSmall("string", 1, true))
		return nil, is.Err()
	}
	ids := []string{}
	for _, part := range strings.Split(s, ",") {
		if part = zschema.JSTrim(part); part != "" {
			ids = append(ids, part)
		}
	}
	for i, id := range ids {
		if !objectIDRe.MatchString(id) {
			is.Add("ids."+itoa(i), "Invalid object id.")
		}
	}
	if len(ids) < 2 {
		is.Add("ids", "Select at least 2 hostels to compare.")
	}
	if len(ids) > 3 {
		is.Add("ids", "Compare up to 3 hostels at a time.")
	}
	return ids, is.Err()
}

func itoa(i int) string { return strconv.Itoa(i) }

func (h *Handler) compare(c *gin.Context) {
	ids, err := parseCompare(valid.Query(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.public.Compare(c, ids)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Hostel comparison loaded")
}
