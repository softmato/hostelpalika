package serviceproviders

import (
	"context"
	"errors"
	"regexp"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// RegisterAdmin is what hostel staff see: the approved providers they can call.
func (h *Handler) RegisterAdmin(v1 *gin.RouterGroup, guards *authz.Guards) {
	v1.GET("/hostel-admin/service-providers", httpx.ETag(), func(c *gin.Context) { h.adminList(c, guards) })
	v1.GET("/hostel-admin/service-providers/:id", httpx.ETag(), func(c *gin.Context) { h.adminOne(c, guards) })
}

func (p provider) serialized() ordered.Map {
	return ordered.Map{{Key: "approvedAt", Value: iso(p.ApprovedAt)}, {Key: "approvedBy", Value: oidOrUndefined(p.ApprovedBy)}, {Key: "area", Value: p.Area}, {Key: "availability", Value: p.Availability}, {Key: "categories", Value: p.cats()}, {Key: "category", Value: p.Category},
		{Key: "city", Value: p.city()}, {Key: "createdAt", Value: iso(p.CreatedAt)}, {Key: "description", Value: p.Description}, {Key: "email", Value: p.Email}, {Key: "experience", Value: p.Experience}, {Key: "fullName", Value: p.FullName}, {Key: "hiddenAt", Value: iso(p.HiddenAt)},
		{Key: "hiddenBy", Value: oidOrUndefined(p.HiddenBy)}, {Key: "id", Value: p.ID.Hex()}, {Key: "phone", Value: p.Phone}, {Key: "photoAssetId", Value: oidOrUndefined(p.PhotoAssetID)}, {Key: "ratingSummary", Value: p.rating()}, {Key: "rejectionReason", Value: p.RejectionReason},
		{Key: "status", Value: p.Status}, {Key: "updatedAt", Value: iso(p.UpdatedAt)}}
}

type adminListOut struct {
	Pagination pagination.Meta `json:"pagination"`
	Providers  []ordered.Map   `json:"providers"`
}

func (h *Handler) adminList(c *gin.Context, guards *authz.Guards) {
	if _, err := guards.RequireHostelStaff(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	page := opsscope.ReadPage(q, &is)
	text := func(key string, max int) string {
		raw, ok := q[key]
		if !ok {
			return ""
		}
		f := valid.NewForm(map[string]any{key: raw})
		v, _ := f.Str(key, valid.S{Trim: true, Min: 1, Max: max})
		for _, i := range f.Is {
			is.Add(key, i.Message)
		}
		return v
	}
	area := text("area", 120)
	category := valid.QueryEnum(q, "category", &is, categories...)
	search := text("q", 160)
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	filter := bson.D{{Key: "isDeleted", Value: false}, {Key: "status", Value: "APPROVED"}}
	if area != "" {
		filter = append(filter, bson.E{Key: "area", Value: bson.Regex{Pattern: regexp.QuoteMeta(area), Options: "i"}})
	}
	and := bson.A{}
	if category != nil {
		and = append(and, bson.D{{Key: "$or", Value: bson.A{bson.D{{Key: "categories", Value: *category}}, bson.D{{Key: "category", Value: *category}}}}})
	}
	if search != "" {
		rx := bson.Regex{Pattern: regexp.QuoteMeta(search), Options: "i"}
		and = append(and, bson.D{{Key: "$or", Value: bson.A{bson.D{{Key: "fullName", Value: rx}}, bson.D{{Key: "phone", Value: rx}}, bson.D{{Key: "area", Value: rx}}, bson.D{{Key: "description", Value: rx}}}}})
	}
	if len(and) > 0 {
		filter = append(filter, bson.E{Key: "$and", Value: and})
	}
	r := pagination.RangeOf(page)
	cur, err := h.DB.Collection("serviceproviders").Find(c, filter, options.Find().SetSort(bson.D{{Key: "category", Value: 1}, {Key: "area", Value: 1}, {Key: "fullName", Value: 1}}).SetSkip(int64(r.Skip)).SetLimit(int64(r.Limit)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []provider
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	total, err := h.DB.Collection("serviceproviders").CountDocuments(c, filter)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := adminListOut{Pagination: pagination.MetaOf(page, int(total)), Providers: make([]ordered.Map, len(rows))}
	for i := range rows {
		out.Providers[i] = rows[i].serialized()
	}
	httpx.Write(c, 200, out, "Approved service providers loaded")
}

func (h *Handler) adminOne(c *gin.Context, guards *authz.Guards) {
	if _, err := guards.RequireHostelStaff(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := objectID(c.Param("id"), "service provider id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var row provider
	err = h.DB.Collection("serviceproviders").FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "APPROVED"}}).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, serErr("Service provider was not found.", "SERVICE_PROVIDER_NOT_FOUND", 404))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.bundle(c, &row)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, 200, out, "Service provider loaded")
}

// bundle is providerBundle: the provider, its latest application and its documents.
func (h *Handler) bundle(ctx context.Context, row *provider) (ordered.Map, error) {
	var app struct {
		ID              bson.ObjectID `bson:"_id"`
		ProviderID      bson.ObjectID `bson:"providerId"`
		RejectionReason string        `bson:"rejectionReason"`
		Status          string        `bson:"status"`
		SubmittedAt     *time.Time    `bson:"submittedAt"`
	}
	var application any
	err := h.DB.Collection("serviceproviderapplications").FindOne(ctx, bson.D{{Key: "providerId", Value: row.ID}, {Key: "isDeleted", Value: false}}, options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}})).Decode(&app)
	switch {
	case err == nil:
		application = ordered.Map{{Key: "id", Value: app.ID.Hex()}, {Key: "providerId", Value: app.ProviderID.Hex()}, {Key: "rejectionReason", Value: app.RejectionReason}, {Key: "status", Value: app.Status}, {Key: "submittedAt", Value: iso(app.SubmittedAt)}}
	case !errors.Is(err, mongo.ErrNoDocuments):
		return nil, err
	}
	cur, err := h.DB.Collection("serviceproviderdocuments").Find(ctx, bson.D{{Key: "providerId", Value: row.ID}, {Key: "isDeleted", Value: false}}, options.Find().SetLimit(200))
	if err != nil {
		return nil, err
	}
	var docs []struct {
		ID         bson.ObjectID  `bson:"_id"`
		CreatedAt  *time.Time     `bson:"createdAt"`
		Type       string         `bson:"documentType"`
		FileAsset  *bson.ObjectID `bson:"fileAssetId"`
		FileURL    string         `bson:"fileUrl"`
		ProviderID bson.ObjectID  `bson:"providerId"`
		Status     string         `bson:"status"`
	}
	if err := cur.All(ctx, &docs); err != nil {
		return nil, err
	}
	documents := make([]ordered.Map, len(docs))
	for i, d := range docs {
		var created, asset any
		if d.CreatedAt != nil {
			created = httpx.ISO(*d.CreatedAt)
		}
		if d.FileAsset != nil {
			asset = d.FileAsset.Hex()
		}
		documents[i] = ordered.Map{{Key: "createdAt", Value: created}, {Key: "documentType", Value: d.Type}, {Key: "fileAssetId", Value: asset}, {Key: "fileUrl", Value: d.FileURL}, {Key: "id", Value: d.ID.Hex()}, {Key: "providerId", Value: d.ProviderID.Hex()}, {Key: "status", Value: d.Status}}
	}
	return ordered.Map{{Key: "application", Value: application}, {Key: "documents", Value: documents}, {Key: "provider", Value: row.serialized()}}, nil
}
