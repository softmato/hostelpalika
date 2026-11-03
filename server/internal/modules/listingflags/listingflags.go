// Package listingflags is /platform/listing-flags and the duplicate check behind
// POST /platform/hostels/:id/run-duplicate-check (listing-flag.service.ts).
package listingflags

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

type Handler struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Audit  *audit.Log
	Now    func() time.Time
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	staff := authz.Use(h.Guards.RequirePlatform)
	v1.GET("/platform/listing-flags", staff, httpx.ETag(), h.list)
	v1.PATCH("/platform/listing-flags/:id/resolve", staff, h.resolve)
}

func (h *Handler) now() time.Time { return h.Now().UTC().Truncate(time.Millisecond) }

type flag struct {
	ID         bson.ObjectID   `bson:"_id"`
	CreatedAt  *time.Time      `bson:"createdAt"`
	HostelID   bson.ObjectID   `bson:"hostelId"`
	Matched    []bson.ObjectID `bson:"matchedHostelIds"`
	Reason     string          `bson:"reason"`
	Note       *string         `bson:"resolutionNote"`
	ResolvedAt *time.Time      `bson:"resolvedAt"`
	ResolvedBy *bson.ObjectID  `bson:"resolvedBy"`
	Risk       string          `bson:"riskLevel"`
	Signals    []string        `bson:"signals"`
	Status     string          `bson:"status"`
	UpdatedAt  *time.Time      `bson:"updatedAt"`
}

func hexes(ids []bson.ObjectID) []string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = id.Hex()
	}
	return out
}

func strs(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// out is serializeFlag; an undefined date is left out, as JSON.stringify does.
func (f *flag) out() ordered.Map {
	m := ordered.Map{}
	if f.CreatedAt != nil {
		m = append(m, ordered.Pair{Key: "createdAt", Value: httpx.ISO(*f.CreatedAt)})
	}
	note := ""
	if f.Note != nil {
		note = *f.Note
	}
	m = append(m, ordered.Pair{Key: "hostelId", Value: f.HostelID.Hex()}, ordered.Pair{Key: "id", Value: f.ID.Hex()}, ordered.Pair{Key: "matchedHostelIds", Value: hexes(f.Matched)},
		ordered.Pair{Key: "reason", Value: f.Reason}, ordered.Pair{Key: "resolutionNote", Value: note})
	if f.ResolvedAt != nil {
		m = append(m, ordered.Pair{Key: "resolvedAt", Value: httpx.ISO(*f.ResolvedAt)})
	}
	if f.ResolvedBy != nil {
		m = append(m, ordered.Pair{Key: "resolvedBy", Value: f.ResolvedBy.Hex()})
	}
	m = append(m, ordered.Pair{Key: "riskLevel", Value: f.Risk}, ordered.Pair{Key: "signals", Value: strs(f.Signals)}, ordered.Pair{Key: "status", Value: f.Status})
	if f.UpdatedAt != nil {
		m = append(m, ordered.Pair{Key: "updatedAt", Value: httpx.ISO(*f.UpdatedAt)})
	}
	return m
}

// list is listListingFlags. Open flags first, then the riskiest: TS sorted the
// enum strings, which put DISMISSED before OPEN and MEDIUM before HIGH (P7-19).
func (h *Handler) list(c *gin.Context) {
	q := valid.Query(c)
	var is valid.Issues
	page := valid.Page(q, &is)
	risk := valid.QueryEnum(q, "riskLevel", &is, "LOW", "MEDIUM", "HIGH")
	status := valid.QueryEnum(q, "status", &is, "OPEN", "RESOLVED", "DISMISSED")
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	filter := bson.D{{Key: "isDeleted", Value: false}}
	if risk != nil {
		filter = append(filter, bson.E{Key: "riskLevel", Value: *risk})
	}
	if status != nil {
		filter = append(filter, bson.E{Key: "status", Value: *status})
	}
	r := pagination.RangeOf(page)
	rank := func(field string, order ...string) bson.D {
		branches := bson.A{}
		for i, v := range order {
			branches = append(branches, bson.D{{Key: "case", Value: bson.D{{Key: "$eq", Value: bson.A{"$" + field, v}}}}, {Key: "then", Value: i}})
		}
		return bson.D{{Key: "$switch", Value: bson.D{{Key: "branches", Value: branches}, {Key: "default", Value: len(order)}}}}
	}
	cur, err := h.DB.Collection("listingflags").Aggregate(c, bson.A{
		bson.D{{Key: "$match", Value: filter}},
		bson.D{{Key: "$addFields", Value: bson.D{{Key: "_statusRank", Value: rank("status", "OPEN", "RESOLVED", "DISMISSED")}, {Key: "_riskRank", Value: rank("riskLevel", "HIGH", "MEDIUM", "LOW")}}}},
		bson.D{{Key: "$sort", Value: bson.D{{Key: "_statusRank", Value: 1}, {Key: "_riskRank", Value: 1}, {Key: "createdAt", Value: -1}}}},
		bson.D{{Key: "$skip", Value: r.Skip}}, bson.D{{Key: "$limit", Value: r.Limit}},
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []flag
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	total, err := h.DB.Collection("listingflags").CountDocuments(c, filter)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]ordered.Map, len(rows))
	for i := range rows {
		out[i] = rows[i].out()
	}
	httpx.OK(c, ordered.Map{{Key: "flags", Value: out}, {Key: "pagination", Value: pagination.MetaOf(page, int(total))}}, "Listing flags loaded")
}

func (h *Handler) resolve(c *gin.Context) {
	p := authz.From(c)
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	note, _ := f.Str("resolutionNote", valid.S{Trim: true, Min: 2, Max: 800})
	status, _ := f.Enum("status", false, nil, "RESOLVED", "DISMISSED")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		httpx.Fail(c, httpx.NewError(http.StatusUnprocessableEntity, "INVALID_OBJECT_ID", "Invalid listing flag id.", nil))
		return
	}
	actor, _ := bson.ObjectIDFromHex(p.UserID)
	now := h.now()
	var row flag
	err = h.DB.Collection("listingflags").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "resolutionNote", Value: note}, {Key: "resolvedAt", Value: now}, {Key: "resolvedBy", Value: actor}, {Key: "status", Value: status}, {Key: "updatedBy", Value: actor}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, httpx.NewError(http.StatusNotFound, "LISTING_FLAG_NOT_FOUND", "Listing flag was not found.", nil))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.Audit.Write(c, audit.Entry{Action: "LISTING_FLAG_RESOLVED", ActorID: actor, EntityID: id.Hex(), EntityType: "ListingFlag", HostelID: row.HostelID, Metadata: bson.D{{Key: "status", Value: status}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "flag", Value: row.out()}}, "Listing flag resolved")
}

