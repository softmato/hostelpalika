package billing

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// webhookMaxAge is the SDK's MAX_AGE_SECONDS: older is a replay, not a delivery.
const webhookMaxAge = 300

// WebhookPayload is Softmato's delivery body. Amount is paisa.
type WebhookPayload struct {
	Event         string  `json:"event"`
	TransactionID string  `json:"transaction_id"`
	InvoiceID     string  `json:"invoice_id"`
	Amount        float64 `json:"amount"`
	Currency      string  `json:"currency"`
	Status        string  `json:"status"`
	OccurredAt    string  `json:"occurred_at"`
}

// VerifyWebhook is the SDK's verifyWebhook over the raw bytes: the signature is
// HMAC-SHA256(secret, "<timestamp>.<body>") in hex, and the timestamp must be
// within five minutes either way. Returns the reason on failure.
func VerifyWebhook(body []byte, secret, signature, timestamp string, now time.Time) (*WebhookPayload, string) {
	if signature == "" {
		return nil, "missing_signature"
	}
	raw := strings.TrimSpace(timestamp)
	if raw == "" {
		return nil, "malformed_timestamp"
	}
	// Number(raw) then Number.isInteger: "1.0" and "1e3" are integers there too.
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil || f != math.Trunc(f) || math.IsInf(f, 0) {
		return nil, "malformed_timestamp"
	}
	ts := int64(f)
	age := now.Unix() - ts
	if age > webhookMaxAge {
		return nil, "timestamp_too_old"
	}
	if age < -webhookMaxAge {
		return nil, "timestamp_in_future"
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(ts, 10) + "." + string(body)))
	if !hmac.Equal([]byte(hex.EncodeToString(mac.Sum(nil))), []byte(signature)) {
		return nil, "signature_mismatch"
	}
	var p WebhookPayload
	if err := json.Unmarshal(body, &p); err != nil {
		// TS threw here and answered 500, which Softmato retries forever; a
		// signed body that is not JSON will not parse on the next attempt either.
		return nil, "malformed_body"
	}
	return &p, ""
}

// classify is softmato/transaction's: anything not SUCCEEDED, CREATED/PENDING
// or RECONCILIATION_REQUIRED is not completed, so a new status never settles.
func classify(status string) string {
	switch strings.ToUpper(status) {
	case "SUCCEEDED":
		return "settled"
	case "CREATED", "PENDING":
		return "pending"
	case "RECONCILIATION_REQUIRED":
		return "under_review"
	}
	return "not_completed"
}

// paisaToRupees refuses what the rupee schema cannot hold.
func paisaToRupees(paisa float64) (int64, error) {
	if paisa != math.Trunc(paisa) {
		return 0, fmt.Errorf("Softmato reported a fractional paisa amount: %v", paisa)
	}
	if math.Mod(paisa, 100) != 0 {
		return 0, fmt.Errorf("Softmato reported %v paisa, which is not a whole number of rupees", paisa)
	}
	return int64(paisa / 100), nil
}

// Webhooks is POST /webhooks/softmato.
type Webhooks struct {
	Settler *Settler
	Secret  string // SOFTMATO_WEBHOOK_SECRET
	// SettleBooking is settleBookingFromSoftmato for a booking fee's invoice:
	// found=false when no booking carries that number.
	SettleBooking func(ctx context.Context, invoiceNo string) (outcome, bookingID string, found bool, err error)
}

func (w *Webhooks) Register(v1 *gin.RouterGroup) { v1.POST("/webhooks/softmato", w.softmato) }

// WebhookResult is applyWebhook's answer.
type WebhookResult struct {
	Action    string // settled, already_settled, recorded, ignored
	PaymentID string
	Event     string
	Reason    string
}

func (w *Webhooks) softmato(c *gin.Context) {
	text := func(status int, body string) { c.Data(status, "text/plain;charset=UTF-8", []byte(body)) }
	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		text(http.StatusBadRequest, "unreadable_body")
		return
	}
	// No secret is a 503: the delivery may be genuine, and a 4xx would let
	// Softmato's retry queue give up on a payment we cannot check yet.
	if w.Secret == "" {
		slog.WarnContext(c, "softmato_webhook_rejected", "category", "payments", "reason", "secret not set")
		text(http.StatusServiceUnavailable, "SOFTMATO_WEBHOOK_SECRET is not set on this deployment")
		return
	}
	payload, reason := VerifyWebhook(raw, w.Secret, c.GetHeader("x-softmato-signature"), c.GetHeader("x-softmato-timestamp"), w.Settler.Now())
	if payload == nil {
		slog.WarnContext(c, "softmato_webhook_rejected", "category", "payments", "reason", reason)
		text(http.StatusBadRequest, reason)
		return
	}
	res, err := w.Apply(c, payload)
	if err != nil {
		// Genuine and unhandled: a 500 keeps Softmato retrying, so a brief
		// outage never costs a hostel the plan it paid for.
		slog.ErrorContext(c, "softmato_webhook_failed", "category", "payments", "event", payload.Event, "transactionId", payload.TransactionID, "err", err)
		text(http.StatusInternalServerError, "retry")
		return
	}
	level := slog.LevelInfo
	if res.Action == "ignored" {
		level = slog.LevelWarn
	}
	slog.Log(c, level, "softmato_webhook_handled", "category", "payments", "event", payload.Event, "outcome", res.Action, "transactionId", payload.TransactionID)
	httpx.Bare(c, http.StatusOK, ordered.Map{{Key: "received", Value: true}, {Key: "outcome", Value: res.Action}})
}

