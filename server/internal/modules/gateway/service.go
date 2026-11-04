package gateway

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/ledger"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

type Service struct {
	DB          *mongo.Database
	Ledger      *ledger.Engine
	Audit       *audit.Log
	SiteURL     string
	Production  bool
	FinanceKeys func() ([]crypto.MasterKey, error)
	Sandbox     map[string]config.GatewayCredentials
	Providers   map[string]Provider
	Now         func() time.Time
	// Notify and Mail tell hostel admins when a gateway turns unhealthy.
	Notify *notifications.Service
	Mail   *email.Sender
}

const (
	defaultIntentTTL = 15 * time.Minute
	verifyCooldown   = 2 * time.Second
	// An attempt nobody could confirm for a day, through a dozen tries, is closed
	// as unconfirmed rather than retried for ever.
	unconfirmableGrace    = 24 * time.Hour
	unconfirmableAttempts = 12
	// Two residents' taps on one invoice race for the same attempt number; the
	// unique (hostelId, reference) index sends the loser to the next one.
	attemptRetries = 3
)

const UnconfirmedReason = "The payment provider could not be reached to confirm this attempt, so it was never confirmed either way. If money left the resident's account, it needs checking by hand."

func (s *Service) now() time.Time { return s.Now().UTC().Truncate(time.Millisecond) }

func (s *Service) intents() *mongo.Collection { return s.DB.Collection("paymentintents") }

type intentRow struct {
	ID             bson.ObjectID  `bson:"_id"`
	Amount         int64          `bson:"amount"`
	Attempt        int            `bson:"attempt"`
	ExpiresAt      time.Time      `bson:"expiresAt"`
	HostelID       bson.ObjectID  `bson:"hostelId"`
	InvoiceID      bson.ObjectID  `bson:"invoiceId"`
	LastVerifiedAt *time.Time     `bson:"lastVerifiedAt"`
	Mode           string         `bson:"mode"`
	Provider       string         `bson:"provider"`
	ProviderTxnID  *string        `bson:"providerTxnId"`
	Reference      string         `bson:"reference"`
	ResidentID     bson.ObjectID  `bson:"residentId"`
	SettledEventID *bson.ObjectID `bson:"settledEventId"`
	Status         string         `bson:"status"`
	VerifyCount    int            `bson:"verifyCount"`
}

func (s *Service) provider(name string) (Provider, error) {
	if p, ok := s.Providers[name]; ok {
		return p, nil
	}
	return nil, finance.Err("GATEWAY_NOT_CONFIGURED", "Online payment through "+name+" is not available yet.")
}

