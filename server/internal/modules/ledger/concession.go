package ledger

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// ConcessionBackfill is what applyConcessionToIssuedInvoices did, for the screen.
type ConcessionBackfill struct {
	Discounted       int64 `json:"discounted"`
	InvoicesChanged  int   `json:"invoicesChanged"`
	InvoicesKept     int   `json:"invoicesKept"`
	RefundedAsCredit int64 `json:"refundedAsCredit"`
}

// DiscountRent is discountRent: the rent after percentOff, rounding the discount down.
func DiscountRent(monthly int64, percentOff int64) int64 {
	if percentOff <= 0 {
		return monthly
	}
	return monthly - (monthly*percentOff)/100
}

type concessionChange struct {
	after, before, credited int64
	resident                bson.ObjectID
}

// ApplyConcession is applyConcessionToIssuedInvoices: a festival discount on a
// month already billed. The rent line stays as issued and a negative CREDIT line
// keyed by concessionPercent goes under it; percentOff 0 withdraws it, except on a
// bill with money already settled. Paid money above the new total becomes credit.
// Safe to re-run: the line and the credit entry are replaced, never stacked.
// p nil (a cron) skips the audit, as there is nobody to name.
func (e *Engine) ApplyConcession(ctx context.Context, hostel bson.ObjectID, period string, percentOff int64, reason string, p *authz.Principal) (ConcessionBackfill, error) {
	var out ConcessionBackfill
	cur, err := e.DB.Collection("invoices").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "kind", Value: "MONTHLY_RENT"}, {Key: "period", Value: period}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "VOID"}}}},
		options.Find().SetProjection(bson.D{{Key: "hostelId", Value: 1}, {Key: "residentId", Value: 1}, {Key: "lines", Value: 1}, {Key: "totalAmount", Value: 1}}))
	if err != nil {
		return out, err
	}
	var invoices []struct {
		ID       bson.ObjectID `bson:"_id"`
		Resident bson.ObjectID `bson:"residentId"`
		Lines    []bson.D      `bson:"lines"`
		Total    int64         `bson:"totalAmount"`
	}
	if err := cur.All(ctx, &invoices); err != nil || len(invoices) == 0 {
		return out, err
	}
	monthName := bs.FormatPeriod(period)
	if monthName == "" {
		monthName = period
	}
	note := strconv.FormatInt(percentOff, 10) + "% off"
	if reason != "" {
		note = reason + " · " + note
	}
	field := func(line bson.D, key string) any {
		for _, e := range line {
			if e.Key == key {
				return e.Value
			}
		}
		return nil
	}
	num := func(v any) int64 {
		switch n := v.(type) {
		case int32:
			return int64(n)
		case int64:
			return n
		case float64:
			return int64(n)
		}
		return 0
	}
	var changes []concessionChange
	var me bson.ObjectID
	if p != nil {
		me, _ = bson.ObjectIDFromHex(p.UserID)
	}
	for _, inv := range invoices {
		var base, creditApplied int64
		var existing bool
		lines := []bson.D{}
		for _, l := range inv.Lines {
			marked := num(field(l, "concessionPercent")) != 0
			if marked {
				existing = true
				continue
			}
			lines = append(lines, l)
			// FIN-9: the discount is on rent only, never on a khata or fine line.
			switch field(l, "basis") {
			case "CREDIT":
				creditApplied += num(field(l, "amount"))
			case "SCHEDULE", "OVERRIDE", "MANUAL":
				base += num(field(l, "amount"))
			}
		}
		// Clamped so the invoice cannot go negative when credit was applied at issue.
		discount := min(base-DiscountRent(base, percentOff), max(base+creditApplied, 0))
		// Withdrawing from a bill that has money against it: the one correction a hostel cannot make politely.
		if percentOff == 0 && existing {
			var bal struct {
				Settled int64 `bson:"settledAmount"`
			}
			err := e.DB.Collection("invoicebalances").FindOne(ctx, bson.D{{Key: "invoiceId", Value: inv.ID}}).Decode(&bal)
			if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
				return out, err
			}
			if bal.Settled > 0 {
				out.InvoicesKept++
				continue
			}
		}
		if discount > 0 {
			lines = append(lines, bson.D{{Key: "amount", Value: JSInt(-discount)}, {Key: "basis", Value: "CREDIT"}, {Key: "concessionPercent", Value: JSInt(percentOff)},
				{Key: "description", Value: note + " — " + monthName}})
		}
		var after int64
		for _, l := range lines {
			after += num(field(l, "amount"))
		}
		if after == inv.Total {
			continue
		}
		if _, err := e.DB.Collection("invoices").UpdateOne(ctx, bson.D{{Key: "_id", Value: inv.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "lines", Value: lines},
			{Key: "totalAmount", Value: JSInt(after)}, {Key: "updatedAt", Value: now()}}}, {Key: "$inc", Value: bson.D{{Key: "__v", Value: 1}}}}); err != nil {
			return out, err
		}
		out.Discounted += max(inv.Total-after, 0)
		out.InvoicesChanged++
		bal, err := e.RecomputeInvoiceBalance(ctx, inv.ID)
		if err != nil {
			return out, err
		}
		excess := max(bal.SettledAmount-after, 0)
		if _, err := e.SetConcessionCredit(ctx, hostel, inv.Resident, inv.ID, excess, "", note+" — "+monthName+", already paid"); err != nil {
			return out, err
		}
		out.RefundedAsCredit += excess
		changes = append(changes, concessionChange{after, inv.Total, excess, inv.Resident})
		if p != nil && e.Audit != nil {
			f := audit.Finance{Action: "RENT_CONCESSION_APPLIED", AmountAfter: after, AmountBefore: inv.Total, EntityID: inv.ID.Hex(), EntityType: "Invoice", HostelID: hostel,
				InvoiceID: inv.ID.Hex(), Reason: note, Source: "RENT_CONCESSION"}
			if percentOff == 0 {
				f.Action, f.Reason = "RENT_CONCESSION_REMOVED", "Full rent restored for "+monthName
			}
			if err := e.Audit.WriteFinance(ctx, me, string(p.Role), f); err != nil {
				return out, err
			}
		}
	}
	if percentOff == 0 {
		note = ""
	}
	e.notifyConcession(ctx, hostel, changes, monthName, note)
	return out, nil
}

