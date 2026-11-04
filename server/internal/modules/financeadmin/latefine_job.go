package financeadmin

import (
	"context"
	"log/slog"
	"math"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/push"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
)

type fineLine struct {
	amount            int64
	description, mode string
	rate              float64
}

// lateFineLine is lateFineLine: days late since the due day (or since the rule
// was switched on, if later) times the day's fine. ok=false: nothing owed yet.
func lateFineLine(base int64, due time.Time, enabledAt *time.Time, mode string, now time.Time, rate float64) (fineLine, bool) {
	from := due
	if enabledAt != nil && enabledAt.After(due) {
		from = *enabledAt
	}
	days := int64(bs.DaysBetween(from, now))
	var perDay int64
	if mode == "PER_DAY_AMOUNT" {
		perDay = int64(math.Round(rate))
	} else {
		perDay = int64(math.Round(float64(max(base, 0)) * rate / 100))
	}
	if days <= 0 || perDay <= 0 {
		return fineLine{}, false
	}
	dayWord := strconv.FormatInt(days, 10) + " days"
	if days == 1 {
		dayWord = "1 day"
	}
	rs := func(n int64) string { return "Rs " + money.GroupUS(n) }
	desc := "Late fine — " + rs(perDay) + " a day × " + dayWord
	if mode != "PER_DAY_AMOUNT" {
		desc = "Late fine — " + strconv.FormatFloat(rate, 'f', -1, 64) + "% of " + rs(base) + " a day (" + rs(perDay) + ") × " + dayWord
	}
	return fineLine{perDay * days, desc, mode, rate}, true
}

