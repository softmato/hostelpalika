package billing

import (
	"context"
	"log/slog"
	"net/url"
	"slices"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/push"
)

// DailyFromDays: from this many days before the due day, every run reminds.
const DailyFromDays = 3

// RemindsToday is remindsToday: the daily stretch, plus the early heads-ups.
func RemindsToday(daysUntilDue int, earlyDays []int) bool {
	return daysUntilDue <= DailyFromDays || slices.Contains(earlyDays, daysUntilDue)
}

// Horizon is the last due instant a run with these early days looks at.
func Horizon(now time.Time, earlyDays []int) time.Time {
	return bs.DayEnd(now, max(DailyFromDays, slices.Max(append([]int{0}, earlyDays...))))
}

func planRemindsToday(claimInReview bool, daysSinceIssue, daysUntilDue int, earlyDays []int, owingWhileLive bool) bool {
	if claimInReview || daysSinceIssue <= 0 {
		return false
	}
	if daysUntilDue < 0 && !owingWhileLive {
		return false
	}
	return RemindsToday(daysUntilDue, earlyDays)
}

// planEmailsToday: the owner's email goes a week out, three days out, then weekly once late.
func planEmailsToday(daysUntilDue int) bool {
	return daysUntilDue == 7 || daysUntilDue == 3 || (daysUntilDue <= 0 && daysUntilDue%7 == 0)
}

type dueInvoice struct {
	ID       bson.ObjectID `bson:"_id"`
	Amount   int64         `bson:"amount"`
	BilledTo struct {
		Email      string `bson:"email"`
		HostelName string `bson:"hostelName"`
		Name       string `bson:"name"`
	} `bson:"billedTo"`
	CreatedAt      *time.Time    `bson:"createdAt"`
	DueAt          time.Time     `bson:"dueAt"`
	HostelID       bson.ObjectID `bson:"hostelId"`
	InvoiceNumber  string        `bson:"invoiceNumber"`
	IssuedAt       *time.Time    `bson:"issuedAt"`
	PlanName       string        `bson:"planName"`
	SubscriptionID bson.ObjectID `bson:"subscriptionId"`
}

type dueHostel struct {
	ID      bson.ObjectID `bson:"_id"`
	Contact struct {
		Email string `bson:"email"`
	} `bson:"contact"`
	Name    string         `bson:"name"`
	OwnerID *bson.ObjectID `bson:"ownerId"`
	Slug    string         `bson:"slug"`
	Status  string         `bson:"status"`
}

func (h dueHostel) live() bool { return h.Status == "PUBLISHED" && h.Slug != "" }

type dueUser struct {
	ID    bson.ObjectID `bson:"_id"`
	Email string        `bson:"email"`
	Name  string        `bson:"name"`
	Role  string        `bson:"role"`
}

type planContext struct {
	admins   map[bson.ObjectID][]string
	hostels  map[bson.ObjectID]dueHostel
	inReview map[bson.ObjectID]bool
	pastDue  map[bson.ObjectID]bool
	settled  map[bson.ObjectID]int64
	users    map[bson.ObjectID]dueUser
}

