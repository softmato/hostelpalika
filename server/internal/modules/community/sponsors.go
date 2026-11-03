package community

import (
	"errors"
	"net/http"
	"regexp"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

type sponsorRow struct {
	ID          bson.ObjectID `bson:"_id"`
	AccentColor *string       `bson:"accentColor"`
	ClickCount  int64         `bson:"clickCount"`
	CreatedAt   *time.Time    `bson:"createdAt"`
	CtaLabel    *string       `bson:"ctaLabel"`
	EndsAt      *time.Time    `bson:"endsAt"`
	Highlight   string        `bson:"highlight"`
	ImageAsset  string        `bson:"imageAssetId"`
	ImageURL    string        `bson:"imageUrl"`
	Impressions int64         `bson:"impressionCount"`
	IsActive    bool          `bson:"isActive"`
	Kind        string        `bson:"kind"`
	LinkURL     string        `bson:"linkUrl"`
	Name        string        `bson:"name"`
	Priority    float64       `bson:"priority"`
	StartsAt    *time.Time    `bson:"startsAt"`
	Subtitle    string        `bson:"subtitle"`
}

type sponsorAdminOut struct {
	AccentColor string  `json:"accentColor"`
	ClickCount  int64   `json:"clickCount"`
	CreatedAt   string  `json:"createdAt,omitempty"`
	CtaLabel    string  `json:"ctaLabel"`
	EndsAt      *string `json:"endsAt"`
	Highlight   string  `json:"highlight"`
	ID          string  `json:"id"`
	ImageAsset  string  `json:"imageAssetId"`
	ImageURL    string  `json:"imageUrl"`
	Impressions int64   `json:"impressionCount"`
	IsActive    bool    `json:"isActive"`
	Kind        string  `json:"kind"`
	LinkURL     string  `json:"linkUrl"`
	Name        string  `json:"name"`
	Priority    float64 `json:"priority"`
	StartsAt    *string `json:"startsAt"`
	Subtitle    string  `json:"subtitle"`
}

func isoPtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := httpx.ISO(*t)
	return &s
}

func (s *sponsorRow) out() sponsorAdminOut {
	o := sponsorAdminOut{AccentColor: "#0a8a4b", ClickCount: s.ClickCount, CtaLabel: "View", EndsAt: isoPtr(s.EndsAt), Highlight: s.Highlight, ID: s.ID.Hex(),
		ImageAsset: s.ImageAsset, ImageURL: s.ImageURL, Impressions: s.Impressions, IsActive: s.IsActive, Kind: s.Kind, LinkURL: s.LinkURL, Name: s.Name,
		Priority: s.Priority, StartsAt: isoPtr(s.StartsAt), Subtitle: s.Subtitle}
	if s.AccentColor != nil {
		o.AccentColor = *s.AccentColor
	}
	if s.CtaLabel != nil {
		o.CtaLabel = *s.CtaLabel
	}
	if s.CreatedAt != nil {
		o.CreatedAt = httpx.ISO(*s.CreatedAt)
	}
	return o
}

func liveSponsorFilter(now time.Time) bson.D {
	return bson.D{{Key: "$and", Value: bson.A{
		bson.D{{Key: "isActive", Value: true}},
		bson.D{{Key: "$or", Value: bson.A{bson.D{{Key: "startsAt", Value: bson.D{{Key: "$lte", Value: now}}}}, bson.D{{Key: "startsAt", Value: nil}}}}},
		bson.D{{Key: "$or", Value: bson.A{bson.D{{Key: "endsAt", Value: bson.D{{Key: "$gte", Value: now}}}}, bson.D{{Key: "endsAt", Value: nil}}}}},
	}}}
}

// RegisterSponsors is /platform/sponsors (sponsor.service.ts). Superadmin only:
// selling a placement is a commercial decision, not moderation.
func (h *Handler) RegisterSponsors(v1 *gin.RouterGroup, log *audit.Log) {
	v1.GET("/platform/sponsors", httpx.ETag(), h.listSponsors)
	v1.POST("/platform/sponsors", func(c *gin.Context) { h.writeSponsor(c, log, false) })
	v1.PATCH("/platform/sponsors/:sponsorId", func(c *gin.Context) { h.writeSponsor(c, log, true) })
	v1.DELETE("/platform/sponsors/:sponsorId", func(c *gin.Context) { h.deleteSponsor(c, log) })
}