// Apply is applyWebhook: a verified delivery turned into a settled payment,
// exactly once however many times it arrives.
func (w *Webhooks) Apply(ctx context.Context, p *WebhookPayload) (WebhookResult, error) {
	s := w.Settler
	pays := s.DB.Collection("subscriptionpayments")
	now := s.now()
	// Cash a Softmato admin rejected: the row that was waiting for it closes.
	if p.Event == "payment.failed" {
		if _, err := pays.UpdateOne(ctx, bson.D{{Key: "softmatoTransactionNo", Value: p.TransactionID}, {Key: "status", Value: "PENDING"}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "FAILED"}, {Key: "updatedAt", Value: now}}}}); err != nil {
			return WebhookResult{}, err
		}
	}
	// Both: the label says what happened, the status where it ended up.
	if classify(p.Status) != "settled" || p.Event != "payment.success" {
		return WebhookResult{Action: "recorded", Event: p.Event}, nil
	}
	var inv struct {
		ID             bson.ObjectID `bson:"_id"`
		HostelID       bson.ObjectID `bson:"hostelId"`
		SubscriptionID bson.ObjectID `bson:"subscriptionId"`
	}
	err := s.DB.Collection("subscriptioninvoices").FindOne(ctx, bson.D{{Key: "$or", Value: bson.A{
		bson.D{{Key: "softmatoInvoiceNo", Value: p.InvoiceID}}, bson.D{{Key: "softmatoBalanceInvoices.no", Value: p.InvoiceID}}}}},
		options.FindOne().SetProjection(bson.D{{Key: "hostelId", Value: 1}, {Key: "subscriptionId", Value: 1}})).Decode(&inv)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return WebhookResult{}, err
	}
	if err == nil {
		amount, err := paisaToRupees(p.Amount)
		if err != nil {
			return WebhookResult{}, err
		}
		return s.RecordSoftmatoPayment(ctx, inv.ID, inv.HostelID, inv.SubscriptionID, p.TransactionID, amount)
	}
	// Not a plan: a booking fee.
	if w.SettleBooking != nil {
		outcome, id, found, err := w.SettleBooking(ctx, p.InvoiceID)
		if err != nil {
			return WebhookResult{}, err
		}
		if found {
			if outcome == "paid" {
				return WebhookResult{Action: "settled", PaymentID: id}, nil
			}
			return WebhookResult{Action: "recorded", Event: "booking_" + outcome}, nil
		}
	} else if n, err := s.DB.Collection("bookings").CountDocuments(ctx, bson.D{{Key: "softmatoInvoiceNo", Value: p.InvoiceID}}, options.Count().SetLimit(1)); err != nil || n > 0 {
		// ponytail: booking settlement is not wired yet, so its delivery is left for
		// Softmato to retry rather than answered as ignored.
		if err == nil {
			err = errors.New("booking settlement is not wired")
		}
		return WebhookResult{}, err
	}
	// A team agent's pre-publish payment: marked paid; the invoice written at
	// publish adopts it.
	var pre struct {
		ID bson.ObjectID `bson:"_id"`
	}
	err = s.DB.Collection("teamprepayments").FindOne(ctx, bson.D{{Key: "softmatoInvoiceNo", Value: p.InvoiceID}}, options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Decode(&pre)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return WebhookResult{}, err
	}
	if err == nil {
		tx := p.TransactionID
		if err := s.MarkTeamPrepaymentPaid(ctx, pre.ID, now, nil, &tx); err != nil {
			return WebhookResult{}, err
		}
		return WebhookResult{Action: "recorded", Event: "team_prepayment_paid"}, nil
	}
	// Answered 2xx anyway: an unknown number will not be known on the fourth retry.
	return WebhookResult{Action: "ignored", Reason: "no invoice for that number"}, nil
}

