package billing

import (
	"context"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// Service reads a hostel's own plan billing: modules/billing/subscription.service
// getSubscriptionState and billing-history.service getBillingHistory.
type Service struct {
	DB      *mongo.Database
	SiteURL string // siteUrl(): the app's own origin, no trailing slash
	// SoftmatoBase is SOFTMATO_BASE_URL; empty keeps the docs link null.
	SoftmatoBase string
}

// HostelCode is hostelCode: the id an owner types at the plan checkout.
func HostelCode(id string) string {
	if len(id) > 8 {
		id = id[len(id)-8:]
	}
	return "HH-" + strings.ToUpper(id)
}

func iso(t *time.Time) any {
	if t == nil || t.IsZero() {
		return nil
	}
	return httpx.ISO(*t)
}

type subscription struct {
	ID               bson.ObjectID `bson:"_id"`
	ActivatedAt      *time.Time    `bson:"activatedAt"`
	CurrentPeriodEnd *time.Time    `bson:"currentPeriodEnd"`
	Cycle            *string       `bson:"cycle"`
	CycleMonths      *int64        `bson:"cycleMonths"`
	CycleTotal       *int64        `bson:"cycleTotal"`
	DueBy            *time.Time    `bson:"dueBy"`
	FreeMonths       *int64        `bson:"freeMonths"`
	FreeUntil        *time.Time    `bson:"freeUntil"`
	Lifetime         bool          `bson:"lifetime"`
	LifetimeSince    *time.Time    `bson:"lifetimeSince"`
	PlanID           *string       `bson:"planId"`
	PlanName         *string       `bson:"planName"`
	Source           *string       `bson:"source"`
	Status           string        `bson:"status"`
	TrialDays        *int64        `bson:"trialDays"`
	TrialEndsAt      *time.Time    `bson:"trialEndsAt"`
}

type invoice struct {
	ID            bson.ObjectID `bson:"_id"`
	Amount        int64         `bson:"amount"`
	Currency      *string       `bson:"currency"`
	Cycle         string        `bson:"cycle"`
	CycleMonths   *int64        `bson:"cycleMonths"`
	DocumentURL   *string       `bson:"documentUrl"`
	DueAt         *time.Time    `bson:"dueAt"`
	InvoiceNumber string        `bson:"invoiceNumber"`
	IssuedAt      *time.Time    `bson:"issuedAt"`
	Lifetime      bool          `bson:"lifetime"`
	LocalNo       *string       `bson:"localInvoiceNo"`
	PlanID        *string       `bson:"planId"`
	PlanName      string        `bson:"planName"`
	SoftmatoNo    *string       `bson:"softmatoInvoiceNo"`
	Status        string        `bson:"status"`
}

type payment struct {
	Amount       int64         `bson:"amount"`
	Reference    *string       `bson:"gatewayReference"`
	IsMocked     bool          `bson:"isMocked"`
	Method       string        `bson:"method"`
	LocalNo      *string       `bson:"localTransactionNo"`
	ReceiptNo    *string       `bson:"receiptNumber"`
	SettledAt    *time.Time    `bson:"settledAt"`
	Provider     *string       `bson:"softmatoProvider"`
	SoftmatoTxNo *string       `bson:"softmatoTransactionNo"`
	Status       string        `bson:"status"`
	ID           bson.ObjectID `bson:"_id"`
}

func str(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

func i64(n *int64) any {
	if n == nil {
		return nil
	}
	return *n
}

// excludeCheckoutAttempts is EXCLUDE_CHECKOUT_ATTEMPTS.
var excludeCheckoutAttempts = bson.D{{Key: "$nor", Value: bson.A{bson.D{{Key: "method", Value: "SOFTMATO"}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "SETTLED"}}}}}}}

// paidOn is outstandingFor's sum: only SETTLED rows count.
func (s *Service) settledTotal(ctx context.Context, match bson.D) (int64, error) {
	cur, err := s.DB.Collection("subscriptionpayments").Aggregate(ctx, bson.A{
		bson.D{{Key: "$match", Value: append(match, bson.E{Key: "status", Value: "SETTLED"})}},
		bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: nil}, {Key: "total", Value: bson.D{{Key: "$sum", Value: "$amount"}}}}}},
	})
	if err != nil {
		return 0, err
	}
	var rows []struct {
		Total int64 `bson:"total"`
	}
	if err := cur.All(ctx, &rows); err != nil || len(rows) == 0 {
		return 0, err
	}
	return rows[0].Total, nil
}

