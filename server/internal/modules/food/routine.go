// Package food: so far the weekly routine's read side (food-routine.service.ts),
// which the public hostel page and compare draw. The rest lands with Phase 6.
package food

import (
	"context"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// Empty is EMPTY_ROUTINE: an unconfigured hostel still renders the same shape.
func Empty() ordered.Map {
	return ordered.Map{{Key: "meals", Value: []any{}}, {Key: "monthEndSpecial", Value: nil},
		{Key: "timings", Value: ordered.Map{}}, {Key: "updatedAt", Value: ""}}
}

func get(m any, key string) any {
	mm, _ := m.(ordered.Map)
	v, _ := mm.Get(key)
	return v
}

func orEmpty(v any) any {
	if v == nil || v == ordered.Undefined {
		return []any{}
	}
	return v
}

func length(v any) int { a, _ := v.([]any); return len(a) }

// serialize is serializeRoutine: empty meals dropped, each meal carrying its
// timing, the month-end special only when it lists something.
func serialize(row ordered.Map) ordered.Map {
	timings, ok := row.Get("timings")
	if timings == nil || !ok {
		timings = ordered.Map{}
	}
	meals := []any{}
	list, _ := row.Get("meals")
	mealList, _ := list.([]any)
	for _, m := range mealList {
		items := orEmpty(get(m, "items"))
		if length(items) == 0 {
			continue
		}
		mealType := get(m, "mealType")
		timing := ordered.Undefined
		if s, ok := mealType.(string); ok {
			if t, ok := timings.(ordered.Map).Get(s); ok && t != nil {
				timing = t
			}
		}
		if timing == ordered.Undefined {
			timing = ""
		}
		note := get(m, "note")
		if note == nil {
			note = ""
		}
		meals = append(meals, ordered.Map{{Key: "dayOfWeek", Value: orUndef(get(m, "dayOfWeek"), m, "dayOfWeek")},
			{Key: "items", Value: items}, {Key: "mealType", Value: orUndef(mealType, m, "mealType")}, {Key: "note", Value: note}, {Key: "timing", Value: timing}})
	}
	var special any
	if me, _ := row.Get("monthEndSpecial"); me != nil {
		if items := orEmpty(get(me, "items")); length(items) > 0 {
			note := get(me, "note")
			if note == nil {
				note = ""
			}
			special = ordered.Map{{Key: "items", Value: items}, {Key: "note", Value: note}}
		}
	}
	updated, _ := row.Get("updatedAt")
	if updated == nil {
		updated = ""
	}
	return ordered.Map{{Key: "meals", Value: meals}, {Key: "monthEndSpecial", Value: special}, {Key: "timings", Value: timings}, {Key: "updatedAt", Value: updated}}
}

// orUndef keeps an absent key absent, as `meal.dayOfWeek` would.
func orUndef(v any, m any, key string) any {
	if _, ok := m.(ordered.Map).Get(key); !ok {
		return ordered.Undefined
	}
	return v
}

// Routines is getFoodRoutinesByHostelId: hostels without a routine are absent.
func Routines(ctx context.Context, db *mongo.Database, hostelIDs []bson.ObjectID) (map[string]any, error) {
	out := map[string]any{}
	if len(hostelIDs) == 0 {
		return out, nil
	}
	cur, err := db.Collection("foodroutines").Find(ctx, bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: hostelIDs}}}})
	if err != nil {
		return nil, err
	}
	var rows []bson.Raw
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	for _, r := range rows {
		row := ordered.Raw(r).(ordered.Map)
		id, _ := row.Get("hostelId")
		key, _ := id.(string)
		out[key] = serialize(row)
	}
	return out, nil
}