func (s *Service) planContext(ctx context.Context, batch []dueInvoice) (*planContext, error) {
	hostelIDs, subIDs, invIDs := bson.A{}, bson.A{}, bson.A{}
	for _, inv := range batch {
		hostelIDs, subIDs, invIDs = append(hostelIDs, inv.HostelID), append(subIDs, inv.SubscriptionID), append(invIDs, inv.ID)
	}
	pc := &planContext{admins: map[bson.ObjectID][]string{}, hostels: map[bson.ObjectID]dueHostel{}, inReview: map[bson.ObjectID]bool{},
		pastDue: map[bson.ObjectID]bool{}, settled: map[bson.ObjectID]int64{}, users: map[bson.ObjectID]dueUser{}}
	cur, err := s.DB.Collection("hostels").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: hostelIDs}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
		options.Find().SetProjection(bson.D{{Key: "contact", Value: 1}, {Key: "name", Value: 1}, {Key: "ownerId", Value: 1}, {Key: "slug", Value: 1}, {Key: "status", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var hostels []dueHostel
	if err := cur.All(ctx, &hostels); err != nil {
		return nil, err
	}
	cur, err = s.DB.Collection("hostelsubscriptions").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: subIDs}}}, {Key: "status", Value: "PAST_DUE"}},
		options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var past []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := cur.All(ctx, &past); err != nil {
		return nil, err
	}
	for _, p := range past {
		pc.pastDue[p.ID] = true
	}
	cur, err = s.DB.Collection("subscriptionpayments").Aggregate(ctx, bson.A{
		bson.D{{Key: "$match", Value: bson.D{{Key: "invoiceId", Value: bson.D{{Key: "$in", Value: invIDs}}}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"IN_REVIEW", "SETTLED"}}}}}}},
		bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: bson.D{{Key: "invoiceId", Value: "$invoiceId"}, {Key: "status", Value: "$status"}}}, {Key: "total", Value: bson.D{{Key: "$sum", Value: "$amount"}}}}}},
	})
	if err != nil {
		return nil, err
	}
	var pays []struct {
		ID struct {
			InvoiceID bson.ObjectID `bson:"invoiceId"`
			Status    string        `bson:"status"`
		} `bson:"_id"`
		Total int64 `bson:"total"`
	}
	if err := cur.All(ctx, &pays); err != nil {
		return nil, err
	}
	for _, p := range pays {
		if p.ID.Status == "SETTLED" {
			pc.settled[p.ID.InvoiceID] = p.Total
		} else {
			pc.inReview[p.ID.InvoiceID] = true
		}
	}
	live := bson.A{}
	for _, h := range hostels {
		pc.hostels[h.ID] = h
		if h.live() {
			live = append(live, h.ID)
		}
	}
	var members []struct {
		HostelID bson.ObjectID `bson:"hostelId"`
		UserID   bson.ObjectID `bson:"userId"`
	}
	if len(live) > 0 {
		cur, err = s.DB.Collection("hostelmembers").Find(ctx, bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: live}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
			{Key: "role", Value: "HOSTEL_ADMIN"}, {Key: "status", Value: "ACTIVE"}}, options.Find().SetProjection(bson.D{{Key: "hostelId", Value: 1}, {Key: "userId", Value: 1}}))
		if err != nil {
			return nil, err
		}
		if err := cur.All(ctx, &members); err != nil {
			return nil, err
		}
	}
	userIDs := bson.A{}
	for _, h := range hostels {
		if h.OwnerID != nil {
			userIDs = append(userIDs, *h.OwnerID)
		}
	}
	for _, m := range members {
		userIDs = append(userIDs, m.UserID)
	}
	if len(userIDs) > 0 {
		cur, err = s.DB.Collection("users").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: userIDs}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
			options.Find().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "name", Value: 1}, {Key: "role", Value: 1}}))
		if err != nil {
			return nil, err
		}
		var users []dueUser
		if err := cur.All(ctx, &users); err != nil {
			return nil, err
		}
		for _, u := range users {
			pc.users[u.ID] = u
		}
	}
	for _, h := range hostels {
		if !h.live() {
			continue
		}
		var candidates []bson.ObjectID
		if h.OwnerID != nil {
			candidates = append(candidates, *h.OwnerID)
		}
		for _, m := range members {
			if m.HostelID == h.ID {
				candidates = append(candidates, m.UserID)
			}
		}
		admins := []string{}
		for _, id := range candidates {
			if pc.users[id].Role == "HOSTEL_ADMIN" && !slices.Contains(admins, id.Hex()) {
				admins = append(admins, id.Hex())
			}
		}
		pc.admins[h.ID] = admins
	}
	return pc, nil
}

type planReminder struct {
	admins      []string
	hostel      dueHostel
	invoice     dueInvoice
	outstanding int64
	ownerName   string
	to          string
}