type invoiceOut struct {
	Amount      int64  `json:"amount"`
	Cycle       string `json:"cycle"`
	DocumentURL any    `json:"documentUrl"`
	DueAt       any    `json:"dueAt"`
	ID          string `json:"id"`
	Number      string `json:"invoiceNumber"`
	IssuedAt    any    `json:"issuedAt"`
	PlanName    string `json:"planName"`
	Status      string `json:"status"`
}

type paymentOut struct {
	Amount    int64  `json:"amount"`
	ID        string `json:"id"`
	IsMocked  bool   `json:"isMocked"`
	Method    string `json:"method"`
	ReceiptNo any    `json:"receiptNumber"`
	SettledAt any    `json:"settledAt"`
	Status    string `json:"status"`
}

type freeMonthOut struct {
	EndsAt string `json:"endsAt"`
	Left   int    `json:"left"`
	Month  int    `json:"month"`
	Of     int64  `json:"of"`
}

type subscriptionOut struct {
	ActivatedAt      any           `json:"activatedAt"`
	CurrentPeriodEnd any           `json:"currentPeriodEnd"`
	Cycle            any           `json:"cycle"`
	CycleTotal       any           `json:"cycleTotal"`
	DueBy            any           `json:"dueBy"`
	FreeMonths       any           `json:"freeMonths"`
	FreeUntil        any           `json:"freeUntil"`
	FreeMonthNow     *freeMonthOut `json:"freeMonthNow"`
	ID               string        `json:"id"`
	Lifetime         bool          `json:"lifetime"`
	LifetimeSince    any           `json:"lifetimeSince"`
	PlanID           any           `json:"planId"`
	PlanName         any           `json:"planName"`
	Source           string        `json:"source"`
	Status           string        `json:"status"`
	TrialDays        any           `json:"trialDays"`
	TrialEndsAt      any           `json:"trialEndsAt"`
}

// State is getSubscriptionState's answer.
type State struct {
	CanPayNow    bool            `json:"canPayNow"`
	HostelName   string          `json:"hostelName"`
	HostelStatus string          `json:"hostelStatus"`
	Invoice      *invoiceOut     `json:"invoice"`
	Outstanding  int64           `json:"outstanding"`
	Paid         int64           `json:"paid"`
	Payments     []paymentOut    `json:"payments"`
	PlanChosen   bool            `json:"planChosen"`
	Subscription subscriptionOut `json:"subscription"`
	Verified     bool            `json:"verified"`
}

// FreeMonthOf is freeMonthOf: the free month running at now, or nil.
func FreeMonthOf(activatedAt, freeUntil *time.Time, freeMonths *int64, now time.Time) *freeMonthOut {
	if activatedAt == nil || freeUntil == nil || freeMonths == nil || *freeMonths == 0 || now.After(*freeUntil) {
		return nil
	}
	for month := 1; month <= int(*freeMonths); month++ {
		endsAt, err := bs.MonthsEnd(*activatedAt, month)
		if err != nil {
			return nil
		}
		if !now.After(endsAt) {
			return &freeMonthOut{httpx.ISO(endsAt), int(*freeMonths) - month, month, *freeMonths}
		}
	}
	return nil
}

// openInvoice is findOpenInvoice: the live invoice that is not a setup fee.
func (s *Service) openInvoice(ctx context.Context, subscriptionID bson.ObjectID) (*invoice, error) {
	var inv invoice
	err := s.DB.Collection("subscriptioninvoices").FindOne(ctx, bson.D{{Key: "kind", Value: bson.D{{Key: "$ne", Value: "SETUP_FEE"}}},
		{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"OPEN", "PARTIAL"}}}}, {Key: "subscriptionId", Value: subscriptionID}},
		options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}})).Decode(&inv)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return &inv, err
}

