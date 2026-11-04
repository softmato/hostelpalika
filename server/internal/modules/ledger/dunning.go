package ledger

import (
	"context"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/recon"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/background"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// dunning.service.ts: the reminder → overdue → chase → escalate → stop ladder.
// The stage is recorded on the invoice, so a late run climbs to the rung it
// should be on and a second run the same day does nothing.

const (
	MaxChases          = 4
	chaseIntervalDays  = 7
	reminderSoonDays   = 3
	overdueFirstDays   = 3
	overdueSecondDays  = 7
	dunningBatch       = 200
	stageNone          = "NONE"
	stageReminded      = "REMINDED"
	stageRemindedSoon  = "REMINDED_SOON"
	stageRemindedDue   = "REMINDED_DUE"
	stageOverdueFirst  = "OVERDUE_FIRST"
	stageOverdueSecond = "OVERDUE_SECOND"
	stageChasing       = "CHASING"
	stageEscalated     = "ESCALATED"
	stageStopped       = "STOPPED"
)

// DunningAction is the next rung; Kind is chase, escalate, overdue, reminder or stop.
type DunningAction struct{ Kind, Stage string }

// NextDunningAction is nextDunningAction: pure, every threshold `>=` so a missed
// day heals. nil = nothing today. daysSinceLastNotice < 0 means never notified.
func NextDunningAction(chaseCount, daysSinceLastNotice, daysUntilDue, reminderDaysBefore int, stage string) *DunningAction {
	switch stage {
	case stageStopped:
		return nil
	case stageEscalated:
		return &DunningAction{"stop", stageStopped}
	}
	if daysUntilDue >= 0 {
		// Read from the last rung backwards: a late run sends only the rung it is on.
		switch {
		case stage == stageRemindedDue:
			return nil
		case daysUntilDue <= 0:
			return &DunningAction{"reminder", stageRemindedDue}
		case daysUntilDue <= reminderSoonDays && stage != stageRemindedSoon:
			return &DunningAction{"reminder", stageRemindedSoon}
		case stage == stageNone && daysUntilDue <= reminderDaysBefore:
			return &DunningAction{"reminder", stageReminded}
		}
		return nil
	}
	late := -daysUntilDue
	before := stage == stageNone || stage == stageReminded || stage == stageRemindedDue || stage == stageRemindedSoon
	switch {
	case late >= overdueFirstDays && before:
		return &DunningAction{"overdue", stageOverdueFirst}
	case late >= overdueSecondDays && stage == stageOverdueFirst:
		return &DunningAction{"overdue", stageOverdueSecond}
	case stage == stageOverdueSecond || stage == stageChasing:
		if chaseCount >= MaxChases {
			return &DunningAction{"escalate", stageEscalated}
		}
		// A week after the last notice, so a late first run cannot fold four chases into one day.
		if (daysSinceLastNotice < 0 || daysSinceLastNotice >= chaseIntervalDays) && late >= chaseIntervalDays {
			return &DunningAction{"chase", stageChasing}
		}
	}
	return nil
}

type dunningInvoice struct {
	ID       bson.ObjectID `bson:"_id"`
	DueDate  time.Time     `bson:"dueDate"`
	HostelID bson.ObjectID `bson:"hostelId"`
	Period   *string       `bson:"period"`
	Resident bson.ObjectID `bson:"residentId"`
	Status   string        `bson:"status"`
	Total    int64         `bson:"totalAmount"`
	Dunning  *struct {
		ChaseCount     int        `bson:"chaseCount"`
		LastNotifiedAt *time.Time `bson:"lastNotifiedAt"`
		Stage          string     `bson:"stage"`
	} `bson:"dunning"`
}

type dunningResident struct {
	ID     bson.ObjectID  `bson:"_id"`
	Email  string         `bson:"email"`
	First  string         `bson:"firstName"`
	Last   string         `bson:"lastName"`
	UserID *bson.ObjectID `bson:"userId"`
}

func (r dunningResident) name() string { return strings.TrimSpace(r.First + " " + r.Last) }

type dunningItem struct {
	action      DunningAction
	inv         dunningInvoice
	outstanding int64
	res         dunningResident
	email       bool
}

// RunPaymentReminders is runPaymentReminders: pages every open invoice by id,
// marks the late ones OVERDUE, moves each one rung, one rent email per resident
// per run, and mails each hostel's admins once about everyone escalated.
func (e *Engine) RunPaymentReminders(ctx context.Context, now time.Time) (ordered.Map, error) {
	cfg := e.Config.OperationsTyped(ctx)
	var escalated, markedOverdue, overdueNotified, reminded, scanned, stopped int
	_, _, err := recon.WithRun(ctx, e.DB, nil, "DUNNING", "CRON", func(rec *recon.Recorder) error {
		invoices := e.DB.Collection("invoices")
		hostelNames := map[bson.ObjectID]string{}
		emailed := map[bson.ObjectID]bool{}
		var escOrder []bson.ObjectID
		escalations := map[bson.ObjectID][]email.PaymentLine{}
		var cursor *bson.ObjectID
		for {
			f := bson.D{{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"OPEN", "PARTIAL", "OVERDUE"}}}}}
			if cursor != nil {
				f = append(f, bson.E{Key: "_id", Value: bson.D{{Key: "$gt", Value: *cursor}}})
			}
			cur, err := invoices.Find(ctx, f, options.Find().SetSort(bson.D{{Key: "_id", Value: 1}}).SetLimit(dunningBatch))
			if err != nil {
				return err
			}
			var batch []dunningInvoice
			if err := cur.All(ctx, &batch); err != nil {
				return err
			}
			if len(batch) == 0 {
				break
			}
			cursor = &batch[len(batch)-1].ID
			scanned += len(batch)
			rec.Count("scanned", int64(len(batch)))

			resIDs, invIDs := make(bson.A, len(batch)), make(bson.A, len(batch))
			for i, inv := range batch {
				resIDs[i], invIDs[i] = inv.Resident, inv.ID
			}
			rcur, err := e.DB.Collection("residents").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: resIDs}}},
				{Key: "isDeleted", Value: false}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "MOVED_OUT"}}}})
			if err != nil {
				return err
			}
			var rows []dunningResident
			if err := rcur.All(ctx, &rows); err != nil {
				return err
			}
			byID := make(map[bson.ObjectID]dunningResident, len(rows))
			for _, r := range rows {
				byID[r.ID] = r
			}
			bcur, err := e.DB.Collection("invoicebalances").Find(ctx, bson.D{{Key: "invoiceId", Value: bson.D{{Key: "$in", Value: invIDs}}}})
			if err != nil {
				return err
			}
			var balances []struct {
				InvoiceID bson.ObjectID `bson:"invoiceId"`
				Settled   int64         `bson:"settledAmount"`
			}
			if err := bcur.All(ctx, &balances); err != nil {
				return err
			}
			settled := map[bson.ObjectID]int64{}
			for _, b := range balances {
				settled[b.InvoiceID] = b.Settled
			}

			var planned []dunningItem
			for _, inv := range batch {
				res, ok := byID[inv.Resident]
				if !ok {
					continue
				}
				untilDue := bs.DaysBetween(now, inv.DueDate)
				if untilDue < 0 && inv.Status != "OVERDUE" {
					if _, err := invoices.UpdateOne(ctx, bson.D{{Key: "_id", Value: inv.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "OVERDUE"}, {Key: "updatedAt", Value: now.UTC().Truncate(time.Millisecond)}}}}); err != nil {
						return err
					}
					markedOverdue++
				}
				chases, since, stage := 0, -1, stageNone
				if d := inv.Dunning; d != nil {
					chases = d.ChaseCount
					if d.LastNotifiedAt != nil {
						since = bs.DaysBetween(*d.LastNotifiedAt, now)
					}
					if d.Stage != "" {
						stage = d.Stage
					}
				}
				a := NextDunningAction(chases, since, untilDue, cfg.PaymentReminderDaysBefore, stage)
				if a == nil {
					continue
				}
				planned = append(planned, dunningItem{action: *a, inv: inv, outstanding: max(inv.Total-settled[inv.ID], 0), res: res})
			}
			for _, it := range planned {
				if _, ok := hostelNames[it.inv.HostelID]; !ok {
					hostelNames[it.inv.HostelID], _ = residents.HostelName(ctx, e.DB, it.inv.HostelID)
				}
			}
			// Late notices first, so a resident's one email is about what is overdue.
			sort.SliceStable(planned, func(i, j int) bool {
				return planned[i].action.Kind != "reminder" && planned[j].action.Kind == "reminder"
			})
			for i := range planned {
				it := &planned[i]
				// Three days out is bell only: the fee push already goes twice a day from then on.
				it.email = cfg.SendPaymentEmails && it.action.Stage != stageRemindedSoon && !emailed[it.res.ID]
				if it.email {
					emailed[it.res.ID] = true
				}
			}

			var mu sync.Mutex
			var mails []email.Notification
			delivered := make([]bool, len(planned))
			sends := make([]func(), len(planned))
			for i := range planned {
				sends[i] = func() {
					m, ok := e.deliverDunning(ctx, planned[i], hostelNames[planned[i].inv.HostelID], now)
					delivered[i] = ok
					if m != nil {
						mu.Lock()
						mails = append(mails, *m)
						mu.Unlock()
					}
				}
			}
			background.Parallel(ctx, sends...)
			if len(mails) > 0 && e.Mail != nil {
				e.Mail.NotifyBatch(ctx, mails)
			}

			for i, it := range planned {
				if !delivered[i] {
					rec.Count("errors", 1)
					id := it.inv.ID
					rec.Finding(recon.Finding{Code: "DUNNING_SEND_FAILED", Detail: "stage " + it.action.Stage, EntityID: &id, EntityType: "Invoice", Severity: "WARN"})
					continue
				}
				var last any = now
				if it.action.Kind == "stop" {
					last = nil
					if it.inv.Dunning != nil && it.inv.Dunning.LastNotifiedAt != nil {
						last = *it.inv.Dunning.LastNotifiedAt
					}
				}
				upd := bson.D{{Key: "$set", Value: bson.D{{Key: "dunning.lastNotifiedAt", Value: last}, {Key: "dunning.stage", Value: it.action.Stage}, {Key: "updatedAt", Value: now.UTC().Truncate(time.Millisecond)}}}}
				if it.action.Kind == "chase" {
					upd = append(upd, bson.E{Key: "$inc", Value: bson.D{{Key: "dunning.chaseCount", Value: 1}}})
				}
				if _, err := invoices.UpdateOne(ctx, bson.D{{Key: "_id", Value: it.inv.ID}}, upd); err != nil {
					return err
				}
				switch it.action.Kind {
				case "reminder":
					reminded++
					rec.Count("reminded", 1)
				case "overdue", "chase":
					overdueNotified++
					rec.Count("overdueNotified", 1)
				case "escalate":
					if _, ok := escalations[it.inv.HostelID]; !ok {
						escOrder = append(escOrder, it.inv.HostelID)
					}
					month := ""
					if it.inv.Period != nil {
						month = *it.inv.Period
					}
					escalations[it.inv.HostelID] = append(escalations[it.inv.HostelID], email.PaymentLine{Amount: it.outstanding, Month: month, Name: it.res.name()})
					escalated++
					rec.Count("escalated", 1)
					id := it.inv.ID
					rec.Finding(recon.Finding{Code: "DUNNING_ESCALATED", Detail: strconv.Itoa(MaxChases) + " chases sent with no payment; handed to the hostel", EntityID: &id, EntityType: "Invoice", Severity: "WARN"})
				default:
					stopped++
					rec.Count("stopped", 1)
				}
			}
			if len(batch) < dunningBatch {
				break
			}
		}
		if cfg.SendPaymentEmails && e.Mail != nil {
			var sends []func()
			for _, hostel := range escOrder {
				sends = append(sends, func() { e.emailEscalations(ctx, hostel, hostelNames[hostel], escalations[hostel]) })
			}
			background.Parallel(ctx, sends...)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return ordered.Map{{Key: "escalated", Value: escalated}, {Key: "markedOverdue", Value: markedOverdue}, {Key: "overdueNotified", Value: overdueNotified},
		{Key: "reminded", Value: reminded}, {Key: "scanned", Value: scanned}, {Key: "stopped", Value: stopped}}, nil
}