// Credentials is getGatewayCredentials: the hostel's enabled, eligible gateway and
// its decrypted keys, or the sandbox's keys for a gateway still in test mode.
func (s *Service) Credentials(ctx context.Context, hostel bson.ObjectID, provider string) (Credentials, error) {
	var profile struct {
		Gateways []struct {
			AccountKind  string     `bson:"accountKind"`
			EnabledAt    *time.Time `bson:"enabledAt"`
			MerchantCode *string    `bson:"merchantCode"`
			Mode         string     `bson:"mode"`
			Provider     string     `bson:"provider"`
		} `bson:"gateways"`
	}
	err := s.DB.Collection("hostelpaymentprofiles").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "gateways", Value: 1}})).Decode(&profile)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return Credentials{}, err
	}
	notSetUp := finance.Err("GATEWAY_NOT_CONFIGURED", "This hostel has not completed its payment gateway setup.")
	for _, g := range profile.Gateways {
		if g.Provider != provider {
			continue
		}
		if g.EnabledAt == nil {
			return Credentials{}, notSetUp
		}
		merchant := ""
		if g.MerchantCode != nil {
			merchant = *g.MerchantCode
		}
		if g.AccountKind == "PERSONAL" || (provider != "KHALTI" && merchant == "") {
			return Credentials{}, finance.Err("GATEWAY_NOT_ELIGIBLE", "This payment method is not available for online payment.")
		}
		if g.Mode != "LIVE" {
			if s.Production {
				return Credentials{}, finance.Err("GATEWAY_SANDBOX_IN_PRODUCTION", "This payment method is still in test mode and cannot take real payments.")
			}
			sb, ok := s.Sandbox[provider]
			if !ok {
				return Credentials{}, finance.Err("GATEWAY_NOT_CONFIGURED", fmt.Sprintf("Sandbox credentials for %s are not configured. Set %s_SANDBOX_MERCHANT_CODE and %s_SANDBOX_SECRET.", provider, provider, provider))
			}
			return Credentials{MerchantCode: sb.MerchantCode, Provider: provider, Secret: sb.Secret, WebhookSecret: sb.WebhookSecret, Sandbox: true}, nil
		}
		secret, err := s.readSecret(ctx, hostel, provider, "GATEWAY_SECRET")
		if err != nil {
			return Credentials{}, err
		}
		if secret == "" {
			return Credentials{}, finance.Err("GATEWAY_NOT_CONFIGURED", "This hostel's gateway signing key is missing. Re-enter it in payment setup.")
		}
		webhook, err := s.readSecret(ctx, hostel, provider, "GATEWAY_WEBHOOK_SECRET")
		if err != nil || webhook == "" {
			webhook = secret // a webhook key is optional
		}
		return Credentials{MerchantCode: merchant, Provider: provider, Secret: secret, WebhookSecret: webhook}, nil
	}
	return Credentials{}, notSetUp
}

// readSecret decrypts one EncryptedSecret row; "" when there is none.
func (s *Service) readSecret(ctx context.Context, hostel bson.ObjectID, provider, purpose string) (string, error) {
	var env crypto.Envelope
	err := s.DB.Collection("encryptedsecrets").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "provider", Value: provider}, {Key: "purpose", Value: purpose}}).Decode(&env)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	keys, err := s.FinanceKeys()
	if err != nil {
		return "", err
	}
	plain, err := crypto.DecryptSecret(env, crypto.Scope{HostelID: hostel.Hex(), Purpose: provider + ":" + purpose}, keys)
	if err != nil {
		return "", httpx.NewError(http.StatusInternalServerError, "SECRET_UNREADABLE", crypto.ErrSecretUnreadable.Error(), nil)
	}
	return plain, nil
}