// State is getSubscriptionState; nil when the hostel has no subscription row.
func (s *Service) State(ctx context.Context, hostelID bson.ObjectID) (*State, error) {
	id, err := BillingHostelID(ctx, s.DB, hostelID)
	if err != nil {
		return nil, err
	}
	var sub subscription
	if err := s.DB.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "hostelId", Value: id}}).Decode(&sub); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil
		}
		return nil, err
	}
	latest, err := s.openInvoice(ctx, sub.ID)
	if err != nil {
		return nil, err
	}
	if latest == nil {
		var inv invoice
		err := s.DB.Collection("subscriptioninvoices").FindOne(ctx, bson.D{{Key: "kind", Value: bson.D{{Key: "$ne", Value: "SETUP_FEE"}}}, {Key: "subscriptionId", Value: sub.ID}},
			options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}})).Decode(&inv)
		if err == nil {
			latest = &inv
		} else if !errors.Is(err, mongo.ErrNoDocuments) {
			return nil, err
		}
	}
	var paid int64
	var outstanding int64
	if latest != nil {
		if paid, err = s.settledTotal(ctx, bson.D{{Key: "invoiceId", Value: latest.ID}}); err != nil {
			return nil, err
		}
		outstanding = max(0, latest.Amount-paid)
	}
	// ponytail: a plan has a handful of payments; the TS read is unbounded too, capped here so a runaway row set cannot load.
	cur, err := s.DB.Collection("subscriptionpayments").Find(ctx, bson.D{{Key: "subscriptionId", Value: sub.ID}},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(500))
	if err != nil {
		return nil, err
	}
	var payments []payment
	if err := cur.All(ctx, &payments); err != nil {
		return nil, err
	}
	var hostel struct {
		Name               string `bson:"name"`
		Status             string `bson:"status"`
		VerificationStatus string `bson:"verificationStatus"`
	}
	if err := s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&hostel); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	verified := hostel.VerificationStatus == "VERIFIED"
	planChosen := sub.PlanID != nil && *sub.PlanID != ""
	out := &State{CanPayNow: verified && planChosen && sub.Status != "ACTIVE", HostelName: hostel.Name, HostelStatus: hostel.Status,
		Outstanding: outstanding, Paid: paid, Payments: []paymentOut{}, PlanChosen: planChosen, Verified: verified}
	if latest != nil {
		out.Invoice = &invoiceOut{latest.Amount, latest.Cycle, str(latest.DocumentURL), iso(latest.DueAt), latest.ID.Hex(), latest.InvoiceNumber, iso(latest.IssuedAt), latest.PlanName, latest.Status}
	}
	for _, p := range payments {
		out.Payments = append(out.Payments, paymentOut{p.Amount, p.ID.Hex(), p.IsMocked, p.Method, str(p.ReceiptNo), iso(p.SettledAt), p.Status})
	}
	source := "PUBLIC"
	if sub.Source != nil {
		source = *sub.Source
	}
	out.Subscription = subscriptionOut{iso(sub.ActivatedAt), iso(sub.CurrentPeriodEnd), str(sub.Cycle), i64(sub.CycleTotal), iso(sub.DueBy), i64(sub.FreeMonths), iso(sub.FreeUntil),
		FreeMonthOf(sub.ActivatedAt, sub.FreeUntil, sub.FreeMonths, time.Now()), sub.ID.Hex(), sub.Lifetime, iso(sub.LifetimeSince), str(sub.PlanID), str(sub.PlanName), source, sub.Status, i64(sub.TrialDays), iso(sub.TrialEndsAt)}
	return out, nil
}

// ---- billing history ----

type invoiceRow struct {
	Amount            int64  `json:"amount"`
	Currency          string `json:"currency"`
	CycleLabel        string `json:"cycleLabel"`
	DocumentURL       string `json:"documentUrl"`
	DueAt             any    `json:"dueAt"`
	InvoiceNumber     string `json:"invoiceNumber"`
	IssuedAt          any    `json:"issuedAt"`
	IssuedBy          string `json:"issuedBy"`
	Outstanding       int64  `json:"outstanding"`
	Paid              int64  `json:"paid"`
	PlanID            any    `json:"planId"`
	PlanName          string `json:"planName"`
	PrintedNumber     string `json:"printedNumber"`
	SoftmatoInvoiceNo any    `json:"softmatoInvoiceNo"`
	Status            string `json:"status"`
}

type paymentRow struct {
	Amount                int64  `json:"amount"`
	DocumentURL           any    `json:"documentUrl"`
	Method                string `json:"method"`
	PaidAt                any    `json:"paidAt"`
	PrintedNumber         any    `json:"printedNumber"`
	Provider              any    `json:"provider"`
	ProviderRef           any    `json:"providerRef"`
	ReceiptNumber         any    `json:"receiptNumber"`
	SoftmatoTransactionNo any    `json:"softmatoTransactionNo"`
	Status                string `json:"status"`
}