// deliverDunning sends one rung's bell rows and returns the resident's email for
// the page's one batch. false = nothing delivered; the stage is not advanced so
// the next run retries this rung.
func (e *Engine) deliverDunning(ctx context.Context, it dunningItem, hostelName string, now time.Time) (*email.Notification, bool) {
	period := ""
	if it.inv.Period != nil {
		period = *it.inv.Period
	}
	data := ordered.Map{{Key: "invoiceId", Value: it.inv.ID.Hex()}}
	switch it.action.Kind {
	case "stop":
		return nil, true
	case "escalate":
		// A person, not a fifth message: the hostel's admins are told.
		admins, err := residents.HostelAdminContacts(ctx, e.DB, it.inv.HostelID)
		if err != nil {
			return nil, false
		}
		label := period
		if label == "" {
			label = "an earlier period"
		}
		body := it.res.name() + " has not paid NPR " + money.GroupIN(it.outstanding) + " for " + label + " after " + strconv.Itoa(MaxChases) + " reminders. Automated reminders have stopped."
		for _, a := range admins {
			if a.UserID != "" && e.Notify != nil {
				if _, err := e.Notify.CreateInApp(ctx, notifications.Input{Body: body, Category: "PAYMENT", Data: data, HostelID: it.inv.HostelID.Hex(), Title: "Unpaid fee needs your attention", UserID: a.UserID}); err != nil {
					return nil, false
				}
			}
		}
		return nil, true
	}
	overdue := it.action.Kind != "reminder"
	stage := email.ReminderStage("WEEK")
	switch it.action.Stage {
	case stageRemindedDue:
		stage = "TODAY"
	case stageRemindedSoon:
		stage = "SOON"
	}
	if it.res.UserID != nil && e.Notify != nil {
		title, body := "Payment due soon", "Your "+period+" fee is due on "+it.inv.DueDate.UTC().Format("Mon Jan 02 2006")+"."
		switch {
		case overdue:
			title, body = "Payment overdue", "Your "+period+" fee is overdue."
		case stage == "TODAY":
			title, body = "Payment due today", "Your "+period+" fee is due today."
		}
		// The bell row only: the resident's push is the automatic fee reminder.
		if _, err := e.Notify.CreateInApp(ctx, notifications.Input{Body: body, Category: "PAYMENT", Data: data, HostelID: it.inv.HostelID.Hex(), NoPush: true, Title: title, UserID: it.res.UserID.Hex()}); err != nil {
			return nil, false
		}
	}
	if !it.email {
		return nil, true
	}
	contact := residents.ResolveContact(ctx, e.DB, it.res.Email, it.res.First, it.res.Last, it.res.UserID)
	if contact == nil {
		return nil, true
	}
	url := e.AppURL("/resident/payments")
	var c email.Content
	action := "payment_due_reminder"
	if overdue {
		action = "payment_overdue"
		c = email.PaymentOverdue(it.outstanding, max(0, -bs.DaysBetween(now, it.inv.DueDate)), it.inv.DueDate, hostelName, period, url, contact.Name)
	} else {
		c = email.PaymentDueReminder(it.outstanding, it.inv.DueDate, hostelName, period, url, contact.Name, stage)
	}
	return &email.Notification{Action: action, Category: c.Category, HTML: c.HTML, Subject: c.Subject, To: contact.Email, Topic: "RENT_REMINDERS"}, true
}

