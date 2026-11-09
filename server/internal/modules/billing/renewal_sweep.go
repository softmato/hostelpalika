package billing

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/plans"
)

const (
	renewAheadDays      = 7
	planOverdueDays     = 7 // PLAN_OVERDUE_DAYS
	suspensionGraceDays = 3 // SUSPENSION_GRACE_DAYS
)

// overdueSuspension is overdueSuspension: the automatic path of an unpaid plan.
func overdueSuspension(dueAt time.Time) bson.D {
	started := bs.DayEnd(dueAt, planOverdueDays)
	return bson.D{{Key: "graceEndsAt", Value: bs.DayEnd(started, suspensionGraceDays)}, {Key: "reason", Value: "PLAN_OVERDUE"}, {Key: "startedAt", Value: started}, {Key: "startedBy", Value: nil}}
}

// RaiseDueRenewals is raiseDueRenewals (inside the payment-reminders job): a
// live plan ending within a week gets its renewal bill; one already past its
// end turns PAST_DUE and the hostel and its branches start the suspension path.
func (s *Service) RaiseDueRenewals(ctx context.Context, now time.Time) (ordered.Map, error) {
	// An unpaid trial ends on the free tier now; lift any trial-end block left from before.
	if _, err := s.DB.Collection("hostels").UpdateMany(ctx, bson.D{{Key: "suspension.reason", Value: "TRIAL_ENDED"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "suspension.graceEndsAt", Value: nil}, {Key: "suspension.reason", Value: nil}, {Key: "suspension.startedAt", Value: nil}, {Key: "suspension.startedBy", Value: nil}}}}); err != nil {
		return nil, err
	}
	cur, err := s.DB.Collection("hostelsubscriptions").Find(ctx, bson.D{{Key: "currentPeriodEnd", Value: bson.D{{Key: "$lte", Value: bs.DayEnd(now, renewAheadDays)}, {Key: "$ne", Value: nil}}},
		{Key: "lifetimeSince", Value: nil}, {Key: "planId", Value: bson.D{{Key: "$ne", Value: nil}}}, {Key: "status", Value: "ACTIVE"}})
	if err != nil {
		return nil, err
	}
	var subs []struct {
		ID               bson.ObjectID `bson:"_id"`
		CurrentPeriodEnd time.Time     `bson:"currentPeriodEnd"`
		Cycle            *string       `bson:"cycle"`
		CycleMonths      *int          `bson:"cycleMonths"`
		CycleTotal       *int64        `bson:"cycleTotal"`
		FreeUntil        *time.Time    `bson:"freeUntil"`
		HostelID         bson.ObjectID `bson:"hostelId"`
		MonthlyRate      *float64      `bson:"monthlyRate"`
		PlanID           *string       `bson:"planId"`
		PlanName         *string       `bson:"planName"`
	}
	if err := cur.All(ctx, &subs); err != nil {
		return nil, err
	}
	failed, lapsed, raised := 0, 0, 0
	for _, sub := range subs {
		err := func() error {
			var h struct {
				IsDeleted bool   `bson:"isDeleted"`
				Name      string `bson:"name"`
				Slug      string `bson:"slug"`
				Status    string `bson:"status"`
			}
			if err := s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: sub.HostelID}}, options.FindOne().SetProjection(bson.D{{Key: "isDeleted", Value: 1}, {Key: "name", Value: 1}, {Key: "slug", Value: 1}, {Key: "status", Value: 1}})).Decode(&h); err != nil {
				if errors.Is(err, mongo.ErrNoDocuments) {
					return nil // no hostel: nothing to renew
				}
				return err
			}
			if h.IsDeleted || h.Status != "PUBLISHED" || sub.Cycle == nil {
				return nil
			}
			open, err := s.openPlanInvoice(ctx, sub.ID)
			if err != nil {
				return err
			}
			if open == nil {
				o := RenewalOptions{DueAt: &sub.CurrentPeriodEnd}
				if sub.FreeUntil != nil && sub.FreeUntil.Equal(sub.CurrentPeriodEnd) && sub.CycleTotal != nil && *sub.CycleTotal != 0 && sub.CycleMonths != nil && *sub.CycleMonths != 0 && sub.PlanName != nil && *sub.PlanName != "" {
					rate := 0.0
					if sub.MonthlyRate != nil {
						rate = *sub.MonthlyRate
					}
					o.Agreed = &Priced{Cycle: *sub.Cycle, CycleMonths: *sub.CycleMonths, CycleTotal: *sub.CycleTotal, MonthlyRate: rate, PlanID: *sub.PlanID, PlanName: *sub.PlanName}
				}
				inv, _, err := s.RaiseRenewalInvoice(ctx, sub.HostelID, RenewalIn{Cycle: plans.Cycle(*sub.Cycle), PlanID: *sub.PlanID}, nil, o)
				if err != nil {
					return err
				}
				s.onInvoiceIssued(ctx, inv, h.Name, h.Slug, true, false)
				open = inv
				raised++
			}
			if sub.CurrentPeriodEnd.Before(now) {
				due := sub.CurrentPeriodEnd
				if open.DueAt != nil {
					due = *open.DueAt
				}
				at := nowMS()
				if _, err := s.DB.Collection("hostelsubscriptions").UpdateOne(ctx, bson.D{{Key: "_id", Value: sub.ID}, {Key: "status", Value: "ACTIVE"}},
					bson.D{{Key: "$set", Value: bson.D{{Key: "dueBy", Value: due}, {Key: "status", Value: "PAST_DUE"}, {Key: "updatedAt", Value: at}}}}); err != nil {
					return err
				}
				set := bson.D{{Key: "$set", Value: bson.D{{Key: "suspension", Value: overdueSuspension(due)}, {Key: "updatedAt", Value: at}}}}
				if _, err := s.DB.Collection("hostels").UpdateOne(ctx, bson.D{{Key: "_id", Value: sub.HostelID}, {Key: "suspension.startedAt", Value: nil}}, set); err != nil {
					return err
				}
				if _, err := s.DB.Collection("hostels").UpdateMany(ctx, bson.D{{Key: "parentHostelId", Value: sub.HostelID}, {Key: "suspension.startedAt", Value: nil}}, set); err != nil {
					return err
				}
				lapsed++
			}
			return nil
		}()
		if err != nil {
			failed++
			slog.ErrorContext(ctx, "plan_renewal_sweep_failed", "subscriptionId", sub.ID.Hex(), "message", err.Error())
		}
	}
	return ordered.Map{{Key: "failed", Value: failed}, {Key: "lapsed", Value: lapsed}, {Key: "raised", Value: raised}}, nil
}