// RecordSoftmatoPayment is recordSoftmatoPayment: one Softmato payment, recorded
// once, from a webhook or from a server-side invoice read.
func (s *Settler) RecordSoftmatoPayment(ctx context.Context, invoiceID, hostelID, subscriptionID bson.ObjectID, transactionNo string, amount int64) (WebhookResult, error) {
	pays := s.DB.Collection("subscriptionpayments")
	now := s.now()
	// Attach the transaction to the attempt waiting for it. The number is
	// uniquely indexed, so this is a claim: a concurrent second matches nothing.
	if err := pays.FindOneAndUpdate(ctx, bson.D{{Key: "invoiceId", Value: invoiceID}, {Key: "softmatoTransactionNo", Value: nil}, {Key: "status", Value: "PENDING"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "amount", Value: amount}, {Key: "softmatoTransactionNo", Value: transactionNo}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetSort(bson.D{{Key: "createdAt", Value: -1}})).Err(); err != nil && !errors.Is(err, mongo.ErrNoDocuments) && !mongo.IsDuplicateKeyError(err) {
		return WebhookResult{}, err
	}
	type row struct {
		ID     bson.ObjectID `bson:"_id"`
		Status string        `bson:"status"`
	}
	find := func() (*row, error) {
		var r row
		err := pays.FindOne(ctx, bson.D{{Key: "softmatoTransactionNo", Value: transactionNo}}).Decode(&r)
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil
		}
		return &r, err
	}
	attached, err := find()
	if err != nil {
		return WebhookResult{}, err
	}
	if attached == nil {
		// Counted already by a server-side read that could not name the
		// transaction: label that row rather than count the money twice.
		var reconciled row
		err := pays.FindOneAndUpdate(ctx, bson.D{{Key: "amount", Value: amount}, {Key: "invoiceId", Value: invoiceID}, {Key: "method", Value: "SOFTMATO"},
			{Key: "softmatoTransactionNo", Value: nil}, {Key: "status", Value: "SETTLED"}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "softmatoTransactionNo", Value: transactionNo}, {Key: "updatedAt", Value: now}}}},
			options.FindOneAndUpdate().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetReturnDocument(options.After)).Decode(&reconciled)
		if err == nil {
			return WebhookResult{Action: "already_settled", PaymentID: reconciled.ID.Hex()}, nil
		}
		if !errors.Is(err, mongo.ErrNoDocuments) && !mongo.IsDuplicateKeyError(err) {
			return WebhookResult{}, err
		}
		// No attempt to attach to is legitimate (paid from another device):
		// the money arrived, so the row is made from the payload.
		id := bson.NewObjectID()
		_, err = pays.InsertOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "amount", Value: amount}, {Key: "currency", Value: "NPR"}, {Key: "hostelId", Value: hostelID},
			{Key: "invoiceId", Value: invoiceID}, {Key: "isMocked", Value: false}, {Key: "method", Value: "SOFTMATO"}, {Key: "softmatoTransactionNo", Value: transactionNo},
			{Key: "status", Value: "PENDING"}, {Key: "subscriptionId", Value: subscriptionID}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}})
		switch {
		case err == nil:
			attached = &row{ID: id, Status: "PENDING"}
		case mongo.IsDuplicateKeyError(err):
			// A concurrent delivery made it first (TS answered 500 and waited for the retry).
			if attached, err = find(); err != nil || attached == nil {
				return WebhookResult{}, errors.Join(err, errors.New("payment row vanished after a duplicate key"))
			}
		default:
			return WebhookResult{}, err
		}
	}
	if attached.Status == "SETTLED" {
		return WebhookResult{Action: "already_settled", PaymentID: attached.ID.Hex()}, nil
	}
	if _, err := s.SettlePayment(ctx, attached.ID, SettleOptions{}); err != nil {
		return WebhookResult{}, err
	}
	return WebhookResult{Action: "settled", PaymentID: attached.ID.Hex()}, nil
}

// MarkTeamPrepaymentPaid is markTeamPrepaymentPaid: OPEN → PAID once; a later
// delivery only fills in a missing transaction number.
func (s *Settler) MarkTeamPrepaymentPaid(ctx context.Context, id bson.ObjectID, paidAt time.Time, provider, transactionNo *string) error {
	coll := s.DB.Collection("teamprepayments")
	now := s.now()
	var paid struct {
		Amount        int64  `bson:"amount"`
		ChargeAmount  *int64 `bson:"chargeAmount"`
		InvoiceNumber string `bson:"invoiceNumber"`
	}
	err := coll.FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: id}, {Key: "status", Value: "OPEN"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "paidAt", Value: paidAt}, {Key: "provider", Value: provider}, {Key: "transactionNo", Value: transactionNo}, {Key: "status", Value: "PAID"}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&paid)
	if err == nil {
		charge := paid.Amount
		if paid.ChargeAmount != nil {
			charge = *paid.ChargeAmount
		}
		var tx any = bson.Null{}
		if transactionNo != nil {
			tx = *transactionNo
		}
		return s.Audit.Write(ctx, audit.Entry{ActorType: "SYSTEM", Action: "TEAM_PREPAYMENT_PAID", EntityType: "TeamPrepayment", EntityID: id.Hex(),
			Metadata: bson.D{{Key: "amount", Value: charge}, {Key: "invoiceNumber", Value: paid.InvoiceNumber}, {Key: "transactionNo", Value: tx}}})
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		return err
	}
	if transactionNo != nil {
		_, err = coll.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "status", Value: "PAID"}, {Key: "transactionNo", Value: nil}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "transactionNo", Value: *transactionNo}, {Key: "updatedAt", Value: now}}}})
		return err
	}
	return nil
}