var spaces = regexp.MustCompile(`\s+`)

// DuplicateCheck is runDuplicateCheck: other live hostels sharing an address,
// phone, owner, or a similar name in the same area. A match raises a flag; a
// hostel with an open flag has it brought up to date rather than a second one
// raised beside it (P7-20: TS added a flag on every run).
func (h *Handler) DuplicateCheck(ctx context.Context, hostelID bson.ObjectID, actorID string) (any, error) {
	var host struct {
		Contact struct {
			Phone string `bson:"phone"`
		} `bson:"contact"`
		Location struct {
			Address string `bson:"address"`
			Area    string `bson:"area"`
		} `bson:"location"`
		Name    string         `bson:"name"`
		OwnerID *bson.ObjectID `bson:"ownerId"`
	}
	if err := h.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostelID}, {Key: "isDeleted", Value: false}}).Decode(&host); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			err = httpx.NewError(http.StatusNotFound, "HOSTEL_NOT_FOUND", "Hostel was not found.", nil)
		}
		return nil, err
	}
	var signals []string
	or := bson.A{}
	if host.Location.Address != "" {
		or = append(or, bson.D{{Key: "location.address", Value: bson.Regex{Pattern: regexp.QuoteMeta(host.Location.Address), Options: "i"}}})
		signals = append(signals, "same_address")
	}
	if host.Contact.Phone != "" {
		or = append(or, bson.D{{Key: "contact.phone", Value: host.Contact.Phone}})
		signals = append(signals, "same_phone")
	}
	if host.OwnerID != nil {
		or = append(or, bson.D{{Key: "ownerId", Value: *host.OwnerID}})
		signals = append(signals, "same_owner")
	}
	if host.Name != "" && host.Location.Area != "" {
		words := spaces.Split(host.Name, -1)
		if len(words) > 2 {
			words = words[:2]
		}
		if prefix := strings.Join(words, " "); len([]rune(prefix)) >= 3 {
			or = append(or, bson.D{{Key: "location.area", Value: bson.Regex{Pattern: regexp.QuoteMeta(host.Location.Area), Options: "i"}},
				{Key: "name", Value: bson.Regex{Pattern: regexp.QuoteMeta(prefix), Options: "i"}}})
			signals = append(signals, "similar_name_same_area")
		}
	}
	matched := []bson.ObjectID{}
	if len(or) > 0 {
		cur, err := h.DB.Collection("hostels").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$ne", Value: hostelID}}}, {Key: "isDeleted", Value: false}, {Key: "$or", Value: or}},
			options.Find().SetLimit(10).SetProjection(bson.D{{Key: "_id", Value: 1}}))
		if err != nil {
			return nil, err
		}
		var rows []struct {
			ID bson.ObjectID `bson:"_id"`
		}
		if err := cur.All(ctx, &rows); err != nil {
			return nil, err
		}
		for _, r := range rows {
			matched = append(matched, r.ID)
		}
	}
	if len(matched) == 0 {
		signals = []string{}
	}
	risk := "LOW"
	for _, s := range signals {
		if s == "same_phone" || s == "same_owner" {
			risk = "HIGH"
		}
	}
	if risk == "LOW" && len(matched) > 0 {
		risk = "MEDIUM"
	}
	actor, _ := bson.ObjectIDFromHex(actorID)
	now := h.now()
	var fl *flag
	if len(matched) > 0 {
		var row flag
		err := h.DB.Collection("listingflags").FindOneAndUpdate(ctx, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "OPEN"}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "matchedHostelIds", Value: matched}, {Key: "reason", Value: "Possible duplicate or ghost listing detected."}, {Key: "riskLevel", Value: risk},
				{Key: "signals", Value: signals}, {Key: "updatedBy", Value: actor}, {Key: "updatedAt", Value: now}}},
				{Key: "$setOnInsert", Value: bson.D{{Key: "createdBy", Value: actor}, {Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}},
			options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&row)
		if err != nil {
			return nil, err
		}
		fl = &row
		if err := h.Audit.Write(ctx, audit.Entry{Action: "LISTING_DUPLICATE_FLAG_CREATED", ActorID: actor, EntityID: row.ID.Hex(), EntityType: "ListingFlag", HostelID: hostelID,
			Metadata: bson.D{{Key: "matchedHostelIds", Value: hexes(matched)}, {Key: "riskLevel", Value: risk}}}); err != nil {
			return nil, err
		}
	}
	resultID := bson.NewObjectID()
	doc := bson.D{{Key: "_id", Value: resultID}, {Key: "hostelId", Value: hostelID}, {Key: "checkedBy", Value: actor}, {Key: "matchedHostelIds", Value: matched}, {Key: "signals", Value: signals}, {Key: "riskLevel", Value: risk}}
	if fl != nil {
		doc = append(doc, bson.E{Key: "flagId", Value: fl.ID})
	}
	doc = append(doc, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := h.DB.Collection("duplicatecheckresults").InsertOne(ctx, doc); err != nil {
		return nil, err
	}
	result := ordered.Map{{Key: "checkedBy", Value: actor.Hex()}, {Key: "createdAt", Value: httpx.ISO(now)}}
	if fl != nil {
		result = append(result, ordered.Pair{Key: "flagId", Value: fl.ID.Hex()})
	}
	result = append(result, ordered.Pair{Key: "hostelId", Value: hostelID.Hex()}, ordered.Pair{Key: "id", Value: resultID.Hex()}, ordered.Pair{Key: "matchedHostelIds", Value: hexes(matched)},
		ordered.Pair{Key: "riskLevel", Value: risk}, ordered.Pair{Key: "signals", Value: signals})
	var flagOut any
	if fl != nil {
		flagOut = fl.out()
	}
	return ordered.Map{{Key: "flag", Value: flagOut}, {Key: "result", Value: result}}, nil
}
