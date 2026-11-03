package serviceproviders

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Platform is /platform/service-providers: the review queue.
type Platform struct {
	*Handler
	Config     *platformconfig.Service
	AppURL     func(path string) string
	SendIDCard func(ctx context.Context, user bson.ObjectID, cardType string)
}

func (p *Platform) Register(v1 *gin.RouterGroup) {
	g := v1.Group("/platform/service-providers", authz.Use(p.Guards.RequirePlatform))
	g.GET("", httpx.ETag(), p.list)
	g.GET("/:id", httpx.ETag(), p.one)
	g.PATCH("/:id/approve", func(c *gin.Context) { p.decide(c, "APPROVED", "SERVICE_PROVIDER_APPROVED") })
	g.PATCH("/:id/reject", func(c *gin.Context) { p.decide(c, "REJECTED", "SERVICE_PROVIDER_REJECTED") })
	g.PATCH("/:id/hide", func(c *gin.Context) { p.decide(c, "HIDDEN", "SERVICE_PROVIDER_HIDDEN") })
}

func (p *Platform) list(c *gin.Context) {
	q := valid.Query(c)
	var is valid.Issues
	page := opsscope.ReadPage(q, &is)
	area := ""
	if raw, ok := q["area"]; ok {
		f := valid.NewForm(map[string]any{"area": raw})
		area, _ = f.Str("area", valid.S{Trim: true, Min: 1, Max: 120})
		for _, i := range f.Is {
			is.Add("area", i.Message)
		}
	}
	category := valid.QueryEnum(q, "category", &is, categories...)
	status := valid.QueryEnum(q, "status", &is, "PENDING_APPROVAL", "APPROVED", "REJECTED", "HIDDEN", "INACTIVE")
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	filter := bson.D{{Key: "isDeleted", Value: false}}
	if area != "" {
		filter = append(filter, bson.E{Key: "area", Value: bson.Regex{Pattern: regexp.QuoteMeta(area), Options: "i"}})
	}
	if category != nil {
		filter = append(filter, bson.E{Key: "$or", Value: bson.A{bson.D{{Key: "categories", Value: *category}}, bson.D{{Key: "category", Value: *category}}}})
	}
	if status != nil {
		filter = append(filter, bson.E{Key: "status", Value: *status})
	}
	r := pagination.RangeOf(page)
	coll := p.DB.Collection("serviceproviders")
	cur, err := coll.Find(c, filter, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetSkip(int64(r.Skip)).SetLimit(int64(r.Limit)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []provider
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	total, err := coll.CountDocuments(c, filter)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := adminListOut{Pagination: pagination.MetaOf(page, int(total)), Providers: make([]ordered.Map, len(rows))}
	for i := range rows {
		out.Providers[i] = rows[i].serialized()
	}
	httpx.Write(c, 200, out, "Service providers loaded")
}

func (p *Platform) find(ctx context.Context, raw string) (*provider, error) {
	id, err := objectID(raw, "service provider id")
	if err != nil {
		return nil, err
	}
	var row provider
	err = p.DB.Collection("serviceproviders").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}}).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, serErr("Service provider was not found.", "SERVICE_PROVIDER_NOT_FOUND", 404)
	}
	return &row, err
}

func (p *Platform) one(c *gin.Context) {
	row, err := p.find(c, c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := p.bundle(c, row)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, 200, out, "Service provider loaded")
}

