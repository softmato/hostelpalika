package noticepushes

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

var errNoAutomatic = errors.New("noticepushes: automatic pushes not wired")

// Reached is one automatic run's tally, shown on its schedule row.
type Reached struct{ Devices, Recipients int }

// AutomaticRun delivers one automatic row (PLAN_DUE_*, FEE_DUE_*, FREE_MONTH_*);
// filled in by the router, since billing and finance sit above this package.
type AutomaticRun func(ctx context.Context, key string, now time.Time) (Reached, error)

// DispatchDue is dispatchDuePlatformPushes: superadmin pushes whose time has
// come. The claim moves nextRunAt on (filtered on its old value) before the
// send, and a repeating run stale past the grace is skipped, not sent late.
func (p *Platform) DispatchDue(ctx context.Context, now time.Time) (ordered.Map, error) {
	if err := p.ensureAutomatic(ctx); err != nil {
		return nil, err
	}
	cur, err := p.schedules().Find(ctx, bson.D{{Key: "nextRunAt", Value: bson.D{{Key: "$lte", Value: now}}}, {Key: "status", Value: "ACTIVE"}},
		options.Find().SetSort(bson.D{{Key: "nextRunAt", Value: 1}}).SetLimit(20))
	if err != nil {
		return nil, err
	}
	var due []scheduleRow
	if err := cur.All(ctx, &due); err != nil {
		return nil, err
	}
	sent, skipped, failed := 0, 0, 0
	for _, s := range due {
		ends := ""
		if s.EndsOn != nil {
			ends = *s.EndsOn
		}
		var following any
		status := "COMPLETED"
		if next, ok := nextOccurrence(s.Repeat, s.StartsOn, ends, s.Time, s.Weekdays, now); ok {
			following, status = next, "ACTIVE"
		}
		stale := s.Repeat != "ONCE" && now.Sub(*s.NextRunAt) > repeatGrace
		at := time.Now().UTC().Truncate(time.Millisecond)
		res, err := p.schedules().UpdateOne(ctx, bson.D{{Key: "_id", Value: s.ID}, {Key: "nextRunAt", Value: *s.NextRunAt}, {Key: "status", Value: "ACTIVE"}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "nextRunAt", Value: following}, {Key: "status", Value: status}, {Key: "updatedAt", Value: at}}}})
		if err != nil {
			return nil, err
		}
		if res.ModifiedCount == 0 {
			continue
		}
		if stale {
			skipped++
			continue
		}
		var reached Reached
		if s.Automatic != nil {
			if p.Automatic == nil {
				err = errNoAutomatic
			} else {
				reached, err = p.Automatic(ctx, *s.Automatic, now)
			}
		} else {
			var actor bson.ObjectID
			if s.CreatedBy != nil {
				actor = *s.CreatedBy
			}
			var log ordered.Map
			log, err = p.deliver(ctx, message{s.Audience, s.Body, s.Title, s.Urgency}, actor, s.ID.Hex())
			if err == nil {
				d, _ := log.Get("devices")
				r, _ := log.Get("recipients")
				reached.Devices, _ = d.(int)
				reached.Recipients, _ = r.(int)
			}
		}
		if err != nil {
			failed++
			slog.ErrorContext(ctx, "[platform-push] scheduled send failed", "scheduleId", s.ID.Hex(), "error", err)
			continue
		}
		if _, err := p.schedules().UpdateByID(ctx, s.ID, bson.D{{Key: "$inc", Value: bson.D{{Key: "runCount", Value: 1}}},
			{Key: "$set", Value: bson.D{{Key: "lastDevices", Value: reached.Devices}, {Key: "lastRecipients", Value: reached.Recipients}, {Key: "lastRunAt", Value: now}, {Key: "updatedAt", Value: at}}}}); err != nil {
			slog.ErrorContext(ctx, "[platform-push] run not recorded", "scheduleId", s.ID.Hex(), "error", err)
		}
		sent++
	}
	return ordered.Map{{Key: "due", Value: len(due)}, {Key: "failed", Value: failed}, {Key: "sent", Value: sent}, {Key: "skipped", Value: skipped}}, nil
}