func sponsorErr(status int, code, msg string) error { return httpx.NewError(status, code, msg, nil) }

func (h *Handler) listSponsors(c *gin.Context) {
	if _, err := h.Guards.RequireSuperadmin(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	page := valid.Page(q, &is)
	status := valid.QueryEnum(q, "status", &is, "active", "inactive", "all")
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	filter := bson.D{}
	if status != nil && *status != "all" {
		filter = bson.D{{Key: "isActive", Value: *status == "active"}}
	}
	coll := h.DB.Collection("sponsors")
	r := pagination.RangeOf(page)
	cur, err := coll.Find(c, filter, options.Find().SetSort(bson.D{{Key: "priority", Value: -1}, {Key: "createdAt", Value: -1}}).SetSkip(int64(r.Skip)).SetLimit(int64(r.Limit)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []sponsorRow
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	total, err := coll.CountDocuments(c, filter)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	live, err := coll.CountDocuments(c, liveSponsorFilter(time.Now()))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]sponsorAdminOut, len(rows))
	for i := range rows {
		out[i] = rows[i].out()
	}
	httpx.OK(c, ordered.Map{{Key: "pagination", Value: pagination.MetaOf(page, int(total))}, {Key: "sponsors", Value: out},
		{Key: "summary", Value: ordered.Map{{Key: "live", Value: live}, {Key: "total", Value: total}}}}, "Sponsors loaded")
}

var hexColorRe = regexp.MustCompile(`(?i)^#[0-9a-f]{6}$`)
var httpLinkRe = regexp.MustCompile(`(?i)^https?://`)

func sponsorLink(f *valid.Form, key string) (string, bool) {
	v, ok := f.Str(key, valid.S{Opt: true, Trim: true, Max: 500})
	if ok && v != "" && v[0] != '/' && !httpLinkRe.MatchString(v) {
		f.Is.Add(key, "Link must start with / or http(s)://")
		return "", false
	}
	return v, ok
}

// sponsorFields reads sponsorCreateSchema, or for an update only the keys sent:
// TS's `.partial()` kept the create defaults, so every edit reset accentColor,
// ctaLabel, isActive, kind and priority (P7-23, the P7-7 bug again).
func sponsorFields(body any, partial bool) (bson.D, *time.Time, *time.Time, error) {
	f := valid.NewForm(body)
	set := bson.D{}
	put := func(k string, v any, ok bool) {
		if ok {
			set = append(set, bson.E{Key: k, Value: v})
		}
	}
	str := func(key string, o valid.S, def string) {
		if v, ok := f.Str(key, o); ok {
			put(key, v, true)
		} else if !partial && def != "" && !f.Present(key) {
			put(key, def, true)
		}
	}
	str("accentColor", valid.S{Opt: true, Trim: true, Re: hexColorRe, ReMsg: "Use a 6-digit hex colour, e.g. #0a8a4b."}, "#0a8a4b")
	str("ctaLabel", valid.S{Opt: true, Trim: true, Max: 40}, "View")
	ends, ok := opsscope.OptDate(f, "endsAt")
	put("endsAt", deref(ends), ok)
	str("highlight", valid.S{Opt: true, Trim: true, Max: 80}, "")
	str("imageAssetId", valid.S{Opt: true, Trim: true, Max: 120}, "")
	v, ok := sponsorLink(f, "imageUrl")
	put("imageUrl", v, ok)
	var t *bool
	if !partial {
		yes := true
		t = &yes
	}
	b, ok := f.Bool("isActive", true, t)
	put("isActive", b, ok)
	var kindDef *string
	if !partial {
		k := "COLLEGE"
		kindDef = &k
	}
	k, ok := f.Enum("kind", true, kindDef, "COLLEGE", "HOSTEL", "BUSINESS", "OTHER")
	put("kind", k, ok)
	v, ok = sponsorLink(f, "linkUrl")
	put("linkUrl", v, ok)
	v, ok = f.Str("name", valid.S{Opt: partial, Trim: true, Min: 1, Max: 120})
	put("name", v, ok)
	n := valid.N{Opt: true, Coerce: true, Int: true, Min: valid.P(-1000), Max: valid.P(1000)}
	if !partial {
		n.Default = valid.P(0)
	}
	if pr, ok := f.Num("priority", n); ok {
		put("priority", int64(pr), true)
	}
	starts, ok := opsscope.OptDate(f, "startsAt")
	put("startsAt", deref(starts), ok)
	str("subtitle", valid.S{Opt: true, Trim: true, Max: 160}, "")
	if partial && !f.Hard && len(f.Is) == 0 && len(set) == 0 {
		f.Is.Add("", "Nothing to update.")
	}
	if err := f.Err(); err != nil {
		return nil, nil, nil, err
	}
	return set, starts, ends, nil
}

func deref(t *time.Time) any {
	if t == nil {
		return nil
	}
	return *t
}

func (h *Handler) writeSponsor(c *gin.Context, log *audit.Log, update bool) {
	p, err := h.Guards.RequireSuperadmin(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, _ := bson.ObjectIDFromHex(p.UserID)
	var id bson.ObjectID
	if update {
		if id, err = httpx.OID(c.Param("sponsorId"), "sponsor id"); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	set, starts, ends, err := sponsorFields(body, update)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	coll := h.DB.Collection("sponsors")
	now := time.Now().UTC().Truncate(time.Millisecond)
	if update {
		var cur sponsorRow
		if err := coll.FindOne(c, bson.D{{Key: "_id", Value: id}}).Decode(&cur); errors.Is(err, mongo.ErrNoDocuments) {
			httpx.Fail(c, sponsorErr(http.StatusNotFound, "SPONSOR_NOT_FOUND", "Sponsor was not found."))
			return
		} else if err != nil {
			httpx.Fail(c, err)
			return
		}
		if starts == nil {
			starts = cur.StartsAt
		}
		if ends == nil {
			ends = cur.EndsAt
		}
	}
	if starts != nil && ends != nil && starts.After(*ends) {
		httpx.Fail(c, sponsorErr(http.StatusUnprocessableEntity, "INVALID_CAMPAIGN_WINDOW", "The campaign cannot end before it starts."))
		return
	}
	var row sponsorRow
	action := "SPONSOR_UPDATED"
	if update {
		set = append(set, bson.E{Key: "updatedBy", Value: actor}, bson.E{Key: "updatedAt", Value: now})
		err = coll.FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: set}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&row)
		if errors.Is(err, mongo.ErrNoDocuments) {
			err = sponsorErr(http.StatusNotFound, "SPONSOR_NOT_FOUND", "Sponsor was not found.")
		}
	} else {
		action = "SPONSOR_CREATED"
		id = bson.NewObjectID()
		doc := append(bson.D{{Key: "_id", Value: id}}, set...)
		doc = append(doc, bson.E{Key: "impressionCount", Value: 0}, bson.E{Key: "clickCount", Value: 0}, bson.E{Key: "createdBy", Value: actor}, bson.E{Key: "updatedBy", Value: actor},
			bson.E{Key: "isDemoData", Value: false}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
		if _, err = coll.InsertOne(c, doc); err == nil {
			err = coll.FindOne(c, bson.D{{Key: "_id", Value: id}}).Decode(&row)
		}
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	sponsorAudit(c, log, action, &row, actor)
	if update {
		httpx.OK(c, gin.H{"sponsor": row.out()}, "Sponsor updated")
		return
	}
	httpx.Write(c, http.StatusCreated, gin.H{"sponsor": row.out()}, "Sponsor created")
}

func (h *Handler) deleteSponsor(c *gin.Context, log *audit.Log) {
	p, err := h.Guards.RequireSuperadmin(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	raw := c.Param("sponsorId")
	id, err := httpx.OID(raw, "sponsor id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var row sponsorRow
	err = h.DB.Collection("sponsors").FindOneAndDelete(c, bson.D{{Key: "_id", Value: id}}).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, sponsorErr(http.StatusNotFound, "SPONSOR_NOT_FOUND", "Sponsor was not found."))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, _ := bson.ObjectIDFromHex(p.UserID)
	sponsorAudit(c, log, "SPONSOR_DELETED", &row, actor)
	httpx.OK(c, gin.H{"sponsorId": raw}, "Sponsor deleted")
}

// sponsorAudit never fails the change the owner just made.
func sponsorAudit(c *gin.Context, log *audit.Log, action string, s *sponsorRow, actor bson.ObjectID) {
	_ = log.Write(c, audit.Entry{ActorID: actor, Action: action, EntityType: "Sponsor", EntityID: s.ID.Hex(),
		Metadata: bson.D{{Key: "name", Value: s.Name}, {Key: "priority", Value: s.Priority}}})
}
