package ledger

import (
	"context"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/push"
)

const feeDueBatch = 500

// composeFeeDue is composeFeeDueNotice.
func composeFeeDue(daysUntilDue int, period *string) (title, body string) {
	switch {
	case daysUntilDue < 0:
		title = "Hostel fee overdue"
	case daysUntilDue == 0:
		title = "Hostel fee due today"
	case daysUntilDue == 1:
		title = "Hostel fee due tomorrow"
	default:
		title = "Hostel fee due in " + strconv.Itoa(daysUntilDue) + " days"
	}
	body = "Please pay your hostel fee."
	if period != nil {
		if m := bs.FormatPeriodMonth(*period); m != "" {
			body = "Please pay your hostel fee for " + m + "."
		}
	}
	return title, body
}

// FeeDueReminders is sendFeeDueReminders: each resident with an unpaid fee is
// pushed once per run about their nearest due bill, grouped so one hostel's
// identical notices go out together.
func FeeDueReminders(ctx context.Context, db *mongo.Database, p *push.Sender, earlyDays []int, now time.Time) (devices, recipients int, err error) {
	type due struct {
		days   int
		hostel bson.ObjectID
		period *string
	}
	byResident := map[bson.ObjectID]due{}
	var order []bson.ObjectID
	horizon := billing.Horizon(now, earlyDays)
	var cursor *bson.ObjectID
	for {
		f := bson.D{{Key: "dueDate", Value: bson.D{{Key: "$lte", Value: horizon}}}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"OPEN", "PARTIAL", "OVERDUE"}}}}}
		if cursor != nil {
			f = append(f, bson.E{Key: "_id", Value: bson.D{{Key: "$gt", Value: *cursor}}})
		}
		cur, err := db.Collection("invoices").Find(ctx, f, options.Find().SetSort(bson.D{{Key: "_id", Value: 1}}).SetLimit(feeDueBatch).
			SetProjection(bson.D{{Key: "dueDate", Value: 1}, {Key: "hostelId", Value: 1}, {Key: "period", Value: 1}, {Key: "residentId", Value: 1}, {Key: "totalAmount", Value: 1}}))
		if err != nil {
			return 0, 0, err
		}
		var batch []struct {
			ID          bson.ObjectID `bson:"_id"`
			DueDate     time.Time     `bson:"dueDate"`
			HostelID    bson.ObjectID `bson:"hostelId"`
			Period      *string       `bson:"period"`
			ResidentID  bson.ObjectID `bson:"residentId"`
			TotalAmount int64         `bson:"totalAmount"`
		}
		if err := cur.All(ctx, &batch); err != nil {
			return 0, 0, err
		}
		if len(batch) == 0 {
			break
		}
		cursor = &batch[len(batch)-1].ID
		ids := make(bson.A, len(batch))
		for i, b := range batch {
			ids[i] = b.ID
		}
		bc, err := db.Collection("invoicebalances").Find(ctx, bson.D{{Key: "invoiceId", Value: bson.D{{Key: "$in", Value: ids}}}},
			options.Find().SetProjection(bson.D{{Key: "invoiceId", Value: 1}, {Key: "settledAmount", Value: 1}}))
		if err != nil {
			return 0, 0, err
		}
		var balances []struct {
			InvoiceID     bson.ObjectID `bson:"invoiceId"`
			SettledAmount int64         `bson:"settledAmount"`
		}
		if err := bc.All(ctx, &balances); err != nil {
			return 0, 0, err
		}
		settled := map[bson.ObjectID]int64{}
		for _, b := range balances {
			settled[b.InvoiceID] = b.SettledAmount
		}
		for _, inv := range batch {
			days := bs.DaysBetween(now, inv.DueDate)
			current, seen := byResident[inv.ResidentID]
			if inv.TotalAmount-settled[inv.ID] <= 0 || !billing.RemindsToday(days, earlyDays) || (seen && current.days <= days) {
				continue
			}
			if !seen {
				order = append(order, inv.ResidentID)
			}
			byResident[inv.ResidentID] = due{days, inv.HostelID, inv.Period}
		}
		if len(batch) < feeDueBatch {
			break
		}
	}
	if len(byResident) == 0 {
		return 0, 0, nil
	}
	ids := make(bson.A, len(order))
	for i, id := range order {
		ids[i] = id
	}
	rc, err := db.Collection("residents").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "isDeleted", Value: false},
		{Key: "status", Value: bson.D{{Key: "$ne", Value: "MOVED_OUT"}}}, {Key: "userId", Value: bson.D{{Key: "$ne", Value: nil}}}},
		options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}, {Key: "userId", Value: 1}}))
	if err != nil {
		return 0, 0, err
	}
	var residents []struct {
		ID     bson.ObjectID `bson:"_id"`
		UserID bson.ObjectID `bson:"userId"`
	}
	if err := rc.All(ctx, &residents); err != nil {
		return 0, 0, err
	}
	type group struct {
		hostel      string
		title, body string
		users       []string
	}
	groups := map[string]*group{}
	var keys []string
	for _, r := range residents {
		d := byResident[r.ID]
		title, body := composeFeeDue(d.days, d.period)
		key := d.hostel.Hex() + "|" + title + "|" + body
		g, ok := groups[key]
		if !ok {
			g = &group{hostel: d.hostel.Hex(), title: title, body: body}
			groups[key] = g
			keys = append(keys, key)
		}
		g.users = append(g.users, r.UserID.Hex())
	}
	if p != nil {
		for _, k := range keys {
			g := groups[k]
			devices += p.ToUsers(ctx, g.users, push.Payload{Title: g.title, Body: g.body, Category: "PAYMENT", HostelID: g.hostel, Priority: "NORMAL"}).Sent
		}
	}
	return devices, len(residents), nil
}