// CreateIntent is createPaymentIntent: one attempt at paying what is left on one
// of the resident's own invoices.
func (s *Service) CreateIntent(ctx context.Context, p *authz.Principal, invoiceRaw, provider string) (ordered.Map, error) {
	r, err := residents.Current(ctx, s.DB, p)
	if err != nil {
		return nil, err
	}
	notFound := finance.Err("INVOICE_NOT_FOUND", "Invoice was not found.")
	invoiceID, err := bson.ObjectIDFromHex(invoiceRaw)
	if err != nil {
		return nil, notFound
	}
	var inv struct {
		ID            bson.ObjectID `bson:"_id"`
		ReferenceCode *string       `bson:"referenceCode"`
		Status        string        `bson:"status"`
		TotalAmount   int64         `bson:"totalAmount"`
	}
	err = s.DB.Collection("invoices").FindOne(ctx, bson.D{{Key: "_id", Value: invoiceID}, {Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}}).Decode(&inv)
	if errors.Is(err, mongo.ErrNoDocuments) || (err == nil && inv.Status == "VOID") {
		return nil, notFound
	}
	if err != nil {
		return nil, err
	}
	if inv.ReferenceCode == nil || *inv.ReferenceCode == "" {
		return nil, finance.Err("REFERENCE_PREFIX_MISSING", "This invoice cannot be paid online. Please use one of the manual methods.")
	}
	var bal struct {
		Settled int64 `bson:"settledAmount"`
	}
	if err := s.DB.Collection("invoicebalances").FindOne(ctx, bson.D{{Key: "invoiceId", Value: inv.ID}}).Decode(&bal); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	amount := inv.TotalAmount - bal.Settled
	if amount <= 0 {
		return nil, finance.Err("INVOICE_ALREADY_PAID", "This invoice is already paid.")
	}
	creds, err := s.Credentials(ctx, r.HostelID, provider)
	if err != nil {
		return nil, err
	}
	adapter, err := s.provider(provider)
	if err != nil {
		return nil, err
	}
	count, err := s.intents().CountDocuments(ctx, bson.D{{Key: "invoiceId", Value: inv.ID}, {Key: "provider", Value: provider}})
	if err != nil {
		return nil, err
	}
	createdBy, _ := bson.ObjectIDFromHex(p.UserID)
	mode := "LIVE"
	if creds.Sandbox {
		mode = "SANDBOX"
	}
	for try := 0; ; try++ {
		attempt := int(count) + 1 + try
		reference := *inv.ReferenceCode + "-" + strconv.Itoa(attempt)
		intent, err := adapter.CreateIntent(ctx, IntentRequest{Amount: amount, Attempt: attempt, Credentials: creds,
			CallbackURL: s.SiteURL + "/api/v1/webhooks/" + lower(provider),
			FailureURL:  s.SiteURL + "/resident/payments/checkout/" + reference + "?outcome=failed",
			Reference:   reference, ReferenceCode: *inv.ReferenceCode,
			ReturnURL: s.SiteURL + "/resident/payments/checkout/" + reference})
		if err != nil {
			return nil, err
		}
		expires := intent.ExpiresAt
		if expires.IsZero() {
			expires = s.Now().Add(defaultIntentTTL)
		}
		expires = expires.UTC().Truncate(time.Millisecond)
		at := s.now()
		id := bson.NewObjectID()
		_, err = s.intents().InsertOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}, {Key: "invoiceId", Value: inv.ID},
			{Key: "provider", Value: provider}, {Key: "mode", Value: mode}, {Key: "reference", Value: reference}, {Key: "attempt", Value: attempt}, {Key: "amount", Value: amount},
			{Key: "status", Value: "CREATED"}, {Key: "providerTxnId", Value: intent.ProviderRef}, {Key: "expiresAt", Value: expires}, {Key: "verifyCount", Value: 0},
			{Key: "settledEventId", Value: nil}, {Key: "createdBy", Value: createdBy}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}})
		if mongo.IsDuplicateKeyError(err) && try < attemptRetries {
			continue
		}
		if err != nil {
			return nil, err
		}
		return ordered.Map{{Key: "amount", Value: amount}, {Key: "expiresAt", Value: expires.Format("2006-01-02T15:04:05.000Z")}, {Key: "handoff", Value: intent.Handoff},
			{Key: "intentId", Value: id.Hex()}, {Key: "provider", Value: provider}, {Key: "reference", Value: reference}, {Key: "sandbox", Value: creds.Sandbox}, {Key: "status", Value: "CREATED"}}, nil
	}
}

func lower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

// Outcome is VerifyOutcome.
type Outcome struct {
	EventID  *string
	Reason   *string
	Settled  bool
	Status   string
	IntentID *string
}

