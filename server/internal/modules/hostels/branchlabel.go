package hostels

import (
	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// branchLabelPatch is PATCH /hostel-admin/branches/:branchId: renames the short key
// ("Block B") a hostel in the owner's group goes by.
func (a *Admin) branchLabelPatch(c *gin.Context) {
	p := authz.From(c)
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	label, _ := f.Str("branchLabel", valid.S{Trim: true, Min: 1, Max: 40})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	if len(p.HostelIDs) == 0 || p.HostelIDs[0] == "" {
		httpx.Fail(c, openFirst())
		return
	}
	mainID, err := a.mainHostelOf(c, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	main, err := ResolveOwned(c, a.DB, mainID, p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	notFound := branchErr(404, "HOSTEL_NOT_FOUND", "Branch not found.")
	branchID, err := bson.ObjectIDFromHex(c.Param("branchId"))
	if err != nil {
		httpx.Fail(c, notFound)
		return
	}
	res, err := a.DB.Collection("hostels").UpdateOne(c,
		bson.D{{Key: "_id", Value: branchID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
			{Key: "$or", Value: bson.A{bson.D{{Key: "_id", Value: main.ID}}, bson.D{{Key: "parentHostelId", Value: main.ID}}}}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "branchLabel", Value: label}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if res.MatchedCount == 0 {
		httpx.Fail(c, notFound)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "branchLabel", Value: label}}, "Branch label saved")
}
