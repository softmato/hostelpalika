package hostelreferrals

import (
	"context"
	"math"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

type referralRow struct {
	ID                bson.ObjectID  `bson:"_id"`
	Code              string         `bson:"code"`
	Kind              string         `bson:"kind"`
	RefereeHostelID   bson.ObjectID  `bson:"refereeHostelId"`
	ReferrerHostelID  *bson.ObjectID `bson:"referrerHostelId"`
	RefereeReward     PlanBonus      `bson:"refereeReward"`
	ReferrerReward    PlanBonus      `bson:"referrerReward"`
	RefereeAppliedAt  *time.Time     `bson:"refereeAppliedAt"`
	ReferrerAppliedAt *time.Time     `bson:"referrerAppliedAt"`
	Commission        struct {
		Type  string  `bson:"type"`
		Value float64 `bson:"value"`
	} `bson:"commission"`
}

func hasBonus(b PlanBonus) bool { return b.Months > 0 || b.Days > 0 }

// ExtendByBonus is extendByBonus: whole BS months from the day after end, then days.
func ExtendByBonus(end time.Time, b PlanBonus) (time.Time, error) {
	after := end
	if b.Months > 0 {
		var err error
		if after, err = bs.MonthsEnd(end.Add(time.Millisecond), b.Months); err != nil {
			return time.Time{}, err
		}
	}
	return after.Add(time.Duration(b.Days) * 24 * time.Hour), nil
}

// commissionFor is the rules file's: a flat amount, or a percent of the cycle.
func commissionFor(kind string, value float64, cycleTotal float64) int64 {
	if kind == "AMOUNT" {
		return int64(math.Max(0, math.Round(value)))
	}
	return int64(math.Max(0, math.Round(cycleTotal*value/100)))
}

// GoLive is settleHostelReferrals: runs each time a hostel goes live or pays
// its plan in full. Marks its own referral live (commission, the referrer's
// bell) and adds any time still owed to it on either side. Idempotent; the
// caller logs a failure and carries on, as the settlement must not fail on it.
func (s *Service) GoLive(ctx context.Context, hostelID bson.ObjectID, notify *notifications.Service, log *audit.Log, now time.Time) error {
	coll := s.db.Collection("hostelreferrals")
	var justLive referralRow
	err := coll.FindOneAndUpdate(ctx, bson.D{{Key: "refereeHostelId", Value: hostelID}, {Key: "status", Value: "PENDING"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "liveAt", Value: now}, {Key: "status", Value: "LIVE"}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&justLive)
	live := err == nil
	if err != nil && err != mongo.ErrNoDocuments {
		return err
	}
	if live {
		if err := s.onLive(ctx, &justLive, notify, now); err != nil {
			return err
		}
	}
	or := bson.A{
		bson.D{{Key: "refereeAppliedAt", Value: nil}, {Key: "refereeHostelId", Value: hostelID}},
		bson.D{{Key: "referrerAppliedAt", Value: nil}, {Key: "referrerHostelId", Value: hostelID}},
	}
	if live {
		or = append(or, bson.D{{Key: "_id", Value: justLive.ID}})
	}
	// A hostel is party to a handful of referrals at most.
	cur, err := coll.Find(ctx, bson.D{{Key: "$or", Value: or}, {Key: "status", Value: "LIVE"}}, options.Find().SetLimit(500))
	if err != nil {
		return err
	}
	var owed []referralRow
	if err := cur.All(ctx, &owed); err != nil {
		return err
	}
	for i := range owed {
		row := &owed[i]
		if row.RefereeAppliedAt == nil {
			if err := s.applySide(ctx, row, "referee", log, now); err != nil {
				return err
			}
		}
		if row.ReferrerHostelID != nil && row.ReferrerAppliedAt == nil {
			if err := s.applySide(ctx, row, "referrer", log, now); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Service) onLive(ctx context.Context, row *referralRow, notify *notifications.Service, now time.Time) error {
	if row.Kind == "PARTNER" && row.Commission.Value > 0 {
		var sub struct {
			CycleTotal *float64 `bson:"cycleTotal"`
		}
		err := s.db.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "hostelId", Value: row.RefereeHostelID}},
			options.FindOne().SetProjection(bson.D{{Key: "cycleTotal", Value: 1}})).Decode(&sub)
		if err != nil && err != mongo.ErrNoDocuments {
			return err
		}
		total := 0.0
		if sub.CycleTotal != nil {
			total = *sub.CycleTotal
		}
		if amount := commissionFor(row.Commission.Type, row.Commission.Value, total); amount > 0 {
			if _, err := s.db.Collection("hostelreferrals").UpdateOne(ctx, bson.D{{Key: "_id", Value: row.ID}},
				bson.D{{Key: "$set", Value: bson.D{{Key: "commission.amount", Value: amount}, {Key: "commission.status", Value: "EARNED"}, {Key: "updatedAt", Value: now}}}}); err != nil {
				return err
			}
		}
	}
	if row.ReferrerHostelID == nil {
		return nil
	}
	hostels := s.db.Collection("hostels")
	var referee struct {
		Name string `bson:"name"`
	}
	var referrer struct {
		OwnerID *bson.ObjectID `bson:"ownerId"`
	}
	if err := hostels.FindOne(ctx, bson.D{{Key: "_id", Value: row.RefereeHostelID}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}})).Decode(&referee); err != nil && err != mongo.ErrNoDocuments {
		return err
	}
	if err := hostels.FindOne(ctx, bson.D{{Key: "_id", Value: *row.ReferrerHostelID}}, options.FindOne().SetProjection(bson.D{{Key: "ownerId", Value: 1}})).Decode(&referrer); err != nil && err != mongo.ErrNoDocuments {
		return err
	}
	if referrer.OwnerID == nil || notify == nil {
		return nil
	}
	name := referee.Name
	if name == "" {
		name = "A hostel"
	}
	body := name + " went live with your referral code."
	if b := Describe(row.ReferrerReward); b != "" {
		body += " " + b + " is added to your plan."
	}
	// .catch(() => {}) in TS: the bell never fails the go-live.
	_, _ = notify.CreateInApp(ctx, notifications.Input{Body: body, Category: "billing", Data: ordered.Map{{Key: "type", Value: "HOSTEL_REFERRAL_LIVE"}},
		HostelID: row.ReferrerHostelID.Hex(), Title: "A hostel joined with your code", UserID: referrer.OwnerID.Hex()})
	return nil
}

