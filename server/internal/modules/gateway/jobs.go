package gateway

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/recon"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// The three gateway jobs: gateway-expiry-sweep (ExpireStale), gateway-health
// (daily) and gateway-settlement-recon (weekly). Each hostel's check is one
// reconciliation run; one hostel failing never stops the rest.

const (
	healthWindow     = 7 * 24 * time.Hour
	settlingIn       = 7 * 24 * time.Hour
	degradedRate     = 0.5
	renotifyAfter    = 24 * time.Hour
	reconWindow      = 14 * 24 * time.Hour
	reconRecheckMax  = 200
	reconTriggeredBy = "CRON_SETTLEMENT"
)

type gatewayEntry struct {
	AccountKind      string     `bson:"accountKind"`
	EnabledAt        *time.Time `bson:"enabledAt"`
	HealthNotifiedAt *time.Time `bson:"healthNotifiedAt"`
	HealthStatus     *string    `bson:"healthStatus"`
	LastEventAt      *time.Time `bson:"lastEventAt"`
	MerchantCode     *string    `bson:"merchantCode"`
	Provider         string     `bson:"provider"`
}

// enabled is enabledGateways' test: switched on and usable.
func (g *gatewayEntry) enabled() bool {
	if g.EnabledAt == nil || g.AccountKind == "PERSONAL" {
		return false
	}
	return g.Provider == "KHALTI" || (g.MerchantCode != nil && *g.MerchantCode != "")
}

func (s *Service) gateways(ctx context.Context, hostel bson.ObjectID) ([]gatewayEntry, error) {
	var profile struct {
		Gateways []gatewayEntry `bson:"gateways"`
	}
	err := s.DB.Collection("hostelpaymentprofiles").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "gateways", Value: 1}})).Decode(&profile)
	if err != nil && !isNoDocs(err) {
		return nil, err
	}
	return profile.Gateways, nil
}

// liveHostels is every hostel not deleted, the set both jobs walk.
func (s *Service) liveHostels(ctx context.Context) ([]bson.ObjectID, error) {
	cur, err := s.DB.Collection("hostels").Find(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}, options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := make([]bson.ObjectID, len(rows))
	for i := range rows {
		out[i] = rows[i].ID
	}
	return out, nil
}

type healthCounts struct{ attempts, expired, failed, succeeded, unconfirmed int }

func plural(n int, word string) string {
	if n == 1 {
		return word
	}
	return word + "s"
}

// verdict is the TS verdict, word for word.
func verdict(c healthCounts, enabledFor time.Duration, openInvoices int64) (string, string) {
	days := int(healthWindow / (24 * time.Hour))
	switch {
	case c.unconfirmed > 0 && c.succeeded == 0:
		return fmt.Sprintf("%d payment %s could not be confirmed with the provider at all. Check the merchant details.", c.unconfirmed, plural(c.unconfirmed, "attempt")), "FAILING"
	case c.attempts > 0 && c.succeeded == 0:
		return fmt.Sprintf("%d %s started a payment in the last %d days and none completed.", c.attempts, plural(c.attempts, "resident"), days), "FAILING"
	case c.attempts > 0 && float64(c.succeeded)/float64(c.attempts) < degradedRate:
		return fmt.Sprintf("Only %d of %d payment attempts completed in the last %d days.", c.succeeded, c.attempts, days), "DEGRADED"
	case c.unconfirmed > 0:
		return fmt.Sprintf("%d payment %s could not be confirmed. Payments are otherwise going through.", c.unconfirmed, plural(c.unconfirmed, "attempt")), "DEGRADED"
	case c.succeeded > 0:
		return fmt.Sprintf("%d %s settled in the last %d days.", c.succeeded, plural(c.succeeded, "payment"), days), "HEALTHY"
	case openInvoices > 0 && enabledFor >= settlingIn:
		verb := "are"
		if openInvoices == 1 {
			verb = "is"
		}
		return fmt.Sprintf("No resident has used this to pay in the last %d days, and %d %s %s unpaid. That may be normal, or the button may not be reaching them.", days, openInvoices, plural(int(openInvoices), "invoice"), verb), "QUIET"
	}
	return "Nothing to report.", "HEALTHY"
}

var severity = map[string]int{"DEGRADED": 2, "FAILING": 3, "HEALTHY": 0, "QUIET": 1, "UNKNOWN": 0}

