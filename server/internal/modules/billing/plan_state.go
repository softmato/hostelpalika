package billing

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/plans"
)

type capsSubscription struct {
	CurrentPeriodEnd *time.Time `bson:"currentPeriodEnd"`
	LifetimeSince    *time.Time `bson:"lifetimeSince"`
	PlanID           *string    `bson:"planId"`
	TrialEndsAt      *time.Time `bson:"trialEndsAt"`
}

var subFields = bson.D{{Key: "planId", Value: 1}, {Key: "trialEndsAt", Value: 1}, {Key: "currentPeriodEnd", Value: 1}, {Key: "lifetimeSince", Value: 1}}

var seats = []string{"residents", "wardens", "cooks"}

// planOn is planState's answer: kind is none, trial, paid or free; caps is nil
// when nothing holds, and a seat's nil cap is "no ceiling".
type planOn struct {
	kind string
	name string
	caps map[string]*int
}

// planState is planState: a live paid plan holds its caps, a running trial has
// none, a hostel from before trials with no plan has none, and every other
// hostel — trial over unpaid, period lapsed, plan chosen but never paid — is Free.
func planState(c plans.Catalog, sub *capsSubscription, now time.Time) planOn {
	if sub == nil {
		return planOn{kind: "none"}
	}
	hasPlan := sub.PlanID != nil && *sub.PlanID != ""
	if hasPlan && (sub.LifetimeSince != nil || (sub.CurrentPeriodEnd != nil && sub.CurrentPeriodEnd.After(now))) {
		p := plans.GetPlan(c, *sub.PlanID)
		if p == nil {
			return planOn{kind: "paid"}
		}
		return planOn{kind: "paid", name: p.Name, caps: map[string]*int{"residents": p.MaxResidents, "wardens": p.PortalAccess.Wardens, "cooks": p.PortalAccess.Cooks}}
	}
	if sub.TrialEndsAt != nil && sub.TrialEndsAt.After(now) {
		return planOn{kind: "trial"}
	}
	if !hasPlan && sub.TrialEndsAt == nil {
		return planOn{kind: "none"}
	}
	f := c.Free
	return planOn{kind: "free", name: f.Name, caps: map[string]*int{"residents": &f.MaxResidents, "wardens": &f.PortalAccess.Wardens, "cooks": &f.PortalAccess.Cooks}}
}

// seatsOver is seatsOver: the seats past their cap.
func seatsOver(on planOn, used map[string]int64) []string {
	var over []string
	for _, seat := range seats {
		if cap := on.caps[seat]; cap != nil && used[seat] > int64(*cap) {
			over = append(over, seat)
		}
	}
	return over
}

func (l *Limits) subscription(ctx context.Context, hostel bson.ObjectID) (*capsSubscription, error) {
	billed, err := BillingHostelID(ctx, l.DB, hostel)
	if err != nil {
		return nil, err
	}
	var sub capsSubscription
	err = l.DB.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "hostelId", Value: billed}}, options.FindOne().SetProjection(subFields)).Decode(&sub)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &sub, nil
}

func (l *Limits) catalog(ctx context.Context) (plans.Catalog, error) {
	var catalog plans.Catalog
	raw, err := l.Config.Section(ctx, "plans")
	if err != nil {
		return catalog, err
	}
	err = platformconfig.Decode(raw, &catalog)
	return catalog, err
}

// PlanLimit is Hostel.planLimit: a free-tier hostel over its caps since, and read-only from.
type PlanLimit struct {
	OverSince    time.Time `bson:"overSince"`
	ReadOnlyFrom time.Time `bson:"readOnlyFrom"`
}

type refreshed struct {
	on    planOn
	sub   *capsSubscription
	used  map[string]int64
	limit *PlanLimit
}

