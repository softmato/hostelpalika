package billing

import (
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// hostelPlans is GET /platform/subscriptions/hostels (listHostelSubscriptions):
// every hostel's plan as it stands — what it is on, its state, and when the
// paid period, free months, trial or due date run out. The Subscriptions tab
// joins it to the hostel list by hostelId.
func (p *Platform) hostelPlans(c *gin.Context) {
	var rows []struct {
		HostelID         bson.ObjectID `bson:"hostelId"`
		PlanID           *string       `bson:"planId"`
		PlanName         *string       `bson:"planName"`
		Status           string        `bson:"status"`
		Cycle            *string       `bson:"cycle"`
		Lifetime         bool          `bson:"lifetime"`
		CurrentPeriodEnd *time.Time    `bson:"currentPeriodEnd"`
		DueBy            *time.Time    `bson:"dueBy"`
		FreeUntil        *time.Time    `bson:"freeUntil"`
		TrialEndsAt      *time.Time    `bson:"trialEndsAt"`
	}
	cur, err := p.db().Collection("hostelsubscriptions").Find(c, bson.D{}, options.Find().SetSort(bson.D{{Key: "_id", Value: 1}}))
	if err == nil {
		err = cur.All(c, &rows)
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]ordered.Map, 0, len(rows))
	for _, r := range rows {
		out = append(out, ordered.Map{
			{Key: "currentPeriodEnd", Value: isoNil(r.CurrentPeriodEnd)},
			{Key: "cycle", Value: orNil(r.Cycle)},
			{Key: "dueBy", Value: isoNil(r.DueBy)},
			{Key: "freeUntil", Value: isoNil(r.FreeUntil)},
			{Key: "hostelId", Value: r.HostelID.Hex()},
			{Key: "lifetime", Value: r.Lifetime},
			{Key: "planId", Value: orNil(r.PlanID)},
			{Key: "planName", Value: orNil(r.PlanName)},
			{Key: "status", Value: r.Status},
			{Key: "trialEndsAt", Value: isoNil(r.TrialEndsAt)},
		})
	}
	httpx.OK(c, ordered.Map{{Key: "subscriptions", Value: out}}, "Hostel plans loaded")
}