// emailEscalations is one email per admin for everyone escalated in this run.
func (e *Engine) emailEscalations(ctx context.Context, hostel bson.ObjectID, hostelName string, lines []email.PaymentLine) {
	admins, err := residents.HostelAdminContacts(ctx, e.DB, hostel)
	if err != nil {
		e.warn(ctx, "dunning escalation email failed", err)
		return
	}
	c := email.UnpaidFees(hostelName, e.AppURL("/hostel-admin/payments"), MaxChases, lines)
	for _, a := range admins {
		e.Mail.Notify(ctx, email.Notification{Action: "payment_escalated", Category: c.Category, HTML: c.HTML, Subject: c.Subject, To: a.Email, Topic: "PAYMENT_SUMMARY"})
	}
}

// SendAdminPaymentDigest is sendAdminPaymentDigest: each hostel's admins get one
// morning email of proofs still waiting and money cleared in the last day.
// Never fails the job.
func (e *Engine) SendAdminPaymentDigest(ctx context.Context, now time.Time) ordered.Map {
	hostels, err := e.paymentDigest(ctx, now)
	if err != nil {
		e.warn(ctx, "payment_digest_failed", err)
	}
	return ordered.Map{{Key: "hostels", Value: hostels}}
}

type digestRow struct {
	Amount    int64          `bson:"amount"`
	HostelID  bson.ObjectID  `bson:"hostelId"`
	InvoiceID *bson.ObjectID `bson:"invoiceId"`
	Month     *string        `bson:"month"`
	Resident  *bson.ObjectID `bson:"residentId"`
}