// applySide claims a side, adds its time, and hands the claim back if the time
// could not go on yet.
func (s *Service) applySide(ctx context.Context, row *referralRow, side string, log *audit.Log, now time.Time) error {
	field, hostel, reward := "refereeAppliedAt", row.RefereeHostelID, row.RefereeReward
	if side == "referrer" {
		field, hostel, reward = "referrerAppliedAt", *row.ReferrerHostelID, row.ReferrerReward
	}
	coll := s.db.Collection("hostelreferrals")
	claim, err := coll.UpdateOne(ctx, bson.D{{Key: "_id", Value: row.ID}, {Key: field, Value: nil}},
		bson.D{{Key: "$set", Value: bson.D{{Key: field, Value: now}, {Key: "updatedAt", Value: now}}}})
	if err != nil || claim.ModifiedCount == 0 || !hasBonus(reward) {
		return err
	}
	added, err := s.addPlanBonus(ctx, hostel, reward, "referral:"+row.Code+":"+side, log, now)
	if !added {
		// Hand the claim back so the next go-live or payment retries it. TS kept
		// the claim when the read before the write threw, losing the time for good.
		if _, uerr := coll.UpdateOne(ctx, bson.D{{Key: "_id", Value: row.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: field, Value: nil}}}}); uerr != nil && err == nil {
			err = uerr
		}
	}
	return err
}

// addPlanBonus adds extra time to a running plan; false when it cannot yet (no
// running period, a lifetime plan, or an open plan bill whose printed period
// would then read as already paid).
func (s *Service) addPlanBonus(ctx context.Context, hostel bson.ObjectID, b PlanBonus, reason string, log *audit.Log, now time.Time) (bool, error) {
	subs := s.db.Collection("hostelsubscriptions")
	var sub struct {
		ID               bson.ObjectID `bson:"_id"`
		CurrentPeriodEnd *time.Time    `bson:"currentPeriodEnd"`
		FreeUntil        *time.Time    `bson:"freeUntil"`
		LifetimeSince    *time.Time    `bson:"lifetimeSince"`
		Status           string        `bson:"status"`
	}
	err := subs.FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}).Decode(&sub)
	if err == mongo.ErrNoDocuments {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if sub.CurrentPeriodEnd == nil || sub.Status != "ACTIVE" || sub.LifetimeSince != nil {
		return false, nil
	}
	n, err := s.db.Collection("subscriptioninvoices").CountDocuments(ctx, bson.D{{Key: "kind", Value: bson.D{{Key: "$ne", Value: "SETUP_FEE"}}},
		{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"OPEN", "PARTIAL"}}}}, {Key: "subscriptionId", Value: sub.ID}}, options.Count().SetLimit(1))
	if err != nil || n > 0 {
		return false, err
	}
	end, err := ExtendByBonus(*sub.CurrentPeriodEnd, b)
	if err != nil {
		return false, err
	}
	set := bson.D{{Key: "currentPeriodEnd", Value: end}}
	// Keeps the first bill after free months at the price agreed at sign-up.
	if sub.FreeUntil != nil && sub.FreeUntil.Equal(*sub.CurrentPeriodEnd) {
		set = append(set, bson.E{Key: "freeUntil", Value: end})
	}
	set = append(set, bson.E{Key: "updatedAt", Value: now})
	res, err := subs.UpdateOne(ctx, bson.D{{Key: "_id", Value: sub.ID}, {Key: "currentPeriodEnd", Value: *sub.CurrentPeriodEnd}}, bson.D{{Key: "$set", Value: set}})
	if err != nil || res.ModifiedCount == 0 {
		return false, err
	}
	iso := func(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
	err = log.Write(ctx, audit.Entry{ActorType: "SYSTEM", Action: "SUBSCRIPTION_REFERRAL_BONUS_ADDED", EntityType: "HostelSubscription", EntityID: sub.ID.Hex(), HostelID: hostel,
		Metadata: bson.D{{Key: "days", Value: b.Days}, {Key: "months", Value: b.Months}, {Key: "from", Value: iso(*sub.CurrentPeriodEnd)}, {Key: "reason", Value: reason}, {Key: "to", Value: iso(end)}}})
	return true, err
}