// AccrueLateFines is accrueLateFines (inside the billing-cycle job): each open
// rent bill past its due day gets its FINE line recomputed. The write is
// guarded by the old total, so a payment landing meanwhile is never overwritten.
func (h *Handler) AccrueLateFines(ctx context.Context, p *push.Sender, now time.Time) (ordered.Map, error) {
	cur, err := h.DB.Collection("hostelsettings").Find(ctx, bson.D{{Key: "lateFine.enabled", Value: true}}, options.Find().SetProjection(bson.D{{Key: "hostelId", Value: 1}, {Key: "lateFine", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var hostels []struct {
		HostelID bson.ObjectID  `bson:"hostelId"`
		S        storedSettings `bson:",inline"`
	}
	if err := cur.All(ctx, &hostels); err != nil {
		return nil, err
	}
	fined := int64(0)
	for _, hs := range hostels {
		rule, enabledAt := readLateFine(&hs.S)
		ic, err := h.DB.Collection("invoices").Find(ctx, bson.D{{Key: "dueDate", Value: bson.D{{Key: "$lt", Value: now}}}, {Key: "fineWaived", Value: bson.D{{Key: "$ne", Value: true}}},
			{Key: "hostelId", Value: hs.HostelID}, {Key: "kind", Value: "MONTHLY_RENT"}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"OPEN", "OVERDUE", "PARTIAL"}}}}},
			options.Find().SetProjection(bson.D{{Key: "dueDate", Value: 1}, {Key: "lines", Value: 1}, {Key: "residentId", Value: 1}, {Key: "totalAmount", Value: 1}}))
		if err != nil {
			return nil, err
		}
		var invoices []struct {
			ID          bson.ObjectID `bson:"_id"`
			DueDate     time.Time     `bson:"dueDate"`
			Lines       []bson.Raw    `bson:"lines"`
			ResidentID  bson.ObjectID `bson:"residentId"`
			TotalAmount bson.RawValue `bson:"totalAmount"`
		}
		if err := ic.All(ctx, &invoices); err != nil {
			return nil, err
		}
		changed := int64(0)
		type row struct {
			body       string
			data       ordered.Map
			residentID bson.ObjectID
		}
		var first []row
		for _, inv := range invoices {
			others := bson.A{}
			var base int64
			var existing bson.Raw
			for _, l := range inv.Lines {
				if b, _ := l.Lookup("basis").StringValueOK(); b == "FINE" {
					existing = l
					continue
				}
				others = append(others, l)
				if v, ok := l.Lookup("amount").AsInt64OK(); ok {
					base += v
				} else if f, ok := l.Lookup("amount").AsFloat64OK(); ok {
					base += int64(f)
				}
			}
			mode, rate := rule.Mode, rule.Rate
			var had *int64
			if existing != nil {
				if m, ok := existing.Lookup("fineMode").StringValueOK(); ok {
					mode = m
				}
				if r, ok := existing.Lookup("fineRate").AsFloat64OK(); ok {
					rate = r
				}
				if a, ok := existing.Lookup("amount").AsInt64OK(); ok {
					had = &a
				}
			}
			line, ok := lateFineLine(base, inv.DueDate, enabledAt, mode, now, rate)
			if !ok || (had != nil && *had == line.amount) {
				continue
			}
			lines := append(others, bson.D{{Key: "amount", Value: jsNumber(float64(line.amount))}, {Key: "basis", Value: "FINE"}, {Key: "bedType", Value: nil}, {Key: "description", Value: line.description},
				{Key: "fineMode", Value: line.mode}, {Key: "fineRate", Value: jsNumber(line.rate)}})
			total := base + line.amount
			res, err := h.DB.Collection("invoices").UpdateOne(ctx, bson.D{{Key: "_id", Value: inv.ID}, {Key: "totalAmount", Value: inv.TotalAmount}},
				bson.D{{Key: "$set", Value: bson.D{{Key: "lines", Value: lines}, {Key: "totalAmount", Value: jsNumber(float64(total))}, {Key: "updatedAt", Value: nowMS()}}}})
			if err != nil {
				return nil, err
			}
			changed += res.ModifiedCount
			if res.ModifiedCount > 0 && existing == nil {
				first = append(first, row{"A late fine was added. Your bill is now NPR " + money.GroupUS(total) + ".",
					ordered.Map{{Key: "invoiceId", Value: inv.ID.Hex()}, {Key: "type", Value: "LATE_FINE_ADDED"}}, inv.ResidentID})
			}
		}
		if len(first) > 0 {
			ids := make(bson.A, len(first))
			for i, r := range first {
				ids[i] = r.residentID
			}
			rc, err := h.DB.Collection("residents").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "userId", Value: 1}}))
			if err != nil {
				return nil, err
			}
			var rs []struct {
				ID     bson.ObjectID  `bson:"_id"`
				UserID *bson.ObjectID `bson:"userId"`
			}
			if err := rc.All(ctx, &rs); err != nil {
				return nil, err
			}
			userOf := map[bson.ObjectID]string{}
			for _, r := range rs {
				if r.UserID != nil {
					userOf[r.ID] = r.UserID.Hex()
				}
			}
			var users []string
			byUser := map[string]map[string]any{}
			for _, r := range first {
				u := userOf[r.residentID]
				if u == "" {
					continue
				}
				if h.Ledger != nil && h.Ledger.Notify != nil {
					if _, err := h.Ledger.Notify.CreateInApp(ctx, notifications.Input{Body: r.body, Category: "PAYMENT", Data: r.data, HostelID: hs.HostelID.Hex(), NoPush: true, Title: "Late fine added", UserID: u}); err != nil {
						slog.WarnContext(ctx, "Late fine notice not written", "error", err)
					}
				}
				users = append(users, u)
				byUser[u] = map[string]any{"invoiceId": r.data[0].Value, "type": "LATE_FINE_ADDED"}
			}
			if len(users) > 0 && p != nil {
				p.ToUsers(ctx, users, push.Payload{Body: "Your rent is overdue and a late fine was added. Tap to pay.", Category: "PAYMENT", DataByUser: byUser, HostelID: hs.HostelID.Hex(), Title: "Late fine added"})
			}
		}
		if changed > 0 {
			fined += changed
			realtime.PublishResourceChange(ctx, h.RT, h.Cache, realtime.Change{HostelIDs: []string{hs.HostelID.Hex()}, Topics: []realtime.Topic{realtime.Payments}})
		}
	}
	return ordered.Map{{Key: "hostels", Value: len(hostels)}, {Key: "invoicesFined", Value: fined}}, nil
}
