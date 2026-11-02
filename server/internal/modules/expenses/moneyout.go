package expenses

import (
	"context"
	"sort"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// MonthMoneyOut is getMonthMoneyOut: the month's spending for the owner's report.
func (h *Handler) MonthMoneyOut(ctx context.Context, hostel bson.ObjectID, period, asker string) (ordered.Map, error) {
	bounds, err := bs.PeriodBounds(period)
	if err != nil {
		return nil, err
	}
	cur, err := h.DB.Collection("expenses").Find(ctx, bson.D{
		{Key: "cashStatus", Value: bson.D{{Key: "$ne", Value: "DECLINED"}}},
		{Key: "hostelId", Value: hostel},
		{Key: "spentOn", Value: bson.D{{Key: "$gte", Value: bounds.Start}, {Key: "$lte", Value: bounds.End}}},
		{Key: "status", Value: "RECORDED"},
	}, options.Find().SetSort(bson.D{{Key: "spentOn", Value: 1}, {Key: "createdAt", Value: 1}}).SetLimit(maxRows))
	if err != nil {
		return nil, err
	}
	var docs []doc
	if err := cur.All(ctx, &docs); err != nil {
		return nil, err
	}
	all, err := h.categories(ctx, hostel)
	if err != nil {
		return nil, err
	}
	people, err := h.people(ctx, hostel)
	if err != nil {
		return nil, err
	}
	names := map[string]string{}
	for _, x := range all {
		names[x.ID] = x.Name
	}
	rows := make([]ordered.Map, len(docs))
	var out int64
	var byCategory []*categoryTotal
	index := map[string]*categoryTotal{}
	for i := range docs {
		d := &docs[i]
		rows[i] = serialize(d, asker, names)
		if d.Category == staffCash {
			continue
		}
		key := d.Category
		var customID *string
		if d.Category == custom && d.CustomID != nil {
			hex := d.CustomID.Hex()
			customID = &hex
			key = "C:" + hex
		}
		e, ok := index[key]
		if !ok {
			e = &categoryTotal{Category: categoryValue(d.Category), CustomCategoryID: customID, Label: labelOf(d, names)}
			index[key] = e
			byCategory = append(byCategory, e)
		}
		e.Amount += d.Amount
		out += d.Amount
	}
	sort.SliceStable(byCategory, func(i, j int) bool { return byCategory[i].Amount > byCategory[j].Amount })
	totals := make([]categoryTotal, len(byCategory))
	for i, e := range byCategory {
		totals[i] = *e
	}
	staff, err := h.ListWallets(ctx, hostel, people, nil)
	if err != nil {
		return nil, err
	}
	return ordered.Map{{Key: "byCategory", Value: totals}, {Key: "out", Value: out}, {Key: "rows", Value: rows}, {Key: "staff", Value: staff}}, nil
}