func (s *Service) countIntents(ctx context.Context, hostel bson.ObjectID, provider string, since time.Time) (healthCounts, error) {
	cur, err := s.intents().Find(ctx, bson.D{{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: since}}}, {Key: "hostelId", Value: hostel}, {Key: "provider", Value: provider}},
		options.Find().SetProjection(bson.D{{Key: "failureReason", Value: 1}, {Key: "status", Value: 1}}))
	if err != nil {
		return healthCounts{}, err
	}
	var rows []struct {
		FailureReason string `bson:"failureReason"`
		Status        string `bson:"status"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return healthCounts{}, err
	}
	c := healthCounts{attempts: len(rows)}
	for _, r := range rows {
		switch r.Status {
		case "SUCCEEDED":
			c.succeeded++
		case "FAILED":
			c.failed++
		case "EXPIRED":
			c.expired++
		}
		if r.FailureReason == UnconfirmedReason {
			c.unconfirmed++
		}
	}
	return c, nil
}

// RunGatewayHealth is runGatewayHealth: per hostel, each live gateway's verdict
// is stored on the profile, and a hostel admin is told when it turns bad (or
// stays bad for a day).
func (s *Service) RunGatewayHealth(ctx context.Context, now time.Time, triggeredBy string) ([]ordered.Map, error) {
	hostels, err := s.liveHostels(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]ordered.Map, 0, len(hostels))
	for _, h := range hostels {
		if ctx.Err() != nil {
			return out, ctx.Err()
		}
		checked, notified := 0, 0
		run, rec, err := recon.WithRun(ctx, s.DB, &h, "GATEWAY_HEALTH", triggeredBy, func(rec *recon.Recorder) error {
			var err error
			checked, notified, err = s.healthFor(ctx, h, now, rec)
			return err
		})
		if err != nil {
			out = append(out, ordered.Map{{Key: "checked", Value: 0}, {Key: "findings", Value: 0}, {Key: "hostelId", Value: h.Hex()}, {Key: "notified", Value: 0}, {Key: "runId", Value: ""}, {Key: "status", Value: "FAIL"}})
			continue
		}
		out = append(out, ordered.Map{{Key: "checked", Value: checked}, {Key: "findings", Value: len(rec.Findings)}, {Key: "hostelId", Value: h.Hex()}, {Key: "notified", Value: notified},
			{Key: "runId", Value: run.ID.Hex()}, {Key: "status", Value: run.Status}})
	}
	return out, nil
}

func (s *Service) healthFor(ctx context.Context, hostel bson.ObjectID, now time.Time, rec *recon.Recorder) (int, int, error) {
	entries, err := s.gateways(ctx, hostel)
	if err != nil {
		return 0, 0, err
	}
	var live []gatewayEntry
	for _, e := range entries {
		if _, known := s.Providers[e.Provider]; known && e.enabled() {
			live = append(live, e)
		}
	}
	if len(live) == 0 {
		return 0, 0, nil
	}
	open, err := s.DB.Collection("invoices").CountDocuments(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"OPEN", "OVERDUE", "PARTIAL"}}}}})
	if err != nil {
		return 0, 0, err
	}
	notified := 0
	for _, e := range live {
		counts, err := s.countIntents(ctx, hostel, e.Provider, now.Add(-healthWindow))
		if err != nil {
			return 0, notified, err
		}
		detail, status := verdict(counts, now.Sub(*e.EnabledAt), open)
		rec.Count("checked", 1)
		if status != "HEALTHY" {
			sev := "WARN"
			if status == "QUIET" {
				sev = "INFO"
			}
			rec.Finding(recon.Finding{Code: "GATEWAY_" + status, Detail: e.Provider + ": " + detail, EntityType: "HostelPaymentProfile", Severity: sev})
		}
		previous := "UNKNOWN"
		if e.HealthStatus != nil {
			previous = *e.HealthStatus
		}
		bad := status == "DEGRADED" || status == "FAILING"
		stale := e.HealthNotifiedAt == nil || now.Sub(*e.HealthNotifiedAt) > renotifyAfter
		notify := bad && (severity[status] > severity[previous] || stale)
		set := bson.D{{Key: "gateways.$[slot].healthCheckedAt", Value: now}, {Key: "gateways.$[slot].healthDetail", Value: detail}, {Key: "gateways.$[slot].healthStatus", Value: status}}
		if notify {
			set = append(set, bson.E{Key: "gateways.$[slot].healthNotifiedAt", Value: now})
		}
		if _, err := s.DB.Collection("hostelpaymentprofiles").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}, bson.D{{Key: "$set", Value: set}},
			options.UpdateOne().SetArrayFilters([]any{bson.D{{Key: "slot.provider", Value: e.Provider}}})); err != nil {
			return 0, notified, err
		}
		if notify {
			s.notifyUnhealthy(ctx, hostel, e.Provider, status, detail)
			notified++
		}
	}
	return len(live), notified, nil
}

// notifyUnhealthy is notifyGatewayUnhealthy: an in-app row and a mail to each
// hostel admin. A failure is logged, never the job's.
func (s *Service) notifyUnhealthy(ctx context.Context, hostel bson.ObjectID, provider, status, detail string) {
	name := provider[:1] + strings.ToLower(provider[1:])
	title := name + " payments are having trouble"
	if status == "FAILING" {
		title = name + " payments are not going through"
	}
	var h struct {
		Name string `bson:"name"`
	}
	_ = s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}})).Decode(&h)
	admins, err := residents.HostelAdminContacts(ctx, s.DB, hostel)
	if err != nil {
		slog.WarnContext(ctx, "gateway_health_notification_failed", "category", "payments", "provider", provider, "error", err.Error())
		return
	}
	setup := s.SiteURL + "/hostel-admin/payment-gateways"
	mail := email.GatewayUnhealthy(detail, h.Name, name, setup, title)
	for _, a := range admins {
		if s.Notify != nil && a.UserID != "" {
			if _, err := s.Notify.CreateInApp(ctx, notifications.Input{Body: detail, Category: "PAYMENT", Data: ordered.Map{{Key: "provider", Value: provider}, {Key: "status", Value: status}},
				HostelID: hostel.Hex(), Title: title, UserID: a.UserID}); err != nil {
				slog.WarnContext(ctx, "gateway_health_notification_failed", "category", "payments", "provider", provider, "error", err.Error())
			}
		}
		if s.Mail != nil {
			if r := s.Mail.Send(ctx, email.Message{Category: mail.Category, To: []string{a.Email}, Subject: mail.Subject, HTML: mail.HTML}); !r.Sent {
				slog.WarnContext(ctx, "gateway_unhealthy_email_failed", "category", "payments", "reason", r.Reason)
			}
		}
	}
}

// RunSettlementRecon is runSettlementRecon: over the last 14 days, attempts
// closed unpaid are asked again (a late success is settled now), and every
// succeeded attempt and every gateway credit must point at the other.
func (s *Service) RunSettlementRecon(ctx context.Context, now time.Time, triggeredBy string) ([]ordered.Map, error) {
	if triggeredBy == "" {
		triggeredBy = reconTriggeredBy
	}
	hostels, err := s.liveHostels(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]ordered.Map, 0, len(hostels))
	for _, h := range hostels {
		if ctx.Err() != nil {
			return out, ctx.Err()
		}
		recovered, rechecked := 0, 0
		run, rec, err := recon.WithRun(ctx, s.DB, &h, "GATEWAY_HEALTH", triggeredBy, func(rec *recon.Recorder) error {
			var err error
			recovered, rechecked, err = s.reconFor(ctx, h, now.Add(-reconWindow), rec)
			return err
		})
		if err != nil {
			out = append(out, ordered.Map{{Key: "findings", Value: 0}, {Key: "hostelId", Value: h.Hex()}, {Key: "recovered", Value: 0}, {Key: "rechecked", Value: 0}, {Key: "runId", Value: ""}, {Key: "status", Value: "FAIL"}})
			continue
		}
		out = append(out, ordered.Map{{Key: "findings", Value: len(rec.Findings)}, {Key: "hostelId", Value: h.Hex()}, {Key: "recovered", Value: recovered}, {Key: "rechecked", Value: rechecked},
			{Key: "runId", Value: run.ID.Hex()}, {Key: "status", Value: run.Status}})
	}
	return out, nil
}

func (s *Service) reconFor(ctx context.Context, hostel bson.ObjectID, since time.Time, rec *recon.Recorder) (int, int, error) {
	entries, err := s.gateways(ctx, hostel)
	if err != nil || len(entries) == 0 {
		return 0, 0, err
	}
	live := 0
	for i := range entries {
		if entries[i].enabled() {
			live++
		}
	}
	rec.Count("liveGateways", int64(live))
	recovered, rechecked, err := s.recheckClosed(ctx, hostel, since, rec)
	if err != nil {
		return recovered, rechecked, err
	}
	if err := s.checkSucceeded(ctx, hostel, since, rec); err != nil {
		return recovered, rechecked, err
	}
	return recovered, rechecked, s.checkEvents(ctx, hostel, since, rec)
}

func (s *Service) recheckClosed(ctx context.Context, hostel bson.ObjectID, since time.Time, rec *recon.Recorder) (int, int, error) {
	cur, err := s.intents().Find(ctx, bson.D{{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: since}}}, {Key: "hostelId", Value: hostel}, {Key: "settledEventId", Value: nil},
		{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"EXPIRED", "FAILED"}}}}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(reconRecheckMax))
	if err != nil {
		return 0, 0, err
	}
	var closed []intentRow
	if err := cur.All(ctx, &closed); err != nil {
		return 0, 0, err
	}
	recovered, rechecked := 0, 0
	for i := range closed {
		in := &closed[i]
		if _, ok := s.Providers[in.Provider]; !ok {
			continue
		}
		rechecked++
		out, err := s.Verify(ctx, in.ID, nil, "GATEWAY_POLL")
		if err != nil {
			rec.Count("unreachable", 1)
			continue
		}
		if out.Settled {
			recovered++
			id := in.ID
			rec.Finding(recon.Finding{Code: "SETTLEMENT_RECOVERED", Detail: fmt.Sprintf("%s %s was closed unpaid but the provider reports it succeeded. Settled now, NPR %d.", in.Provider, in.Reference, in.Amount),
				EntityID: &id, EntityType: "PaymentIntent", Severity: "WARN"})
		}
	}
	return recovered, rechecked, nil
}

func (s *Service) checkSucceeded(ctx context.Context, hostel bson.ObjectID, since time.Time, rec *recon.Recorder) error {
	cur, err := s.intents().Find(ctx, bson.D{{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: since}}}, {Key: "hostelId", Value: hostel}, {Key: "status", Value: "SUCCEEDED"}})
	if err != nil {
		return err
	}
	var rows []intentRow
	if err := cur.All(ctx, &rows); err != nil {
		return err
	}
	for i := range rows {
		in := &rows[i]
		id := in.ID
		if in.SettledEventID == nil {
			rec.Finding(recon.Finding{Code: "SETTLED_INTENT_WITHOUT_EVENT", Detail: fmt.Sprintf("%s %s is marked succeeded but points at no ledger entry. The resident has paid NPR %d and the invoice does not know.", in.Provider, in.Reference, in.Amount),
				EntityID: &id, EntityType: "PaymentIntent", Severity: "ERROR"})
			continue
		}
		var ev struct {
			Amount int64 `bson:"amount"`
		}
		err := s.DB.Collection("paymentevents").FindOne(ctx, bson.D{{Key: "_id", Value: *in.SettledEventID}}, options.FindOne().SetProjection(bson.D{{Key: "amount", Value: 1}})).Decode(&ev)
		if isNoDocs(err) {
			rec.Finding(recon.Finding{Code: "SETTLED_INTENT_EVENT_MISSING", Detail: fmt.Sprintf("%s %s points at a ledger entry that does not exist.", in.Provider, in.Reference), EntityID: &id, EntityType: "PaymentIntent", Severity: "ERROR"})
			continue
		}
		if err != nil {
			return err
		}
		if ev.Amount != in.Amount {
			rec.Finding(recon.Finding{Code: "SETTLED_AMOUNT_DISAGREES", Detail: fmt.Sprintf("%s %s raised NPR %d but its ledger entry holds NPR %d.", in.Provider, in.Reference, in.Amount, ev.Amount),
				EntityID: &id, EntityType: "PaymentIntent", Severity: "ERROR"})
		}
	}
	return nil
}

func (s *Service) checkEvents(ctx context.Context, hostel bson.ObjectID, since time.Time, rec *recon.Recorder) error {
	cur, err := s.DB.Collection("paymentevents").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "occurredAt", Value: bson.D{{Key: "$gte", Value: since}}},
		{Key: "provider", Value: bson.D{{Key: "$in", Value: bson.A{"ESEWA", "FONEPAY", "KHALTI"}}}}, {Key: "source", Value: bson.D{{Key: "$in", Value: bson.A{"GATEWAY_POLL", "GATEWAY_WEBHOOK"}}}}, {Key: "status", Value: "SETTLED"}},
		options.Find().SetProjection(bson.D{{Key: "amount", Value: 1}, {Key: "provider", Value: 1}, {Key: "referenceCode", Value: 1}}))
	if err != nil {
		return err
	}
	var events []struct {
		ID            bson.ObjectID `bson:"_id"`
		Amount        int64         `bson:"amount"`
		Provider      string        `bson:"provider"`
		ReferenceCode string        `bson:"referenceCode"`
	}
	if err := cur.All(ctx, &events); err != nil {
		return err
	}
	for _, ev := range events {
		found := false
		if ev.ReferenceCode != "" {
			n, err := s.intents().CountDocuments(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "reference", Value: ev.ReferenceCode}}, options.Count().SetLimit(1))
			if err != nil {
				return err
			}
			found = n > 0
		}
		if !found {
			ref := ""
			if ev.ReferenceCode != "" {
				ref = " (reference " + ev.ReferenceCode + ")"
			}
			id := ev.ID
			rec.Finding(recon.Finding{Code: "GATEWAY_EVENT_WITHOUT_INTENT", Detail: fmt.Sprintf("A settled %s credit of NPR %d has no payment attempt behind it%s.", ev.Provider, ev.Amount, ref),
				EntityID: &id, EntityType: "PaymentEvent", Severity: "ERROR"})
		}
	}
	return nil
}

func isNoDocs(err error) bool { return errors.Is(err, mongo.ErrNoDocuments) }
