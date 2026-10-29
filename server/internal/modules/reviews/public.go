// Package reviews: so far the public read (review.service.ts
// listPublicHostelReviews). Writing and moderating land with Phases 5 and 7.
package reviews

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"unicode/utf16"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"golang.org/x/sync/errgroup"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/plans"
)

type Handler struct{ db *mongo.Database }

func NewHandler(db *mongo.Database) *Handler { return &Handler{db} }

func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.GET("/public/hostels/:slug/reviews", h.list)
}

func (h *Handler) list(c *gin.Context) {
	out, err := h.listPublic(c, c.Param("slug"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Reviews loaded")
}

// ObjectID is mongoose's ObjectId.isValid + new ObjectId: 24 hex characters
// (a 12-character string is not an id for the bson version TS runs).
func ObjectID(s string) (bson.ObjectID, bool) {
	id, err := bson.ObjectIDFromHex(s)
	return id, err == nil
}

// resolveHostelID: an id is taken as given; a slug must name a live hostel.
func (h *Handler) resolveHostelID(ctx context.Context, ref string) (bson.ObjectID, error) {
	if id, ok := ObjectID(ref); ok {
		return id, nil
	}
	var row struct {
		ID bson.ObjectID `bson:"_id"`
	}
	err := h.db.Collection("hostels").FindOne(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "slug", Value: ref}},
		options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return row.ID, httpx.NewError(http.StatusNotFound, "HOSTEL_NOT_FOUND", "Hostel was not found.", nil)
	}
	return row.ID, err
}

var scores = []string{"overallRating", "cleanlinessRating", "foodRating", "locationRating", "managementRating", "roomRating", "safetyRating"}

func rawNum(r bson.Raw, key string) (float64, bool) {
	f, ok := ordered.FromBSON(r.Lookup(key)).(float64)
	return f, ok
}

// averageOf: unscored reviews are skipped; one decimal; null when none.
func averageOf(rows []bson.Raw, key string) *float64 {
	sum, n := 0.0, 0
	for _, r := range rows {
		if f, ok := rawNum(r, key); ok {
			sum, n = sum+f, n+1
		}
	}
	if n == 0 {
		return nil
	}
	v := plans.JSRound(sum/float64(n)*10) / 10
	return &v
}

type star struct {
	Count int `json:"count"`
	Stars int `json:"stars"`
}

type categories struct {
	Cleanliness *float64 `json:"cleanliness"`
	Food        *float64 `json:"food"`
	Location    *float64 `json:"location"`
	Management  *float64 `json:"management"`
	Overall     *float64 `json:"overall"`
	Room        *float64 `json:"room"`
	Security    *float64 `json:"security"`
}

type summary struct {
	AverageRating float64    `json:"averageRating"`
	Categories    categories `json:"categories"`
	Distribution  []star     `json:"distribution"`
	Total         int        `json:"total"`
}

type page struct {
	Pagination pagination.Meta `json:"pagination"`
	Reviews    []any           `json:"reviews"`
	Summary    summary         `json:"summary"`
}

func findAll(ctx context.Context, coll *mongo.Collection, filter bson.D, opts *options.FindOptionsBuilder) ([]bson.Raw, error) {
	cur, err := coll.Find(ctx, filter, opts)
	if err != nil {
		return nil, err
	}
	var rows []bson.Raw
	return rows, cur.All(ctx, &rows)
}

