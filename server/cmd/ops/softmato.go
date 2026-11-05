package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/softmato"
)

var localBase = regexp.MustCompile(`^https?://(localhost|127\.0\.0\.1|[^/]*\.localhost)(:|/|$)`)

// checkSoftmato is dev-check-softmato.mjs against this API: a LOCAL Softmato
// raises, checks out and reads back an invoice; the API's webhook refuses
// unsigned, forged and stale deliveries, settles a genuine one once, and a
// repeat issues nothing new. Never runs against production or a remote Softmato.
func checkSoftmato(ctx context.Context, e env, args []string) error {
	fs := flag.NewFlagSet("check-softmato", flag.ContinueOnError)
	api := fs.String("api", "http://127.0.0.1:8080", "base URL of the running Go API")
	if err := fs.Parse(args); err != nil {
		return err
	}
	s := e.cfg.Softmato
	switch {
	case e.cfg.IsProduction():
		return errors.New("refusing to run against a production environment")
	case s.BaseURL == "" || s.Secret == "" || s.WebhookSecret == "":
		return errors.New("SOFTMATO_BASE_URL, SOFTMATO_SECRET and SOFTMATO_WEBHOOK_SECRET must all be set")
	case !localBase.MatchString(s.BaseURL):
		return fmt.Errorf("SOFTMATO_BASE_URL is %s, which is not a local deployment: a Sandbox credential pointed anywhere else takes real money through the real gateways", s.BaseURL)
	}
	client := softmato.New(s.BaseURL, s.Secret, s.WebhookSecret)
	passed, failed := 0, 0
	check := func(label string, ok bool, detail string) {
		if ok {
			passed++
			fmt.Println("  ok    " + label)
			return
		}
		failed++
		if detail != "" {
			label += " — " + detail
		}
		fmt.Println("  FAIL  " + label)
	}

	stamp := strconv.FormatInt(time.Now().UnixMilli(), 10)
	invoiceNumber := "SUB-CHK" + stamp
	fmt.Println("\nRAISING AN INVOICE")
	raise := softmato.CreateInvoice{
		Customer:    softmato.Customer{Email: "owner@example.com", ExternalRef: "hh-hostel:check-" + stamp, Name: "Sunrise Hostel"},
		ExternalRef: "hh-sub:" + invoiceNumber,
		Lines:       []softmato.InvoiceLine{{Description: "Pro — Annual", Quantity: 1, UnitPriceMinor: 5_000_00}},
		Presentation: &softmato.Presentation{BillingPeriod: "12 months", PlanName: "Pro — Annual", Tagline: "A full house, or two floors of one.",
			Features:   []string{"Up to 100 residents", "2 warden accounts", "3 cook accounts", "Platinum hostel badge in the public directory"},
			Highlights: []string{"Ranked above unbadged listings"}},
	}
	invoice, err := client.CreateInvoice(ctx, raise)
	if err != nil {
		return fmt.Errorf("raise invoice: %w", err)
	}
	invoiceNo := invoice.InvoiceID
	if invoice.InvoiceNo != nil {
		invoiceNo = *invoice.InvoiceNo
	}
	check("invoice raised", invoiceNo != "", "")
	fmt.Println("        " + invoiceNo)
	again, err := client.CreateInvoice(ctx, raise)
	if err != nil {
		return fmt.Errorf("raise again: %w", err)
	}
	againNo := again.InvoiceID
	if again.InvoiceNo != nil {
		againNo = *again.InvoiceNo
	}
	check("a repeated external_ref returns the same invoice, not a second one", againNo == invoiceNo, againNo+" vs "+invoiceNo)

	fmt.Println("\nOPENING A CHECKOUT")
	returnURL := e.cfg.AppURL + "/register-hostel/return?invoice=" + url.QueryEscape(invoiceNumber)
	session, err := client.CreateCheckout(ctx, invoice.InvoiceID, returnURL)
	if err != nil {
		return fmt.Errorf("checkout: %w", err)
	}
	check("checkout session opened", session.CheckoutURL != "", "")
	check("the return_url passed the registered-domain allowlist", session.SessionID != "", returnURL)
	fmt.Printf("        %s\n        providers: %s\n        expires:   %s\n", session.CheckoutURL, strings.Join(session.AllowedProviders, ", "), session.ExpiresAt)

	fmt.Println("\nREADING THE INVOICE BACK")
	detail, err := client.GetInvoice(ctx, invoiceNo)
	if err != nil {
		return fmt.Errorf("read back: %w", err)
	}
	check("invoice reads back", detail.InvoiceID == invoice.InvoiceID, detail.InvoiceID)
	check("our plan copy is echoed on it", detail.Presentation != nil && detail.Presentation.PlanName == "Pro — Annual", "")
	check("the features we sent survived", detail.Presentation != nil && len(detail.Presentation.Features) == 4, "")
	check("it is unpaid until somebody pays it", detail.Status != "paid", detail.Status)
	file, err := client.Download(ctx, "invoices", invoiceNo)
	if err != nil {
		return fmt.Errorf("download: %w", err)
	}
	check("the document downloads", file != nil && len(file.Bytes) > 0, "")
	if file != nil {
		fmt.Printf("        %s %s\n", file.ContentType, file.Fallback)
	}

	fmt.Println("\nOUR WEBHOOK ENDPOINT")
	endpoint := strings.TrimRight(*api, "/") + "/api/v1/webhooks/softmato"
	deliver := func(body []byte, secret string, ts int64, sign bool) (int, string) {
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		if sign {
			mac := hmac.New(sha256.New, []byte(secret))
			fmt.Fprintf(mac, "%d.%s", ts, body)
			req.Header.Set("x-softmato-signature", hex.EncodeToString(mac.Sum(nil)))
			req.Header.Set("x-softmato-timestamp", strconv.FormatInt(ts, 10))
		}
		res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
		if err != nil {
			return 0, err.Error()
		}
		defer res.Body.Close()
		text, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
		return res.StatusCode, string(text)
	}
	payload, _ := json.Marshal(map[string]any{"amount": 5_000_00, "currency": "NPR", "event": "payment.success", "invoice_id": invoiceNo,
		"occurred_at": time.Now().UTC().Format(time.RFC3339Nano), "status": "SUCCEEDED", "transaction_id": "TXN-CHK-" + stamp})
	now := time.Now().Unix()
	status, _ := deliver(payload, "", now, false)
	check("an unsigned delivery is refused", status == 400, fmt.Sprint("status ", status))
	status, text := deliver(payload, "not-the-webhook-secret", now, true)
	check("a delivery signed with the wrong secret is refused", status == 400, fmt.Sprint("status ", status, " ", text))
	status, text = deliver(payload, s.WebhookSecret, now-3600, true)
	check("a replayed delivery from an hour ago is refused", status == 400, fmt.Sprint("status ", status, " ", text))
	status, text = deliver(payload, s.WebhookSecret, now, true)
	check("a genuine delivery verifies", status == 200, fmt.Sprint("status ", status, " ", text))
	fmt.Println("        " + text)

	fmt.Println("\nSETTLING FROM A WEBHOOK")
	at := time.Now().UTC().Truncate(time.Millisecond)
	hostelID, subscriptionID, localInvoiceID := bson.NewObjectID(), bson.NewObjectID(), bson.NewObjectID()
	name := "Softmato Check " + stamp
	db := e.db
	defer func() { // the rows this check made, whatever happened
		c := context.WithoutCancel(ctx)
		_, _ = db.Collection("subscriptionpayments").DeleteMany(c, bson.D{{Key: "invoiceId", Value: localInvoiceID}})
		_, _ = db.Collection("subscriptioninvoices").DeleteOne(c, bson.D{{Key: "_id", Value: localInvoiceID}})
		_, _ = db.Collection("hostelsubscriptions").DeleteOne(c, bson.D{{Key: "_id", Value: subscriptionID}})
		_, _ = db.Collection("hostels").DeleteOne(c, bson.D{{Key: "_id", Value: hostelID}})
	}()
	seed := []struct {
		coll string
		doc  bson.D
	}{
		{"hostels", bson.D{{Key: "_id", Value: hostelID}, {Key: "contact", Value: bson.D{{Key: "email", Value: "owner.softmato." + stamp + "@example.com"}, {Key: "phone", Value: "9800000000"}}},
			{Key: "createdAt", Value: at}, {Key: "isDeleted", Value: false}, {Key: "name", Value: name}, {Key: "slug", Value: "softmato-check-" + stamp},
			{Key: "status", Value: "PENDING"}, {Key: "updatedAt", Value: at}, {Key: "verificationStatus", Value: "VERIFIED"}}},
		{"hostelsubscriptions", bson.D{{Key: "_id", Value: subscriptionID}, {Key: "createdAt", Value: at}, {Key: "currency", Value: "NPR"}, {Key: "cycle", Value: "annual"},
			{Key: "cycleMonths", Value: 12}, {Key: "cycleTotal", Value: 5000}, {Key: "hostelId", Value: hostelID}, {Key: "monthlyRate", Value: 5000},
			{Key: "planId", Value: "pro"}, {Key: "planName", Value: "Pro"}, {Key: "source", Value: "PUBLIC"}, {Key: "status", Value: "AWAITING_PAYMENT"}, {Key: "updatedAt", Value: at}}},
		{"subscriptioninvoices", bson.D{{Key: "_id", Value: localInvoiceID}, {Key: "amount", Value: 5000}, {Key: "billedTo", Value: bson.D{{Key: "hostelName", Value: name}, {Key: "name", Value: "Softmato Check"}}},
			{Key: "createdAt", Value: at}, {Key: "currency", Value: "NPR"}, {Key: "cycle", Value: "annual"}, {Key: "cycleMonths", Value: 12}, {Key: "hostelId", Value: hostelID},
			{Key: "invoiceNumber", Value: invoiceNumber}, {Key: "issuedAt", Value: at}, {Key: "planId", Value: "pro"}, {Key: "planName", Value: "Pro"},
			{Key: "softmatoInvoiceId", Value: invoice.InvoiceID}, {Key: "softmatoInvoiceNo", Value: invoiceNo}, {Key: "source", Value: "PUBLIC"}, {Key: "status", Value: "OPEN"},
			{Key: "subscriptionId", Value: subscriptionID}, {Key: "updatedAt", Value: at}}},
	}
	for _, row := range seed {
		if _, err := db.Collection(row.coll).InsertOne(ctx, row.doc); err != nil {
			return fmt.Errorf("seed %s: %w", row.coll, err)
		}
	}
	type payment struct {
		Status        string  `bson:"status"`
		Amount        float64 `bson:"amount"`
		TransactionNo string  `bson:"softmatoTransactionNo"`
		ReceiptNumber *string `bson:"receiptNumber"`
	}
	paymentsFor := func() []payment {
		var out []payment
		if cur, err := db.Collection("subscriptionpayments").Find(ctx, bson.D{{Key: "invoiceId", Value: localInvoiceID}}); err == nil {
			_ = cur.All(ctx, &out)
		}
		return out
	}
	status, text = deliver(payload, s.WebhookSecret, time.Now().Unix(), true)
	check("the delivery is accepted", status == 200, fmt.Sprint("status ", status, " ", text))
	check("it settled a payment rather than being ignored", strings.Contains(text, "settled"), text)
	pays := paymentsFor()
	check("one payment row exists", len(pays) == 1, fmt.Sprint(len(pays), " rows"))
	if len(pays) > 0 {
		p := pays[0]
		check("it is settled", p.Status == "SETTLED", p.Status)
		check("the amount converted from paisa to whole rupees", p.Amount == 5000, fmt.Sprint(p.Amount))
		check("the transaction number was stamped on it", p.TransactionNo == "TXN-CHK-"+stamp, p.TransactionNo)
		check("our own receipt number was allocated", p.ReceiptNumber != nil && *p.ReceiptNumber != "", "")
	}
	statusOf := func(coll string, id bson.ObjectID) string {
		var row struct {
			Status string `bson:"status"`
		}
		_ = db.Collection(coll).FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&row)
		return row.Status
	}
	check("the invoice reads paid", statusOf("subscriptioninvoices", localInvoiceID) == "PAID", statusOf("subscriptioninvoices", localInvoiceID))
	check("the subscription activated", statusOf("hostelsubscriptions", subscriptionID) == "ACTIVE", statusOf("hostelsubscriptions", subscriptionID))
	check("the hostel published once it had paid in full", statusOf("hostels", hostelID) == "PUBLISHED", statusOf("hostels", hostelID))
	status, text = deliver(payload, s.WebhookSecret, time.Now().Unix(), true)
	check("a repeated delivery is accepted", status == 200, text)
	after := paymentsFor()
	check("the repeat issued no second payment", len(after) == 1, fmt.Sprint(len(after), " rows"))
	if len(after) == 1 && len(pays) == 1 && after[0].ReceiptNumber != nil && pays[0].ReceiptNumber != nil {
		check("and no second receipt number", *after[0].ReceiptNumber == *pays[0].ReceiptNumber, *after[0].ReceiptNumber+" vs "+*pays[0].ReceiptNumber)
	}
	fmt.Printf("\n%d passed, %d failed\n\n", passed, failed)
	if failed > 0 {
		return errFindings
	}
	return nil
}