// label is providerCategoryLabel: `DOCTOR_CLINIC` → `Doctor clinic`.
func categoryLabel(category string) string {
	s := strings.ToLower(strings.ReplaceAll(category, "_", " "))
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// decide is updateProviderStatus. The status moves only from the one read, so two
// reviewers racing cannot both send their email.
func (p *Platform) decide(c *gin.Context, status, action string) {
	reason := ""
	if status == "REJECTED" {
		body, err := valid.Body(c)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		f := valid.NewForm(body)
		reason, _ = f.Str("reason", valid.S{Trim: true, Min: 2, Max: 800})
		if err := f.Err(); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	existing, err := p.find(c, c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	pr := authz.From(c)
	actor, _ := bson.ObjectIDFromHex(pr.UserID)
	now := time.Now().UTC().Truncate(time.Millisecond)
	set := bson.D{{Key: "status", Value: status}, {Key: "updatedBy", Value: actor}}
	unset := bson.D{}
	switch status {
	case "APPROVED":
		set = append(set, bson.E{Key: "approvedAt", Value: now}, bson.E{Key: "approvedBy", Value: actor})
		unset = bson.D{{Key: "rejectionReason", Value: ""}, {Key: "hiddenAt", Value: ""}, {Key: "hiddenBy", Value: ""}}
	case "REJECTED":
		set = append(set, bson.E{Key: "rejectionReason", Value: reason})
		unset = bson.D{{Key: "approvedAt", Value: ""}, {Key: "approvedBy", Value: ""}}
	case "HIDDEN":
		set = append(set, bson.E{Key: "hiddenAt", Value: now}, bson.E{Key: "hiddenBy", Value: actor})
	}
	set = append(set, bson.E{Key: "updatedAt", Value: now})
	update := bson.D{{Key: "$set", Value: set}}
	if len(unset) > 0 {
		update = append(update, bson.E{Key: "$unset", Value: unset})
	}
	var row provider
	err = p.DB.Collection("serviceproviders").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: existing.ID}, {Key: "isDeleted", Value: false}, {Key: "status", Value: existing.Status}}, update,
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		// Another reviewer decided first (P7-25).
		httpx.Fail(c, serErr("Someone else just reviewed this provider. Reload to see where it stands.", "SERVICE_PROVIDER_CHANGED", 409))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	decided := status == "APPROVED" || status == "REJECTED"
	if decided {
		appSet := bson.D{}
		if status == "REJECTED" {
			appSet = append(appSet, bson.E{Key: "rejectionReason", Value: reason})
		}
		appSet = append(appSet, bson.E{Key: "reviewedAt", Value: now}, bson.E{Key: "reviewedBy", Value: actor}, bson.E{Key: "status", Value: status}, bson.E{Key: "updatedBy", Value: actor}, bson.E{Key: "updatedAt", Value: now})
		if _, err := p.DB.Collection("serviceproviderapplications").UpdateMany(c, bson.D{{Key: "providerId", Value: existing.ID}, {Key: "status", Value: "PENDING"}}, bson.D{{Key: "$set", Value: appSet}}); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	if err := p.Audit.Write(c, audit.Entry{Action: action, ActorID: actor, EntityID: row.ID.Hex(), EntityType: "ServiceProvider",
		Metadata: bson.D{{Key: "previousStatus", Value: existing.Status}, {Key: "status", Value: status}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	// HIDDEN is silent: hiding is moderation, not a decision the provider is owed an email about.
	if row.Email != "" && decided {
		var m email.Content
		if status == "APPROVED" {
			siteName := "HostelPalika"
			if cfg, err := p.Config.SiteConfig(c); err == nil {
				if v, ok := cfg.Get("identity"); ok {
					if id, ok := v.(ordered.Map); ok {
						if n, _ := id.Get("siteName"); n != nil && n != "" {
							siteName, _ = n.(string)
						}
					}
				}
			}
			m = email.ServiceProviderApproved(categoryLabel(row.Category), row.FullName, p.AppURL("/jobs"), siteName)
		} else {
			m = email.ServiceProviderRejected(row.FullName, reason)
		}
		p.Mail.Notify(c, email.Notification{Action: "service_provider_" + strings.ToLower(status), To: row.Email, Subject: m.Subject, HTML: m.HTML, Category: m.Category})
	}
	if status == "APPROVED" && row.UserID != nil && p.SendIDCard != nil {
		p.SendIDCard(c, *row.UserID, "SERVICE_PROVIDER")
	}
	if decided && row.UserID != nil {
		// What the app reads as a role change, so an approved provider's shell switches while they hold it.
		in := notifications.Input{ActionURL: "/service-providers", Category: "SERVICE_PROVIDER", Priority: "HIGH", UserID: row.UserID.Hex(),
			Body: "Your application wasn't approved. You can correct the details and send it again.", Title: "About your provider application",
			Data: ordered.Map{{Key: "providerId", Value: row.ID.Hex()}, {Key: "type", Value: "SERVICE_PROVIDER_REJECTED"}}}
		if status == "APPROVED" {
			in.ActionURL, in.Title = "/jobs", "You're an approved service provider"
			in.Body = "Your details and documents checked out. Jobs a hostel assigns you now arrive here."
			in.Data = ordered.Map{{Key: "providerId", Value: row.ID.Hex()}, {Key: "type", Value: "SERVICE_PROVIDER_APPROVED"}}
		} else if reason != "" {
			in.Body = "Your application wasn't approved: " + reason
		}
		_, _ = p.Notify.CreateInApp(c, in)
	}
	out, err := p.bundle(c, &row)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	msg := map[string]string{"APPROVED": "Service provider approved", "REJECTED": "Service provider rejected", "HIDDEN": "Service provider hidden"}[status]
	httpx.Write(c, 200, out, msg)
}