func (e *Engine) paymentDigest(ctx context.Context, now time.Time) (int, error) {
	if e.Mail == nil || !e.Config.OperationsTyped(ctx).SendPaymentEmails {
		return 0, nil
	}
	find := func(coll string, f bson.D, fields ...string) ([]digestRow, error) {
		proj := bson.D{}
		for _, k := range fields {
			proj = append(proj, bson.E{Key: k, Value: 1})
		}
		// ponytail: platform-wide reads; add `{ source, status }` / `{ issuedAt }` indexes if these grow.
		cur, err := e.DB.Collection(coll).Find(ctx, f, options.Find().SetProjection(proj))
		if err != nil {
			return nil, err
		}
		var rows []digestRow
		return rows, cur.All(ctx, &rows)
	}
	waiting, err := find("paymentevents", bson.D{{Key: "source", Value: "RESIDENT_CLAIM"}, {Key: "status", Value: "PENDING"}}, "amount", "hostelId", "invoiceId", "residentId")
	if err != nil {
		return 0, err
	}
	received, err := find("receipts", bson.D{{Key: "issuedAt", Value: bson.D{{Key: "$gte", Value: now.Add(-24 * time.Hour)}, {Key: "$lt", Value: now}}}, {Key: "voidedAt", Value: nil}}, "amount", "hostelId", "month", "residentId")
	if err != nil || len(waiting)+len(received) == 0 {
		return 0, err
	}
	resIDs, invIDs := bson.A{}, bson.A{}
	for _, r := range append(append([]digestRow{}, waiting...), received...) {
		if r.Resident != nil {
			resIDs = append(resIDs, *r.Resident)
		}
	}
	for _, r := range waiting {
		if r.InvoiceID != nil {
			invIDs = append(invIDs, *r.InvoiceID)
		}
	}
	names, periods := map[bson.ObjectID]string{}, map[bson.ObjectID]string{}
	cur, err := e.DB.Collection("residents").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: resIDs}}}}, options.Find().SetProjection(bson.D{{Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}}))
	if err != nil {
		return 0, err
	}
	var rs []dunningResident
	if err := cur.All(ctx, &rs); err != nil {
		return 0, err
	}
	for _, r := range rs {
		names[r.ID] = r.name()
	}
	cur, err = e.DB.Collection("invoices").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: invIDs}}}}, options.Find().SetProjection(bson.D{{Key: "period", Value: 1}}))
	if err != nil {
		return 0, err
	}
	var is []struct {
		ID     bson.ObjectID `bson:"_id"`
		Period *string       `bson:"period"`
	}
	if err := cur.All(ctx, &is); err != nil {
		return 0, err
	}
	for _, i := range is {
		if i.Period != nil {
			periods[i.ID] = *i.Period
		}
	}
	line := func(r digestRow, month string) email.PaymentLine {
		name := ""
		if r.Resident != nil {
			name = names[*r.Resident]
		}
		if name == "" {
			name = "Resident"
		}
		return email.PaymentLine{Amount: r.Amount, Month: month, Name: name}
	}
	type tally struct{ received, waiting []email.PaymentLine }
	var order []bson.ObjectID
	by := map[bson.ObjectID]*tally{}
	lists := func(h bson.ObjectID) *tally {
		if by[h] == nil {
			by[h] = &tally{}
			order = append(order, h)
		}
		return by[h]
	}
	for _, r := range waiting {
		month := ""
		if r.InvoiceID != nil {
			month = periods[*r.InvoiceID]
		}
		t := lists(r.HostelID)
		t.waiting = append(t.waiting, line(r, month))
	}
	for _, r := range received {
		month := ""
		if r.Month != nil {
			month = *r.Month
		}
		t := lists(r.HostelID)
		t.received = append(t.received, line(r, month))
	}
	var mu sync.Mutex
	hostels := 0
	sends := make([]func(), 0, len(order))
	for _, h := range order {
		sends = append(sends, func() {
			name, _ := residents.HostelName(ctx, e.DB, h)
			admins, err := residents.HostelAdminContacts(ctx, e.DB, h)
			if err != nil {
				e.warn(ctx, "payment_digest_failed", err)
				return
			}
			c := email.PaymentSummary(name, e.AppURL("/hostel-admin/payments"), by[h].received, by[h].waiting)
			for _, a := range admins {
				e.Mail.Notify(ctx, email.Notification{Action: "payment_digest", Category: c.Category, HTML: c.HTML, Subject: c.Subject, To: a.Email, Topic: "PAYMENT_SUMMARY"})
			}
			mu.Lock()
			hostels++
			mu.Unlock()
		})
	}
	background.Parallel(ctx, sends...)
	return hostels, nil
}