// PlanDueReminders is sendPlanDueReminders: one reminder per hostel with an
// unpaid plan bill (the earliest due), a push to the hostel admins of a live
// hostel and, on the email days, an email to the owner.
func (s *Service) PlanDueReminders(ctx context.Context, p *push.Sender, earlyDays []int, sendEmail bool, now time.Time) (devices, emails, recipients int, err error) {
	cur, err := s.DB.Collection("subscriptioninvoices").Find(ctx, bson.D{{Key: "dueAt", Value: bson.D{{Key: "$lte", Value: Horizon(now, earlyDays)}, {Key: "$ne", Value: nil}}},
		{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"OPEN", "PARTIAL"}}}}}, options.Find().SetSort(bson.D{{Key: "dueAt", Value: 1}}))
	if err != nil {
		return 0, 0, 0, err
	}
	var invoices []dueInvoice
	if err := cur.All(ctx, &invoices); err != nil {
		return 0, 0, 0, err
	}
	if len(invoices) == 0 {
		return 0, 0, 0, nil
	}
	pc, err := s.planContext(ctx, invoices)
	if err != nil {
		return 0, 0, 0, err
	}
	reminded := map[bson.ObjectID]bool{}
	var list []planReminder
	for _, inv := range invoices {
		h, ok := pc.hostels[inv.HostelID]
		outstanding := max(0, inv.Amount-pc.settled[inv.ID])
		if !ok || outstanding <= 0 || reminded[inv.HostelID] {
			continue
		}
		days := bs.DaysBetween(now, inv.DueAt)
		issued := now
		if inv.IssuedAt != nil {
			issued = *inv.IssuedAt
		} else if inv.CreatedAt != nil {
			issued = *inv.CreatedAt
		}
		if !planRemindsToday(pc.inReview[inv.ID], bs.DaysBetween(issued, now), days, earlyDays, pc.pastDue[inv.SubscriptionID]) {
			continue
		}
		var owner dueUser
		if h.OwnerID != nil {
			owner = pc.users[*h.OwnerID]
		}
		to := ""
		if sendEmail && planEmailsToday(days) {
			to = firstNonEmpty(owner.Email, h.Contact.Email, inv.BilledTo.Email)
		}
		var admins []string
		if h.live() {
			admins = pc.admins[h.ID]
		}
		if to == "" && len(admins) == 0 {
			continue
		}
		reminded[inv.HostelID] = true
		list = append(list, planReminder{admins, h, inv, outstanding, firstNonEmpty(owner.Name, inv.BilledTo.Name), to})
	}
	for _, r := range list {
		if r.to != "" && s.planDueEmail(ctx, r, now) {
			emails++
		}
		if len(r.admins) > 0 && p != nil {
			title, body := composePlanDue(r, now)
			res := p.ToUsers(ctx, r.admins, push.Payload{Title: title, Body: body, Category: "PAYMENT", HostelID: r.hostel.ID.Hex(), Priority: "NORMAL",
				Data: map[string]any{"hostelSlug": r.hostel.Slug, "invoiceNumber": r.invoice.InvoiceNumber, "subscriptionInvoiceId": r.invoice.ID.Hex(), "type": "PLAN_DUE"}})
			devices += res.Sent
			recipients += len(r.admins)
		}
	}
	return devices, emails, recipients, nil
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}

func (r planReminder) hostelName() string {
	return firstNonEmpty(r.hostel.Name, r.invoice.BilledTo.HostelName)
}

// composePlanDue is composePlanDueNotice.
func composePlanDue(r planReminder, now time.Time) (title, body string) {
	days := bs.DaysBetween(now, r.invoice.DueAt)
	body = email.Rupees(r.outstanding) + " for " + r.invoice.PlanName + " · " + r.hostelName()
	if d := bs.FormatDate(r.invoice.DueAt); d != "" {
		body += ", due " + d
	}
	body += ". Invoice " + r.invoice.InvoiceNumber + "."
	if days < 0 {
		late := -days
		unit := "days"
		if late == 1 {
			unit = "day"
		}
		return "Plan payment overdue by " + strconv.Itoa(late) + " " + unit, body
	}
	when := "in " + strconv.Itoa(days) + " days"
	switch days {
	case 0:
		when = "today"
	case 1:
		when = "tomorrow"
	}
	return "Plan payment due " + when, body
}

func (s *Service) planDueEmail(ctx context.Context, r planReminder, now time.Time) bool {
	if s.Mail == nil {
		return false
	}
	files := s.InvoiceAttachment(ctx, r.invoice.InvoiceNumber, r.invoice.HostelID)
	payURL := s.SiteURL + "/register-hostel/form"
	if r.hostel.Status == "PUBLISHED" && r.hostel.Slug != "" {
		payURL = s.PlanPayLink(ctx, r.hostel.ID, s.SiteURL+"/"+url.PathEscape(r.hostel.Slug)+"/admin/billing")
	}
	in := email.PlanDue{AmountDue: r.outstanding, Attached: len(files) > 0, DueDate: email.EmailDate(r.invoice.DueAt), HostelName: r.hostelName(),
		InvoiceNumber: r.invoice.InvoiceNumber, OwnerName: r.ownerName, PayURL: payURL, PlanName: r.invoice.PlanName}
	days := bs.DaysBetween(now, r.invoice.DueAt)
	m := email.PlanOverdue(in)
	if days >= 0 {
		m = email.PlanDueSoon(in, days, r.hostel.Status == "PUBLISHED")
	}
	res := s.Mail.Send(ctx, email.Message{Category: m.Category, To: []string{r.to}, Subject: m.Subject, HTML: m.HTML, Attachments: files})
	if !res.Sent {
		slog.WarnContext(ctx, "plan_due_email_failed", "invoiceNumber", r.invoice.InvoiceNumber, "reason", res.Reason)
	}
	return res.Sent
}