// Verify is verifyPaymentIntent: the provider's own API decides, and only an
// exact amount settles.
func (s *Service) Verify(ctx context.Context, id bson.ObjectID, actor *authz.Principal, source string) (Outcome, error) {
	var in intentRow
	if err := s.intents().FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&in); errors.Is(err, mongo.ErrNoDocuments) {
		return Outcome{}, finance.Err("INTENT_NOT_FOUND", "Payment attempt was not found.")
	} else if err != nil {
		return Outcome{}, err
	}
	if in.Status == "SUCCEEDED" && in.SettledEventID != nil {
		ev := in.SettledEventID.Hex()
		return Outcome{EventID: &ev, Settled: true, Status: "SUCCEEDED"}, nil
	}
	creds, err := s.Credentials(ctx, in.HostelID, in.Provider)
	if err != nil {
		return Outcome{}, err
	}
	adapter, err := s.provider(in.Provider)
	if err != nil {
		return Outcome{}, err
	}
	result, verr := adapter.Verify(ctx, in.Amount, in.ProviderTxnID, in.Reference, creds)
	at := s.now()
	set := bson.D{{Key: "lastVerifiedAt", Value: at}, {Key: "updatedAt", Value: at}}
	if verr == nil && result.ProviderTxnID != "" {
		set = append(set, bson.E{Key: "providerTxnId", Value: result.ProviderTxnID})
	}
	if _, err := s.intents().UpdateOne(ctx, bson.D{{Key: "_id", Value: in.ID}}, bson.D{{Key: "$inc", Value: bson.D{{Key: "verifyCount", Value: 1}}}, {Key: "$set", Value: set}}); err != nil {
		return Outcome{}, err
	}
	if verr != nil {
		var known *httpx.Error // the adapter's own words (unreachable, refused)
		if errors.As(verr, &known) {
			return Outcome{}, verr
		}
		return Outcome{}, finance.Err("GATEWAY_UNREACHABLE", "Could not reach the payment provider. Please try again in a moment.")
	}
	if result.Status != "SUCCESS" {
		status := in.Status
		if result.Status == "FAILED" {
			if err := s.close(ctx, in.ID, "FAILED", "The provider reported a failed payment."); err != nil {
				return Outcome{}, err
			}
			status = "FAILED"
		}
		return Outcome{Status: status}, nil
	}
	if result.Amount != in.Amount {
		reason := fmt.Sprintf("Provider reported NPR %s for an attempt raised at NPR %d. Not settled — review manually.", amountText(result.Amount), in.Amount)
		if err := s.close(ctx, in.ID, "FAILED", reason); err != nil {
			return Outcome{}, err
		}
		actorID, role := bson.ObjectID{}, "SYSTEM"
		if actor != nil {
			actorID, _ = bson.ObjectIDFromHex(actor.UserID)
			role = string(actor.Role)
		}
		if err := s.Audit.WriteFinance(ctx, actorID, role, audit.Finance{Action: "GATEWAY_AMOUNT_MISMATCH", AmountAfter: max(result.Amount, 0), AmountBefore: in.Amount,
			EntityID: in.ID.Hex(), EntityType: "PaymentIntent", HostelID: in.HostelID, InvoiceID: in.InvoiceID.Hex(), Reason: reason, Source: "GATEWAY_VERIFICATION"}); err != nil {
			slog.WarnContext(ctx, "gateway_mismatch_audit_failed", "intentId", in.ID.Hex(), "error", err.Error())
		}
		return Outcome{Reason: &reason, Status: "FAILED"}, nil
	}
	invoice, resident := in.InvoiceID, in.ResidentID
	ev, created, err := s.Ledger.AppendEvent(ctx, ledger.AppendInput{Amount: result.Amount, Confirmation: "GATEWAY_VERIFIED", HostelID: in.HostelID,
		IdempotencyKey: "gateway:" + in.Provider + ":" + result.ProviderTxnID, InvoiceID: &invoice, OccurredAt: at, Provider: in.Provider,
		ProviderTxnID: result.ProviderTxnID, ReferenceCode: in.Reference, ResidentID: &resident, Source: source, Status: "PENDING"})
	if err != nil {
		return Outcome{}, err
	}
	eventID := ev.ID.Hex()
	// An event that already existed is settled here too when it is still PENDING:
	// a call that died between the append and the settle left exactly that, and
	// TS marked the attempt SUCCEEDED over a payment that never reached the
	// invoice (P8-6).
	var settled *ledger.Settled
	if created || ev.Status == "PENDING" {
		settled, err = s.Ledger.SettleEvent(ctx, ev.ID, ledger.SettleOptions{Confirmation: "GATEWAY_VERIFIED", Principal: actor, SettledAt: at})
		if err != nil && !errors.Is(err, ledger.ErrNotPending) {
			return Outcome{}, err
		}
	}
	if err := s.markSucceeded(ctx, &in, ev.ID, at); err != nil {
		return Outcome{}, err
	}
	if settled != nil {
		s.notify(ctx, &in, result.Amount, settled)
	}
	return Outcome{EventID: &eventID, Settled: true, Status: "SUCCEEDED"}, nil
}