// listPublic is listPublicHostelReviews: one page of visible reviews, and a
// summary over every visible review (not the page), so a rating never changes
// as somebody clicks through pages.
func (h *Handler) listPublic(ctx context.Context, ref string) (*page, error) {
	hostelID, err := h.resolveHostelID(ctx, ref)
	if err != nil {
		return nil, err
	}
	filter := bson.D{{Key: "hostelId", Value: hostelID}, {Key: "status", Value: "VISIBLE"}}
	size := pagination.MaxPageSize
	q := pagination.Query{PageSize: &size}
	rg := pagination.RangeOf(q)
	coll := h.db.Collection("ratingreviews")
	var reviews, scored []bson.Raw
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() (err error) {
		reviews, err = findAll(gctx, coll, filter, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetSkip(int64(rg.Skip)).SetLimit(int64(rg.Limit)))
		return
	})
	g.Go(func() (err error) {
		proj := bson.D{}
		for _, s := range scores {
			proj = append(proj, bson.E{Key: s, Value: 1})
		}
		scored, err = findAll(gctx, coll, filter, options.Find().SetProjection(proj))
		return
	})
	if err := g.Wait(); err != nil {
		return nil, err
	}
	residentIDs := bson.A{}
	for _, r := range reviews {
		residentIDs = append(residentIDs, r.Lookup("residentId"))
	}
	cur, err := h.db.Collection("residents").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: residentIDs}}}})
	if err != nil {
		return nil, err
	}
	var residents []struct {
		ID        bson.ObjectID `bson:"_id"`
		FirstName string        `bson:"firstName"`
		LastName  string        `bson:"lastName"`
	}
	if err := cur.All(ctx, &residents); err != nil {
		return nil, err
	}
	names := map[string]string{}
	for _, r := range residents {
		last := utf16.Encode([]rune(r.LastName))
		initial := ""
		if len(last) > 0 {
			initial = string(utf16.Decode(last[:1]))
		}
		names[r.ID.Hex()] = strings.TrimSpace(r.FirstName + " " + initial + ".")
	}
	out := &page{Pagination: pagination.MetaOf(q, len(scored)), Reviews: []any{}}
	for _, r := range reviews {
		rid, _ := r.Lookup("residentId").ObjectIDOK()
		name, ok := names[rid.Hex()]
		if !ok {
			name = "Verified resident"
		}
		out.Reviews = append(out.Reviews, serializePublic(r, name))
	}
	total := 0.0
	for _, r := range scored {
		f, _ := rawNum(r, "overallRating")
		total += f
	}
	if len(scored) > 0 {
		out.Summary.AverageRating = total / float64(len(scored))
	}
	out.Summary.Categories = categories{
		Cleanliness: averageOf(scored, "cleanlinessRating"), Food: averageOf(scored, "foodRating"),
		Location: averageOf(scored, "locationRating"), Management: averageOf(scored, "managementRating"),
		Overall: averageOf(scored, "overallRating"), Room: averageOf(scored, "roomRating"), Security: averageOf(scored, "safetyRating"),
	}
	for _, stars := range []int{5, 4, 3, 2, 1} {
		n := 0
		for _, r := range scored {
			if f, ok := rawNum(r, "overallRating"); ok && int(plans.JSRound(f)) == stars {
				n++
			}
		}
		out.Summary.Distribution = append(out.Summary.Distribution, star{n, stars})
	}
	out.Summary.Total = len(scored)
	return out, nil
}

func pass(r bson.Raw, key string) any {
	v := r.Lookup(key)
	if v.Type == 0 {
		return ordered.Undefined
	}
	return ordered.FromBSON(v)
}

// serializePublic is serializePublicReview: unscored categories stay absent.
func serializePublic(r bson.Raw, name string) ordered.Map {
	comment := pass(r, "comment")
	if comment == ordered.Undefined || comment == nil {
		comment = ""
	}
	id, _ := r.Lookup("_id").ObjectIDOK()
	return ordered.Map{
		{Key: "cleanlinessRating", Value: pass(r, "cleanlinessRating")},
		{Key: "comment", Value: comment},
		{Key: "createdAt", Value: pass(r, "createdAt")},
		{Key: "foodRating", Value: pass(r, "foodRating")},
		{Key: "id", Value: id.Hex()},
		{Key: "isVerifiedResident", Value: true},
		{Key: "locationRating", Value: pass(r, "locationRating")},
		{Key: "managementRating", Value: pass(r, "managementRating")},
		{Key: "overallRating", Value: pass(r, "overallRating")},
		{Key: "reviewerName", Value: name},
		{Key: "roomRating", Value: pass(r, "roomRating")},
		{Key: "safetyRating", Value: pass(r, "safetyRating")},
	}
}