type planOut struct {
	ActivatedAt      any    `json:"activatedAt"`
	AmountDue        int64  `json:"amountDue"`
	AmountPaid       int64  `json:"amountPaid"`
	Cycle            any    `json:"cycle"`
	CycleMonths      any    `json:"cycleMonths"`
	CycleLabel       any    `json:"cycleLabel"`
	CurrentPeriodEnd any    `json:"currentPeriodEnd"`
	DaysRemaining    any    `json:"daysRemaining"`
	DaysToDue        any    `json:"daysToDue"`
	DueBy            any    `json:"dueBy"`
	DueFrom          any    `json:"dueFrom"`
	Lifetime         bool   `json:"lifetime"`
	PeriodDays       any    `json:"periodDays"`
	PlanID           any    `json:"planId"`
	PlanName         any    `json:"planName"`
	Price            any    `json:"price"`
	Status           string `json:"status"`
	TrialEndsAt      any    `json:"trialEndsAt"`
}

// History is BillingHistory.
type History struct {
	DocsURL  any          `json:"docsUrl"`
	Invoices []invoiceRow `json:"invoices"`
	Payments []paymentRow `json:"payments"`
	Plan     *planOut     `json:"plan"`
}

// EmptyHistory is what a hostel with no hostel in scope is shown.
func EmptyHistory() History { return History{Invoices: []invoiceRow{}, Payments: []paymentRow{}} }

// DocumentURL is documentDownloadUrl.
func (s *Service) DocumentURL(kind, number string) string {
	return s.SiteURL + "/api/v1/hostel-admin/billing/documents/" + kind + "/" + httpx.EncodeURIComponent(number)
}

func (s *Service) docsURL() any {
	base := strings.TrimSpace(s.SoftmatoBase)
	if base == "" {
		return nil
	}
	u, err := url.Parse(base)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil
	}
	return u.ResolveReference(&url.URL{Path: "/developers"}).String()
}