func amountText(n int64) string {
	if n < 0 {
		return "NaN"
	}
	return strconv.FormatInt(n, 10)
}

func (s *Service) notify(ctx context.Context, in *intentRow, amount int64, settled *ledger.Settled) {
	var inv struct {
		Period *string `bson:"period"`
		Total  int64   `bson:"totalAmount"`
	}
	if err := s.DB.Collection("invoices").FindOne(ctx, bson.D{{Key: "_id", Value: in.InvoiceID}}).Decode(&inv); err != nil {
		slog.WarnContext(ctx, "gateway_payment_notification_failed", "intentId", in.ID.Hex(), "message", err.Error())
		return
	}
	var paid int64
	if settled.Balance != nil {
		paid = settled.Balance.SettledAmount
	}
	invoice := in.InvoiceID
	s.Ledger.NotifyClaimReviewed(ctx, ledger.ClaimReview{HostelID: in.HostelID, ResidentID: in.ResidentID, InvoiceID: &invoice, Kind: "verified", Period: inv.Period,
		Receipt: settled.Receipt, Remaining: max(inv.Total-paid, 0), Verified: amount})
}

func (s *Service) markSucceeded(ctx context.Context, in *intentRow, event bson.ObjectID, at time.Time) error {
	if _, err := s.intents().UpdateOne(ctx, bson.D{{Key: "_id", Value: in.ID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "lastVerifiedAt", Value: at}, {Key: "settledEventId", Value: event}, {Key: "status", Value: "SUCCEEDED"}, {Key: "updatedAt", Value: at}}}}); err != nil {
		return err
	}
	s.touch(ctx, in.HostelID, in.Provider)
	return nil
}

// close moves a still-open attempt to EXPIRED or FAILED; a settled one is left alone.
func (s *Service) close(ctx context.Context, id bson.ObjectID, status, reason string) error {
	_, err := s.intents().UpdateOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "status", Value: "CREATED"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "failureReason", Value: reason}, {Key: "status", Value: status}, {Key: "updatedAt", Value: s.now()}}}})
	return err
}

// touch stamps the gateway's lastEventAt; best effort, as TS's .catch.
func (s *Service) touch(ctx context.Context, hostel bson.ObjectID, provider string) {
	_, err := s.DB.Collection("hostelpaymentprofiles").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: hostel}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "gateways.$[slot].lastEventAt", Value: s.now()}}}},
		options.UpdateOne().SetArrayFilters([]any{bson.D{{Key: "slot.provider", Value: provider}}}))
	if err != nil {
		slog.WarnContext(ctx, "gateway_activity_touch_failed", "hostelId", hostel.Hex(), "error", err.Error())
	}
}

// CheckoutStatus is getCheckoutStatus: the return page's poll. It asks the
// provider at most once per cooldown while the attempt is open.
func (s *Service) CheckoutStatus(ctx context.Context, p *authz.Principal, reference string) (ordered.Map, error) {
	r, err := residents.Current(ctx, s.DB, p)
	if err != nil {
		return nil, err
	}
	var in intentRow
	if err := s.intents().FindOne(ctx, bson.D{{Key: "hostelId", Value: r.HostelID}, {Key: "reference", Value: reference}, {Key: "residentId", Value: r.ID}}).Decode(&in); errors.Is(err, mongo.ErrNoDocuments) {
		return nil, finance.Err("INTENT_NOT_FOUND", "Payment attempt was not found.")
	} else if err != nil {
		return nil, err
	}
	status, settled := in.Status, in.SettledEventID != nil
	if status == "CREATED" && (in.LastVerifiedAt == nil || s.Now().Sub(*in.LastVerifiedAt) > verifyCooldown) {
		// A provider that cannot answer yet is not the resident's error: the page
		// polls again.
		if out, err := s.Verify(ctx, in.ID, nil, "GATEWAY_POLL"); err == nil {
			settled, status = out.Settled, out.Status
		}
	}
	return ordered.Map{{Key: "amount", Value: in.Amount}, {Key: "expiresAt", Value: in.ExpiresAt.UTC().Format("2006-01-02T15:04:05.000Z")}, {Key: "invoiceId", Value: in.InvoiceID.Hex()},
		{Key: "provider", Value: in.Provider}, {Key: "reference", Value: in.Reference}, {Key: "sandbox", Value: in.Mode == "SANDBOX"}, {Key: "settled", Value: settled}, {Key: "status", Value: status}}, nil
}