// notifyConcession is notifyRentConcession: the money is finished before anybody is
// told, and a failure here is logged, never the save's.
func (e *Engine) notifyConcession(ctx context.Context, hostel bson.ObjectID, changes []concessionChange, monthName, note string) {
	if len(changes) == 0 || e.Notify == nil {
		return
	}
	ids := bson.A{}
	for _, ch := range changes {
		ids = append(ids, ch.resident)
	}
	users, err := liveResidentUsers(ctx, e.DB, ids)
	if err != nil {
		slog.WarnContext(ctx, "rent_concession_notification_failed", "hostelId", hostel.Hex(), "err", err)
		return
	}
	npr := func(n int64) string { return "NPR " + money.GroupUS(n) }
	for _, ch := range changes {
		user, ok := users[ch.resident]
		if !ok {
			continue
		}
		reduced := ch.after < ch.before
		parts := []string{"Your " + monthName + " bill is back to " + npr(ch.after) + "."}
		title := "Your bill has changed"
		if reduced {
			parts[0] = "Your " + monthName + " bill is now " + npr(ch.after) + " instead of " + npr(ch.before) + "."
			title = "Your bill has gone down"
			if note != "" {
				parts = append(parts, note+".")
			}
		}
		if ch.credited > 0 {
			parts = append(parts, npr(ch.credited)+" you had already paid is now credit towards your next bill.")
		}
		if _, err := e.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/resident/payments", Body: strings.Join(parts, " "), Category: "PAYMENT",
			Data: ordered.Map{{Key: "credited", Value: ch.credited}, {Key: "month", Value: monthName}}, HostelID: hostel.Hex(), Priority: "NORMAL", Title: title, UserID: user}); err != nil {
			slog.WarnContext(ctx, "rent_concession_notification_failed", "hostelId", hostel.Hex(), "err", err)
		}
	}
}

// liveResidentUsers maps each resident to their account, when both are live.
func liveResidentUsers(ctx context.Context, db *mongo.Database, residents bson.A) (map[bson.ObjectID]string, error) {
	cur, err := db.Collection("residents").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: residents}}}, {Key: "isDeleted", Value: false}, {Key: "userId", Value: bson.D{{Key: "$ne", Value: nil}}}},
		options.Find().SetProjection(bson.D{{Key: "userId", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID   bson.ObjectID `bson:"_id"`
		User bson.ObjectID `bson:"userId"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	userIDs := bson.A{}
	for _, r := range rows {
		userIDs = append(userIDs, r.User)
	}
	cur, err = db.Collection("users").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: userIDs}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
		options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var live []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := cur.All(ctx, &live); err != nil {
		return nil, err
	}
	ok := map[bson.ObjectID]bool{}
	for _, u := range live {
		ok[u.ID] = true
	}
	out := map[bson.ObjectID]string{}
	for _, r := range rows {
		if ok[r.User] {
			out[r.ID] = r.User.Hex()
		}
	}
	return out, nil
}
