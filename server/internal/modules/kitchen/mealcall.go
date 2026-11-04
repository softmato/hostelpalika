package kitchen

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/food"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/push"
)

// mealCallGrace: how long after a meal's window opens the reminder may still go.
const mealCallGrace = 45

type routineRow struct {
	HostelID bson.ObjectID `bson:"hostelId"`
	Meals    []struct {
		DayOfWeek string   `bson:"dayOfWeek"`
		Items     []string `bson:"items"`
		MealType  string   `bson:"mealType"`
	} `bson:"meals"`
	Timings map[string]string `bson:"timings"`
}

type mealCall struct {
	hostelID bson.ObjectID
	mealType string
	timing   string
}

// dueMeals: meals planned for today whose Food ready window opened within the grace.
func dueMeals(routines []routineRow, now time.Time) []mealCall {
	minute := bs.NepalMinuteOfDay(now)
	today := routineDays[bs.CalendarDay(now).Weekday()]
	var out []mealCall
	for _, r := range routines {
		for _, mt := range mealTypes {
			timing := r.Timings[mt]
			opens, ok := food.OpensAt(timing)
			if !ok || minute < opens || minute > opens+mealCallGrace {
				continue
			}
			planned := false
			for _, m := range r.Meals {
				if m.DayOfWeek == today && m.MealType == mt && len(m.Items) > 0 {
					planned = true
					break
				}
			}
			if planned {
				out = append(out, mealCall{r.HostelID, mt, timing})
			}
		}
	}
	return out
}

// RunMealCallReminders is runMealCallReminders (the meal-call-reminders job):
// each hostel's cooks are told once a day per meal that Food ready is live,
// unless someone already pressed it. The unique (hostel, meal, day) row is the lock.
func (h *Handler) RunMealCallReminders(ctx context.Context, now time.Time) (ordered.Map, error) {
	cur, err := h.DB.Collection("foodroutines").Find(ctx, bson.D{}, options.Find().SetProjection(bson.D{{Key: "hostelId", Value: 1},
		{Key: "meals.dayOfWeek", Value: 1}, {Key: "meals.items", Value: 1}, {Key: "meals.mealType", Value: 1}, {Key: "timings", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var routines []routineRow
	if err := cur.All(ctx, &routines); err != nil {
		return nil, err
	}
	calls := dueMeals(routines, now)
	if len(calls) == 0 {
		return ordered.Map{{Key: "due", Value: 0}, {Key: "skipped", Value: 0}, {Key: "sent", Value: 0}}, nil
	}
	day := bs.NepalDayKey(now)
	startOfDay, _ := time.Parse("2006-01-02T15:04:05.000-07:00", day+"T00:00:00.000+05:45")
	ids := bson.A{}
	cooks := map[bson.ObjectID][]string{}
	for _, c := range calls {
		ids = append(ids, c.hostelID)
		if _, ok := cooks[c.hostelID]; !ok {
			list, err := h.cookUserIDs(ctx, c.hostelID)
			if err != nil {
				return nil, err
			}
			cooks[c.hostelID] = list
		}
	}
	lc, err := h.DB.Collection("foodreadylogs").Find(ctx, bson.D{{Key: "announcedAt", Value: bson.D{{Key: "$gte", Value: startOfDay}}}, {Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}}},
		options.Find().SetProjection(bson.D{{Key: "hostelId", Value: 1}, {Key: "mealType", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var logs []struct {
		HostelID bson.ObjectID `bson:"hostelId"`
		MealType string        `bson:"mealType"`
	}
	if err := lc.All(ctx, &logs); err != nil {
		return nil, err
	}
	called := map[string]bool{}
	for _, l := range logs {
		called[l.HostelID.Hex()+":"+l.MealType] = true
	}
	sent, skipped := 0, 0
	for _, c := range calls {
		list := cooks[c.hostelID]
		if len(list) == 0 || called[c.hostelID.Hex()+":"+c.mealType] {
			skipped++
			continue
		}
		at := time.Now().UTC().Truncate(time.Millisecond)
		if _, err := h.DB.Collection("mealcallreminders").InsertOne(ctx, bson.D{{Key: "_id", Value: bson.NewObjectIDFromTimestamp(at)}, {Key: "hostelId", Value: c.hostelID},
			{Key: "mealType", Value: c.mealType}, {Key: "day", Value: day}, {Key: "notifiedCount", Value: len(list)}, {Key: "sentAt", Value: at},
			{Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}); err != nil {
			if !mongo.IsDuplicateKeyError(err) {
				slog.WarnContext(ctx, "Meal call reminder not claimed", "hostelId", c.hostelID.Hex(), "mealType", c.mealType, "error", err)
			}
			skipped++
			continue
		}
		label := c.mealType[:1] + strings.ToLower(c.mealType[1:])
		title := label + " is due"
		body := ""
		if c.timing != "" {
			body = label + " is served " + c.timing + ". "
		}
		body += "The Food ready button is live"
		if opens, ok := food.OpensAt(c.timing); ok {
			body += " from " + food.FormatMinute(opens)
		}
		body += " — tap it when the food is out."
		data := ordered.Map{{Key: "audience", Value: "COOK"}, {Key: "mealType", Value: c.mealType}}
		failed := false
		for _, id := range list {
			if _, err := h.Notify.CreateInApp(ctx, notifications.Input{Body: body, Category: "FOOD", Data: data, HostelID: c.hostelID.Hex(), NoPush: true, Priority: "HIGH", Title: title, UserID: id}); err != nil {
				slog.WarnContext(ctx, "Meal call bell row not written", "hostelId", c.hostelID.Hex(), "error", err)
				failed = true
				break
			}
		}
		if failed {
			skipped++
			continue
		}
		if h.Push != nil {
			h.Push.ToUsers(ctx, list, push.Payload{Body: body, Category: "FOOD", Data: map[string]any{"audience": "COOK", "mealType": c.mealType}, HostelID: c.hostelID.Hex(), Priority: "HIGH", Title: title})
		}
		sent++
	}
	return ordered.Map{{Key: "due", Value: len(calls)}, {Key: "sent", Value: sent}, {Key: "skipped", Value: skipped}}, nil
}