func cycleLabel(cycle string, months *int64) string {
	if months != nil && *months != 0 {
		switch *months {
		case 1:
			return "Monthly"
		case 6:
			return "6 months"
		case 12:
			return "Annual"
		}
		return itoa(*months) + " months"
	}
	switch cycle {
	case "annual":
		return "Annual"
	case "halfYearly":
		return "6 months"
	case "monthly":
		return "Monthly"
	}
	return cycle
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func daysUntil(end *time.Time, now time.Time) any {
	if end == nil {
		return nil
	}
	if !end.After(now) {
		return 0
	}
	return max(0, bs.DaysBetween(now, *end))
}

func daysLeftThrough(end *time.Time, now time.Time) any {
	if end == nil {
		return nil
	}
	if !end.After(now) {
		return 0
	}
	return bs.DaysBetween(now, *end) + 1
}

func daysSpanned(start, end *time.Time) any {
	if start == nil || end == nil {
		return nil
	}
	return max(1, bs.DaysBetween(*start, *end)+1)
}

// History is getBillingHistory.
func (s *Service) History(ctx context.Context, hostelID bson.ObjectID) (History, error) {
	id, err := BillingHostelID(ctx, s.DB, hostelID)
	if err != nil {
		return History{}, err
	}
	var sub subscription
	hasSub := true
	if err := s.DB.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "hostelId", Value: id}}).Decode(&sub); err != nil {
		if !errors.Is(err, mongo.ErrNoDocuments) {
			return History{}, err
		}
		hasSub = false
	}
	cur, err := s.DB.Collection("subscriptioninvoices").Find(ctx, bson.D{{Key: "hostelId", Value: id}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(50))
	if err != nil {
		return History{}, err
	}
	var invoices []invoice
	if err := cur.All(ctx, &invoices); err != nil {
		return History{}, err
	}
	pcur, err := s.DB.Collection("subscriptionpayments").Find(ctx, append(bson.D{{Key: "hostelId", Value: id}}, excludeCheckoutAttempts...), options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(50))
	if err != nil {
		return History{}, err
	}
	var payments []payment
	if err := pcur.All(ctx, &payments); err != nil {
		return History{}, err
	}
	gcur, err := s.DB.Collection("subscriptionpayments").Aggregate(ctx, bson.A{
		bson.D{{Key: "$match", Value: bson.D{{Key: "hostelId", Value: id}, {Key: "status", Value: "SETTLED"}}}},
		bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$invoiceId"}, {Key: "total", Value: bson.D{{Key: "$sum", Value: "$amount"}}}}}},
	})
	if err != nil {
		return History{}, err
	}
	var settled []struct {
		ID    bson.ObjectID `bson:"_id"`
		Total int64         `bson:"total"`
	}
	if err := gcur.All(ctx, &settled); err != nil {
		return History{}, err
	}
	paidBy := map[bson.ObjectID]int64{}
	for _, row := range settled {
		paidBy[row.ID] = row.Total
	}
	var open *invoice
	for i := range invoices {
		if invoices[i].Status == "OPEN" || invoices[i].Status == "PARTIAL" {
			open = &invoices[i]
			break
		}
	}
	var openPaid, openDue int64
	if open != nil {
		openPaid = paidBy[open.ID]
		openDue = max(0, open.Amount-openPaid)
	}
	var dueBy *time.Time
	if hasSub && sub.DueBy != nil {
		dueBy = sub.DueBy
	} else if openDue > 0 && open != nil {
		dueBy = open.DueAt
	}
	now := time.Now()
	h := History{DocsURL: s.docsURL(), Invoices: []invoiceRow{}, Payments: []paymentRow{}}
	for _, inv := range invoices {
		paid := paidBy[inv.ID]
		label := cycleLabel(inv.Cycle, inv.CycleMonths)
		if inv.Lifetime {
			label = "Lifetime"
		}
		cur := "NPR"
		if inv.Currency != nil {
			cur = *inv.Currency
		}
		by, printed := "platform", inv.InvoiceNumber
		if inv.SoftmatoNo != nil && *inv.SoftmatoNo != "" {
			by, printed = "softmato", *inv.SoftmatoNo
		} else if inv.LocalNo != nil && *inv.LocalNo != "" {
			printed = *inv.LocalNo
		}
		outstanding := max(0, inv.Amount-paid)
		if inv.Status == "VOID" {
			outstanding = 0
		}
		h.Invoices = append(h.Invoices, invoiceRow{inv.Amount, cur, label, s.DocumentURL("invoice", inv.InvoiceNumber), iso(inv.DueAt), inv.InvoiceNumber, iso(inv.IssuedAt), by, outstanding, paid,
			str(inv.PlanID), inv.PlanName, printed, str(inv.SoftmatoNo), inv.Status})
	}
	for _, p := range payments {
		var printed any
		for _, v := range []*string{p.SoftmatoTxNo, p.LocalNo, p.ReceiptNo} {
			if v != nil {
				printed = *v
				break
			}
		}
		var doc any
		if p.Status == "SETTLED" && printed != nil && printed != "" {
			doc = s.DocumentURL("receipt", printed.(string))
		}
		h.Payments = append(h.Payments, paymentRow{p.Amount, doc, p.Method, iso(p.SettledAt), printed, str(p.Provider), str(p.Reference), str(p.ReceiptNo), str(p.SoftmatoTxNo), p.Status})
	}
	if hasSub {
		lifetime := sub.LifetimeSince != nil
		periodEnd := sub.CurrentPeriodEnd
		if lifetime {
			periodEnd = nil
		}
		var label any
		if lifetime {
			label = "Lifetime"
		} else if sub.Cycle != nil {
			label = cycleLabel(*sub.Cycle, sub.CycleMonths)
		}
		var dueFrom any
		if dueBy != nil && open != nil {
			dueFrom = iso(open.IssuedAt)
		}
		var trial any
		if sub.TrialEndsAt != nil && (sub.PlanID == nil || *sub.PlanID == "") {
			trial = iso(sub.TrialEndsAt)
		}
		h.Plan = &planOut{iso(sub.ActivatedAt), openDue, openPaid, str(sub.Cycle), i64(sub.CycleMonths), label, iso(periodEnd), daysLeftThrough(periodEnd, now), daysUntil(dueBy, now), iso(dueBy), dueFrom,
			lifetime, daysSpanned(sub.ActivatedAt, periodEnd), str(sub.PlanID), str(sub.PlanName), i64(sub.CycleTotal), sub.Status, trial}
	}
	return h, nil
}
