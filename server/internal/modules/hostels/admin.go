package hostels

import (
	"context"
	"errors"
	"regexp"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/modules/files"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Admin is the hostel owner's setup routes under /hostel-admin: community
// settings, payout account, KYC, profile and branches.
type Admin struct {
	DB      *mongo.Database
	Guards  *authz.Guards
	Audit   *audit.Log
	Mail    *email.Sender
	Notify  *notifications.Service
	Cache   *cache.Cache
	Billing *billing.Service
	// Outbound is outboundUrl(): where links in emails point.
	Outbound    string
	FinanceKey  string
	FinancePrev string
	PersonalKey string
	Config      *platformconfig.Service
	Claims      files.Claims
	// ShortStayLimits is the booking config: the minimum markup percent and the most nights.
	ShortStayLimits func(context.Context) (minMarkupPercent, maxNights float64)
}

func (a *Admin) Register(v1 *gin.RouterGroup) {
	g := v1.Group("/hostel-admin")
	admin := authz.Use(a.Guards.RequireHostelAdmin)
	g.GET("/settings/community", admin, httpx.ETag(), a.communityGet)
	g.PATCH("/settings/community", admin, a.communityPatch)
	g.GET("/payout-account", admin, httpx.ETag(), a.payoutGet)
	g.PUT("/payout-account", admin, a.payoutPut)
	g.GET("/branches", admin, httpx.ETag(), a.branchList)
	g.POST("/branches", admin, a.branchRequest)
	g.GET("/branches/summary", admin, httpx.ETag(), a.branchSummary)
	g.GET("/branches/names", authz.Use(a.Guards.RequireHostelStaff), httpx.ETag(), a.branchNames)
	g.GET("/branches/:branchId", admin, httpx.ETag(), a.branchDetails)
}

// AdminHostel is resolveAdminHostelId: the hostel asked for if the caller may open
// it, else their only one.
func AdminHostel(p *authz.Principal, requested string) (bson.ObjectID, error) {
	id := requested
	if id != "" {
		if err := authz.AssertHostelScoped(p, id); err != nil {
			return bson.ObjectID{}, err
		}
	} else {
		if len(p.HostelIDs) != 1 {
			return bson.ObjectID{}, httpx.NewError(422, "HOSTEL_SCOPE_REQUIRED", "A hostelId is required for this hostel admin action.", nil)
		}
		id = p.HostelIDs[0]
	}
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return oid, httpx.NewError(422, "INVALID_HOSTEL_ID", "Invalid hostel id.", nil)
	}
	return oid, nil
}

// optionalHostel is `typeof body.hostelId === "string" ? body.hostelId : undefined`.
func optionalHostel(body any) string {
	if m, ok := body.(map[string]any); ok {
		if s, ok := m["hostelId"].(string); ok {
			return s
		}
	}
	return ""
}

// ---- community settings ----

var hexID = regexp.MustCompile(`(?i)^[a-f\d]{24}$`)

type communityOut struct {
	Enabled                bool `json:"enabled"`
	ProfanityFilterEnabled bool `json:"profanityFilterEnabled"`
}

// communityHostel is the route's own resolveHostelId.
func communityHostel(p *authz.Principal, requested string) (string, error) {
	if requested != "" {
		return requested, authz.AssertHostelScoped(p, requested)
	}
	if len(p.HostelIDs) == 1 {
		return p.HostelIDs[0], nil
	}
	return "", httpx.NewError(422, "HOSTEL_SCOPE_REQUIRED", "A hostelId is required for this action.", nil)
}

// communitySettings is getCommunitySettings: never fails, defaults on a miss.
func (a *Admin) communitySettings(ctx context.Context, hostelID bson.ObjectID) communityOut {
	out := communityOut{true, true}
	var row struct {
		Community *struct {
			Enabled *bool `bson:"enabled"`
			Profane *bool `bson:"profanityFilterEnabled"`
		} `bson:"community"`
	}
	if a.DB.Collection("hostelsettings").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostelID}}).Decode(&row) != nil || row.Community == nil {
		return out
	}
	if row.Community.Enabled != nil {
		out.Enabled = *row.Community.Enabled
	}
	if row.Community.Profane != nil {
		out.ProfanityFilterEnabled = *row.Community.Profane
	}
	return out
}

type communityGetOut struct {
	HostelID string       `json:"hostelId"`
	Settings communityOut `json:"settings"`
}

func (a *Admin) communityGet(c *gin.Context) {
	p := authz.From(c)
	id, err := communityHostel(p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	oid, err := httpx.OID(id, "hostel id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, communityGetOut{id, a.communitySettings(c, oid)}, "Community settings loaded")
}

func (a *Admin) communityPatch(c *gin.Context) {
	p := authz.From(c)
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	enabled, hasEnabled := f.Bool("enabled", true, nil)
	requested, _ := f.Str("hostelId", valid.S{Opt: true, Re: hexID, ReSrc: `/^[a-f\d]{24}$/i`})
	profane, hasProfane := f.Bool("profanityFilterEnabled", true, nil)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := communityHostel(p, requested)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelID, err := httpx.OID(id, "hostel id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	next := a.communitySettings(c, hostelID)
	if hasEnabled {
		next.Enabled = enabled
	}
	if hasProfane {
		next.ProfanityFilterEnabled = profane
	}
	actor, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	_, err = a.DB.Collection("hostelsettings").UpdateOne(c, bson.D{{Key: "hostelId", Value: hostelID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "community", Value: bson.D{{Key: "enabled", Value: next.Enabled}, {Key: "profanityFilterEnabled", Value: next.ProfanityFilterEnabled}}},
			{Key: "updatedBy", Value: actor}, {Key: "updatedAt", Value: now}}},
			{Key: "$setOnInsert", Value: bson.D{{Key: "hostelId", Value: hostelID}, {Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}}, upsert)
	if err == nil {
		err = a.Audit.Write(c, audit.Entry{Action: "COMMUNITY_SETTINGS_UPDATED", ActorID: actor, EntityID: id, EntityType: "HostelSettings", HostelID: hostelID,
			Metadata: bson.D{{Key: "enabled", Value: next.Enabled}, {Key: "profanityFilterEnabled", Value: next.ProfanityFilterEnabled}}})
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, struct {
		Settings communityOut `json:"settings"`
	}{next}, "Community settings updated")
}

var errHostelMissing = httpx.NewError(404, "HOSTEL_NOT_FOUND", "Hostel not found.", nil)

func notFound(err error) bool { return errors.Is(err, mongo.ErrNoDocuments) }
