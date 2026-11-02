package billing

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/plans"
)

// Limits is plan-limits.ts: how many residents, wardens and cooks a plan pays for.
type Limits struct {
	DB     *mongo.Database
	Config *platformconfig.Service
	Notify *notifications.Service
}

func (l *Limits) countLive(ctx context.Context, hostel bson.ObjectID, seat string) (int64, error) {
	switch seat {
	case "residents":
		return l.DB.Collection("residents").CountDocuments(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: false}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "MOVED_OUT"}}}})
	case "wardens":
		return l.DB.Collection("hostelmembers").CountDocuments(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "role", Value: "WARDEN"}, {Key: "status", Value: "ACTIVE"}})
	}
	return l.DB.Collection("cookaccounts").CountDocuments(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "INVITED"}}}}})
}

// AssertRoom is assertPlanRoom. seat is residents, wardens or cooks. A branch counts
// its own seats against its main hostel's plan; no plan means no cap.
func (l *Limits) AssertRoom(ctx context.Context, hostel bson.ObjectID, seat string, adding int64) error {
	billed, err := BillingHostelID(ctx, l.DB, hostel)
	if err != nil {
		return err
	}
	var sub struct {
		PlanID *string `bson:"planId"`
	}
	err = l.DB.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "hostelId", Value: billed}}, options.FindOne().SetProjection(bson.D{{Key: "planId", Value: 1}})).Decode(&sub)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil
	}
	if err != nil {
		return err
	}
	if sub.PlanID == nil || *sub.PlanID == "" {
		return nil
	}
	raw, err := l.Config.Section(ctx, "plans")
	if err != nil {
		return err
	}
	var catalog plans.Catalog
	if err := platformconfig.Decode(raw, &catalog); err != nil {
		return err
	}
	plan := plans.GetPlan(catalog, *sub.PlanID)
	if plan == nil {
		return nil
	}
	cap := plan.MaxResidents
	switch seat {
	case "wardens":
		cap = plan.PortalAccess.Wardens
	case "cooks":
		cap = plan.PortalAccess.Cooks
	}
	if cap == nil {
		return nil
	}
	live, err := l.countLive(ctx, hostel, seat)
	if err != nil {
		return err
	}
	if live+adding <= int64(*cap) {
		return nil
	}
	message := "Your " + plan.Name + " plan allows " + strconv.Itoa(*cap) + " " + seat + " and you have reached that limit. Please upgrade your plan to add more."
	l.notifyLimit(ctx, hostel, message)
	return httpx.NewError(http.StatusConflict, "PLAN_LIMIT_REACHED", message, nil)
}

// notifyLimit is best effort: the refusal is the answer either way.
func (l *Limits) notifyLimit(ctx context.Context, hostel bson.ObjectID, body string) {
	contacts, err := residents.HostelAdminContacts(ctx, l.DB, hostel)
	if err != nil || l.Notify == nil {
		return
	}
	var row struct {
		Slug string `bson:"slug"`
	}
	_ = l.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "slug", Value: 1}})).Decode(&row)
	for _, contact := range contacts {
		if contact.UserID == "" {
			continue
		}
		_, _ = l.Notify.CreateInApp(ctx, notifications.Input{Body: body, Category: "PAYMENT", Data: ordered.Map{{Key: "hostelSlug", Value: row.Slug}, {Key: "reason", Value: "PLAN_LIMIT"}, {Key: "type", Value: "PLAN_DUE"}},
			HostelID: hostel.Hex(), Priority: "HIGH", Title: "Plan limit reached", UserID: contact.UserID})
	}
}