// Refresh is refreshPlanLimit: stamps Hostel.planLimit the first time a free-tier
// hostel is seen over its caps and clears it once it is back within them.
func (l *Limits) Refresh(ctx context.Context, hostel bson.ObjectID, now time.Time) (refreshed, error) {
	var out refreshed
	sub, err := l.subscription(ctx, hostel)
	if err != nil {
		return out, err
	}
	catalog, err := l.catalog(ctx)
	if err != nil {
		return out, err
	}
	out.sub, out.on, out.used = sub, planState(catalog, sub, now), map[string]int64{}
	for _, seat := range seats {
		if out.used[seat], err = l.countLive(ctx, hostel, seat); err != nil {
			return out, err
		}
	}
	var row struct {
		PlanLimit *PlanLimit `bson:"planLimit"`
	}
	err = l.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "planLimit", Value: 1}})).Decode(&row)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return out, err
	}
	if row.PlanLimit != nil && !row.PlanLimit.OverSince.IsZero() {
		out.limit = row.PlanLimit
	}
	hostels := l.DB.Collection("hostels")
	over := out.on.kind == "free" && len(seatsOver(out.on, out.used)) > 0
	switch {
	case over && out.limit == nil:
		out.limit = &PlanLimit{OverSince: now, ReadOnlyFrom: bs.DayEnd(now, catalog.Free.OverLimitGraceDays)}
		_, err = hostels.UpdateOne(ctx, bson.D{{Key: "_id", Value: hostel}}, bson.D{{Key: "$set", Value: bson.D{{Key: "planLimit",
			Value: bson.D{{Key: "overSince", Value: out.limit.OverSince}, {Key: "readOnlyFrom", Value: out.limit.ReadOnlyFrom}}}}}})
	case !over && out.limit != nil:
		out.limit = nil
		_, err = hostels.UpdateOne(ctx, bson.D{{Key: "_id", Value: hostel}}, bson.D{{Key: "$unset", Value: bson.D{{Key: "planLimit", Value: 1}}}})
	}
	return out, err
}

// ReadOnly is the gate's re-check (authz.Guards.PlanLimitRecheck): still past its
// grace after a refresh, so paying or moving residents out lifts it at once.
func (l *Limits) ReadOnly(ctx context.Context, hostel bson.ObjectID) (bool, error) {
	now := time.Now()
	r, err := l.Refresh(ctx, hostel, now)
	if err != nil {
		return false, err
	}
	return r.limit != nil && !now.Before(r.limit.ReadOnlyFrom), nil
}

// Usage is getPlanUsage, for GET /hostel-admin/billing/usage.
func (l *Limits) Usage(ctx context.Context, hostel bson.ObjectID, now time.Time) (ordered.Map, error) {
	r, err := l.Refresh(ctx, hostel, now)
	if err != nil {
		return nil, err
	}
	capOf := func(seat string) any {
		if c := r.on.caps[seat]; c != nil {
			return *c
		}
		return nil
	}
	var name, overSince, readOnlyFrom, trialEndsAt any
	if r.on.caps != nil {
		name = r.on.name
	}
	if r.limit != nil {
		overSince, readOnlyFrom = httpx.ISO(r.limit.OverSince), httpx.ISO(r.limit.ReadOnlyFrom)
	}
	if r.sub != nil && r.sub.TrialEndsAt != nil {
		trialEndsAt = httpx.ISO(*r.sub.TrialEndsAt)
	}
	return ordered.Map{
		{Key: "state", Value: r.on.kind},
		{Key: "planName", Value: name},
		{Key: "caps", Value: ordered.Map{{Key: "residents", Value: capOf("residents")}, {Key: "wardens", Value: capOf("wardens")}, {Key: "cooks", Value: capOf("cooks")}}},
		{Key: "used", Value: ordered.Map{{Key: "residents", Value: r.used["residents"]}, {Key: "wardens", Value: r.used["wardens"]}, {Key: "cooks", Value: r.used["cooks"]}}},
		{Key: "overLimit", Value: r.limit != nil},
		{Key: "overSince", Value: overSince},
		{Key: "readOnlyFrom", Value: readOnlyFrom},
		{Key: "readOnly", Value: r.limit != nil && !now.Before(r.limit.ReadOnlyFrom)},
		{Key: "trialEndsAt", Value: trialEndsAt},
	}, nil
}

// RefreshAll starts or clears every hostel's over-limit clock (the daily sweep).
// Branches count their own seats.
// ponytail: unpaged, one hostel at a time; page by _id at thousands.
func (l *Limits) RefreshAll(ctx context.Context, now time.Time) error {
	var ids []bson.ObjectID
	collect := func(coll string, filter bson.D, field string) error {
		cur, err := l.DB.Collection(coll).Find(ctx, filter, options.Find().SetProjection(bson.D{{Key: field, Value: 1}}))
		if err != nil {
			return err
		}
		var rows []bson.M
		if err := cur.All(ctx, &rows); err != nil {
			return err
		}
		for _, r := range rows {
			if id, ok := r[field].(bson.ObjectID); ok {
				ids = append(ids, id)
			}
		}
		return nil
	}
	if err := collect("hostelsubscriptions", bson.D{}, "hostelId"); err != nil {
		return err
	}
	if err := collect("hostels", bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "parentHostelId", Value: bson.D{{Key: "$ne", Value: nil}}}}, "_id"); err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := l.Refresh(ctx, id, now); err != nil {
			slog.ErrorContext(ctx, "plan_limit_refresh_failed", "hostelId", id.Hex(), "message", err.Error())
		}
	}
	return nil
}