// Callback is handleProviderCallback. The reference is read unverified only to
// find whose keys check the signature; nothing is trusted until Verify asks the
// provider.
func (s *Service) Callback(ctx context.Context, provider, raw string, headers map[string]string) (Outcome, error) {
	adapter, err := s.provider(provider)
	if err != nil {
		return Outcome{}, err
	}
	reference := adapter.Reference(raw)
	if reference == "" {
		return Outcome{Status: "UNKNOWN"}, nil
	}
	var in intentRow
	if err := s.intents().FindOne(ctx, bson.D{{Key: "provider", Value: provider}, {Key: "reference", Value: reference}}).Decode(&in); errors.Is(err, mongo.ErrNoDocuments) {
		return Outcome{Status: "UNKNOWN"}, nil
	} else if err != nil {
		return Outcome{}, err
	}
	creds, err := s.Credentials(ctx, in.HostelID, provider)
	if err != nil {
		return Outcome{}, err
	}
	if adapter.ParseWebhook(raw, headers, creds) == nil {
		return Outcome{}, finance.Err("GATEWAY_VERIFICATION_FAILED", "The callback signature did not verify.")
	}
	s.touch(ctx, in.HostelID, provider)
	out, err := s.Verify(ctx, in.ID, nil, "GATEWAY_WEBHOOK")
	if err != nil {
		return Outcome{}, err
	}
	id := in.ID.Hex()
	out.IntentID = &id
	return out, nil
}

// ExpireStale is expireStaleIntents, for the gateway-expiry-sweep job: every
// attempt past its window is asked once more, then closed.
func (s *Service) ExpireStale(ctx context.Context, limit int64, now time.Time) (expired, settled, unconfirmed int, err error) {
	if limit <= 0 {
		limit = 100
	}
	cur, err := s.intents().Find(ctx, bson.D{{Key: "expiresAt", Value: bson.D{{Key: "$lt", Value: now}}}, {Key: "status", Value: "CREATED"}},
		options.Find().SetSort(bson.D{{Key: "expiresAt", Value: 1}}).SetLimit(limit))
	if err != nil {
		return 0, 0, 0, err
	}
	var stale []intentRow
	if err := cur.All(ctx, &stale); err != nil {
		return 0, 0, 0, err
	}
	for i := range stale {
		if ctx.Err() != nil {
			return expired, settled, unconfirmed, ctx.Err()
		}
		in := &stale[i]
		out, verr := s.Verify(ctx, in.ID, nil, "GATEWAY_POLL")
		if verr == nil && out.Settled {
			settled++
			continue
		}
		if verr != nil {
			if now.Sub(in.ExpiresAt) > unconfirmableGrace && in.VerifyCount >= unconfirmableAttempts {
				if err := s.close(ctx, in.ID, "EXPIRED", UnconfirmedReason); err != nil {
					return expired, settled, unconfirmed, err
				}
				unconfirmed++
			}
			continue
		}
		if err := s.close(ctx, in.ID, "EXPIRED", "The payment window closed with no payment."); err != nil {
			return expired, settled, unconfirmed, err
		}
		expired++
	}
	return expired, settled, unconfirmed, nil
}