// FreeMonthWelcomes is sendFreeMonthWelcomes: hostel admins on a free month are
// welcomed once in each free month; the $push claim keeps it once.
func (s *Service) FreeMonthWelcomes(ctx context.Context, n *notifications.Service, now time.Time) (int, error) {
	cur, err := s.DB.Collection("hostelsubscriptions").Find(ctx, bson.D{{Key: "freeUntil", Value: bson.D{{Key: "$gte", Value: now}}}, {Key: "status", Value: "ACTIVE"}})
	if err != nil {
		return 0, err
	}
	var subs []struct {
		ID          bson.ObjectID `bson:"_id"`
		ActivatedAt *time.Time    `bson:"activatedAt"`
		FreeMonths  *int64        `bson:"freeMonths"`
		FreeUntil   *time.Time    `bson:"freeUntil"`
		HostelID    bson.ObjectID `bson:"hostelId"`
		PlanName    string        `bson:"planName"`
	}
	if err := cur.All(ctx, &subs); err != nil {
		return 0, err
	}
	recipients := 0
	for _, sub := range subs {
		month := FreeMonthOf(sub.ActivatedAt, sub.FreeUntil, sub.FreeMonths, now)
		if month == nil {
			continue
		}
		var h struct {
			IsDeleted bool   `bson:"isDeleted"`
			Status    string `bson:"status"`
		}
		if err := s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: sub.HostelID}}, options.FindOne().SetProjection(bson.D{{Key: "isDeleted", Value: 1}, {Key: "status", Value: 1}})).Decode(&h); err != nil || h.IsDeleted || h.Status != "PUBLISHED" {
			continue
		}
		res, err := s.DB.Collection("hostelsubscriptions").UpdateOne(ctx, bson.D{{Key: "_id", Value: sub.ID}, {Key: "freeMonthsWelcomed", Value: bson.D{{Key: "$ne", Value: month.Month}}}},
			bson.D{{Key: "$push", Value: bson.D{{Key: "freeMonthsWelcomed", Value: month.Month}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: time.Now().UTC().Truncate(time.Millisecond)}}}})
		if err != nil {
			return recipients, err
		}
		if res.ModifiedCount == 0 {
			continue
		}
		uc, err := s.DB.Collection("users").Find(ctx, bson.D{{Key: "hostelIds", Value: sub.HostelID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "role", Value: "HOSTEL_ADMIN"}},
			options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
		if err != nil {
			return recipients, err
		}
		var admins []struct {
			ID bson.ObjectID `bson:"_id"`
		}
		if err := uc.All(ctx, &admins); err != nil {
			return recipients, err
		}
		ends, _ := time.Parse(time.RFC3339, month.EndsAt)
		title, body := composeFreeMonthWelcome(ends, month.Left, sub.PlanName)
		for _, a := range admins {
			if _, err := n.CreateInApp(ctx, notifications.Input{Body: body, Category: "GENERAL", Data: ordered.Map{{Key: "freeMonth", Value: month.Month}, {Key: "type", Value: "PLAN_FREE_MONTH"}},
				HostelID: sub.HostelID.Hex(), Priority: "NORMAL", Title: title, UserID: a.ID.Hex()}); err != nil {
				slog.WarnContext(ctx, "Free month welcome not written", "hostelId", sub.HostelID.Hex(), "error", err)
			}
		}
		recipients += len(admins)
	}
	return recipients, nil
}

// composeFreeMonthWelcome is composeFreeMonthWelcome.
func composeFreeMonthWelcome(endsAt time.Time, left int, planName string) (title, body string) {
	plan := "plan"
	if planName != "" {
		plan = planName + " plan"
	}
	if left > 0 {
		unit := "months"
		if left == 1 {
			unit = "month"
		}
		body = strconv.Itoa(left) + " more free " + unit + " after this one. This month is free until " + bs.FormatDate(endsAt) + "."
	} else {
		body = "This is your last free month, free until " + bs.FormatDate(endsAt) + "."
	}
	return "Welcome — enjoy the free " + plan + " this month", body
}
