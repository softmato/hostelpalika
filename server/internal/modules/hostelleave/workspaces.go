package hostelleave

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/hostels"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/plans"
)

// workspaces is GET /account/workspaces (listWorkspaces): the hostels this
// session may open a web portal workspace for, main hostels first, then the
// token's order (a claim-back re-grants branches before their main). Suspended
// ones are listed too — their portal says so rather than 404ing. With `slug`,
// `held` says whether that address is this account's own held hostel, which the
// portal answers with the claim-back home instead of a 404. PARITY §9: the web
// portal layout reads this instead of the database.
func (h *Handler) workspaces(c *gin.Context) {
	p, err := h.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	ids := p.AllHostelIDs
	if ids == nil {
		ids = p.HostelIDs
	}
	var oids []bson.ObjectID
	order := map[string]int{}
	for _, id := range append(slices.Clone(ids), p.SuspendedHostelIDs...) {
		if _, seen := order[id]; seen {
			continue
		}
		if oid, err := bson.ObjectIDFromHex(id); err == nil {
			order[id] = len(oids)
			oids = append(oids, oid)
		}
	}
	type row struct {
		ID     bson.ObjectID  `bson:"_id"`
		Name   string         `bson:"name"`
		Parent *bson.ObjectID `bson:"parentHostelId"`
		Photos bson.Raw       `bson:"photos"`
		Slug   string         `bson:"slug"`
	}
	var rows []row
	if len(oids) > 0 {
		cur, err := h.DB.Collection("hostels").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: oids}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
			options.Find().SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "parentHostelId", Value: 1}, {Key: "photos.kind", Value: 1}, {Key: "photos.url", Value: 1}, {Key: "slug", Value: 1}}))
		if err == nil {
			err = cur.All(c, &rows)
		}
		if err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	slices.SortStableFunc(rows, func(a, b row) int {
		if (a.Parent != nil) != (b.Parent != nil) {
			if a.Parent == nil {
				return -1
			}
			return 1
		}
		return order[a.ID.Hex()] - order[b.ID.Hex()]
	})
	catalog := h.planCatalog(c)
	out := make([]any, 0, len(rows))
	slug := c.Query("slug")
	listed := false
	for _, r := range rows {
		billingID := r.ID
		if r.Parent != nil {
			billingID = *r.Parent
		}
		branchCap, err := h.branchCap(c, billingID, catalog)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var cover any
		if r.Photos != nil {
			if u := hostels.ExteriorPhoto(r.Photos); u != nil {
				cover = *u
			}
		}
		listed = listed || r.Slug == slug
		out = append(out, ordered.Map{{Key: "branchCap", Value: branchCap}, {Key: "coverUrl", Value: cover}, {Key: "id", Value: r.ID.Hex()},
			{Key: "isBranch", Value: r.Parent != nil}, {Key: "name", Value: r.Name}, {Key: "slug", Value: r.Slug}})
	}
	held := false
	if slug != "" && !listed {
		if held, err = h.heldAt(c, p.UserID, slug); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	httpx.OK(c, ordered.Map{{Key: "held", Value: held}, {Key: "hostels", Value: out}}, "Workspaces loaded")
}

func (h *Handler) planCatalog(ctx context.Context) plans.Catalog {
	var catalog plans.Catalog
	if h.Config != nil {
		if raw, err := h.Config.Section(ctx, "plans"); err == nil {
			_ = platformconfig.Decode(raw, &catalog)
		}
	}
	return catalog
}

// branchCap is planBranchCap: branches the billing hostel's plan includes — 0 on every plan but Max.
func (h *Handler) branchCap(ctx context.Context, billingID bson.ObjectID, catalog plans.Catalog) (int, error) {
	var sub struct {
		PlanID *string `bson:"planId"`
	}
	err := h.DB.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "hostelId", Value: billingID}}, options.FindOne().SetProjection(bson.D{{Key: "planId", Value: 1}})).Decode(&sub)
	if errors.Is(err, mongo.ErrNoDocuments) || (err == nil && (sub.PlanID == nil || *sub.PlanID == "")) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if plan := plans.GetPlan(catalog, *sub.PlanID); plan != nil {
		return plan.MaxBranches, nil
	}
	return 0, nil
}

// heldAt is heldHostelForSlug != null: a deleted hostel at this address whose
// leave request this account may still claim back.
func (h *Handler) heldAt(ctx context.Context, userID, slug string) (bool, error) {
	var hostel struct {
		ID bson.ObjectID `bson:"_id"`
	}
	err := h.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "isDeleted", Value: true}, {Key: "slug", Value: slug}}, options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Decode(&hostel)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	ids, err := h.identities(ctx, userID)
	if err != nil {
		return false, err
	}
	rows, err := h.claimable(ctx, ids, time.Now())
	if err != nil {
		return false, err
	}
	return slices.ContainsFunc(rows, func(r request) bool { return r.HostelID == hostel.ID }), nil
}
