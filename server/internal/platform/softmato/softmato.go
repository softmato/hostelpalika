// Package softmato is the payment and document API every hostel's plan goes through:
// the calls @softmato/sdk makes, same paths, retries and idempotency.
package softmato

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	timeout     = 15 * time.Second
	maxAttempts = 3
)

// Client is safe for concurrent use. Nil-safe via Configured.
type Client struct {
	BaseURL string
	Secret  string
	HTTP    *http.Client
}

// New is nil unless all three settings are present, as softmatoConfig().
func New(baseURL, secret, webhookSecret string) *Client {
	baseURL, secret = strings.TrimSpace(baseURL), strings.TrimSpace(secret)
	if baseURL == "" || secret == "" || strings.TrimSpace(webhookSecret) == "" {
		return nil
	}
	return &Client{BaseURL: strings.TrimRight(baseURL, "/"), Secret: secret, HTTP: &http.Client{Timeout: timeout}}
}

// APIError is an answer from Softmato refusing the request.
type APIError struct {
	Code    string
	Message string
	Status  int
}

func (e *APIError) Error() string { return e.Code + ": " + e.Message }

func (e *APIError) retryable() bool {
	return e.Code == "RATE_LIMITED" || e.Code == "PROVIDER_UNAVAILABLE" || e.Code == "INTERNAL"
}

// TransportError means no usable answer arrived.
type TransportError struct{ Message string }

func (e *TransportError) Error() string { return e.Message }

// IsDown is isSoftmatoDown: unreachable, or its own failure.
func IsDown(err error) bool {
	var t *TransportError
	var a *APIError
	return errors.As(err, &t) || (errors.As(err, &a) && a.Status >= 500)
}

// IsNotFound is the RESOURCE_NOT_FOUND answer.
func IsNotFound(err error) bool {
	var a *APIError
	return errors.As(err, &a) && a.Code == "RESOURCE_NOT_FOUND"
}

var knownCodes = map[string]bool{"UNAUTHENTICATED": true, "INSUFFICIENT_SCOPE": true, "RESOURCE_NOT_FOUND": true, "IDEMPOTENCY_CONFLICT": true, "VALIDATION_FAILED": true, "RATE_LIMITED": true, "INTERNAL": true, "PROVIDER_UNAVAILABLE": true}

func apiError(status int, body []byte) *APIError {
	var p struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &p)
	code, msg := p.Error.Code, p.Error.Message
	if !knownCodes[code] {
		code = "INTERNAL"
	}
	if msg == "" {
		msg = "Request failed"
	}
	return &APIError{code, msg, status}
}

func (c *Client) warnExpiring(res *http.Response) {
	if at := res.Header.Get("softmato-secret-expires"); at != "" {
		slog.Error("softmato_secret_expiring", "expiresAt", at)
	}
}

func (c *Client) do(ctx context.Context, method, path string, payload any, out any) error {
	return c.doKeyed(ctx, method, path, "", payload, out)
}

// doKeyed is do with a caller's Idempotency-Key, so a repeat after a restart is the same request.
func (c *Client) doKeyed(ctx context.Context, method, path, key string, payload any, out any) error {
	var body []byte
	if payload != nil {
		var err error
		if body, err = json.Marshal(payload); err != nil {
			return err
		}
	}
	if method == http.MethodPost && key == "" {
		// One key across the retries: a repeat is the same request, never a second one.
		var raw [16]byte
		if _, err := rand.Read(raw[:]); err != nil {
			return err
		}
		key = hex.EncodeToString(raw[:])
	}
	var last error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		last = c.attempt(ctx, method, path, body, key, out)
		var a *APIError
		retry := last != nil && (errors.As(last, new(*TransportError)) || (errors.As(last, &a) && a.retryable()))
		if !retry || attempt == maxAttempts {
			return last
		}
		select {
		case <-ctx.Done():
			return last
		case <-time.After(200 * time.Millisecond << (attempt - 1)):
		}
	}
	return last
}

func (c *Client) attempt(ctx context.Context, method, path string, body []byte, key string, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Secret)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return &TransportError{fmt.Sprintf("Could not reach the Softmato API (%s %s)", method, path)}
	}
	defer res.Body.Close()
	c.warnExpiring(res)
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return &TransportError{"Could not read the Softmato answer"}
	}
	if len(data) > 0 && !json.Valid(data) {
		return &TransportError{fmt.Sprintf("Softmato API returned a non-JSON body (HTTP %d)", res.StatusCode)}
	}
	if res.StatusCode/100 != 2 {
		return apiError(res.StatusCode, data)
	}
	if out == nil || len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, out)
}

// Presentation is the plan in our own words beside the amount.
type Presentation struct {
	PlanName      string   `json:"plan_name"`
	Tagline       string   `json:"tagline,omitempty"`
	Features      []string `json:"features,omitempty"`
	Highlights    []string `json:"highlights,omitempty"`
	BillingPeriod string   `json:"billing_period,omitempty"`
}

type Customer struct {
	ExternalRef string `json:"external_ref"`
	Name        string `json:"name"`
	Email       string `json:"email,omitempty"`
}

type InvoiceLine struct {
	Description    string `json:"description"`
	Quantity       int    `json:"quantity"`
	UnitPriceMinor int64  `json:"unit_price_minor"`
}

type CreateInvoice struct {
	Customer        Customer      `json:"customer"`
	ExternalRef     string        `json:"external_ref"`
	Lines           []InvoiceLine `json:"lines"`
	DueAt           string        `json:"due_at,omitempty"`
	Presentation    *Presentation `json:"presentation,omitempty"`
	ServiceEndsAt   string        `json:"service_ends_at,omitempty"`
	ServiceStartsAt string        `json:"service_starts_at,omitempty"`
}

type Invoice struct {
	InvoiceID string  `json:"invoice_id"`
	InvoiceNo *string `json:"invoice_no"`
}

func (c *Client) CreateInvoice(ctx context.Context, in CreateInvoice) (*Invoice, error) {
	var out Invoice
	if err := c.do(ctx, http.MethodPost, "/invoices", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// OfflinePayment is recordOfflinePayment's body: cash a field agent collected.
type OfflinePayment struct {
	AmountMinor int64  `json:"amount_minor"`
	CollectedBy string `json:"collected_by"`
	InvoiceID   string `json:"invoice_id"`
	Reference   string `json:"reference,omitempty"`
}

// RecordOfflinePayment files cash with Softmato; their admin confirms it.
func (c *Client) RecordOfflinePayment(ctx context.Context, in OfflinePayment, key string) (string, error) {
	var out struct {
		TransactionID string `json:"transaction_id"`
	}
	if err := c.doKeyed(ctx, http.MethodPost, "/offline-payments", key, in, &out); err != nil {
		return "", err
	}
	return out.TransactionID, nil
}

type CheckoutSession struct {
	AllowedProviders []string `json:"allowed_providers"`
	CheckoutURL      string   `json:"checkout_url"`
	ExpiresAt        string   `json:"expires_at"`
	SessionID        string   `json:"session_id"`
}

func (c *Client) CreateCheckout(ctx context.Context, invoiceID, returnURL string) (*CheckoutSession, error) {
	var out CheckoutSession
	err := c.do(ctx, http.MethodPost, "/checkout", map[string]string{"invoice_id": invoiceID, "return_url": returnURL}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func pathFor(ref string) string {
	parts := strings.Split(ref, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return strings.Join(parts, "/")
}

type InvoiceDetail struct {
	DueMinor   int64  `json:"due_minor"`
	PaidMinor  int64  `json:"paid_minor"`
	TotalMinor int64  `json:"total_minor"`
	Status     string `json:"status"` // unpaid, partially_paid, paid, past_due, void, written_off
	// Nil when an older Softmato does not name the payments behind paid_minor.
	Payments []struct {
		AmountMinor   float64 `json:"amount_minor"`
		PaidAt        string  `json:"paid_at"`
		Provider      *string `json:"provider"`
		TransactionID string  `json:"transaction_id"`
	} `json:"payments"`
}

// Receipt is the ReceiptDetail fields a settlement keeps.
type Receipt struct {
	AmountMinor int64   `json:"amount_minor"`
	PaidAt      string  `json:"paid_at"`
	Provider    string  `json:"provider"`
	ProviderRef *string `json:"provider_ref"`
}

// GetReceipt is the receipt for a settled transaction; nil when Softmato has none.
func (c *Client) GetReceipt(ctx context.Context, transactionNo string) (*Receipt, error) {
	var out Receipt
	if err := c.do(ctx, http.MethodGet, "/receipts/"+pathFor(transactionNo), nil, &out); err != nil {
		if IsNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return &out, nil
}

// GetInvoice is nil when Softmato has no such invoice.
func (c *Client) GetInvoice(ctx context.Context, number string) (*InvoiceDetail, error) {
	var out InvoiceDetail
	if err := c.do(ctx, http.MethodGet, "/invoices/"+pathFor(number), nil, &out); err != nil {
		if IsNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return &out, nil
}

// File is a downloaded document.
type File struct {
	ContentType string
	Fallback    string
	Bytes       []byte
}

// Download fetches "invoices" or "receipts" number as a PDF; nil when not found.
func (c *Client) Download(ctx context.Context, collection, number string) (*File, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/"+collection+"/"+pathFor(number)+"?format=pdf", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Secret)
	req.Header.Set("Accept", "application/pdf, text/html")
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, &TransportError{"Document request failed"}
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, &TransportError{"Document request failed"}
	}
	if res.StatusCode/100 != 2 {
		e := apiError(res.StatusCode, data)
		if e.Code == "RESOURCE_NOT_FOUND" {
			return nil, nil
		}
		return nil, e
	}
	c.warnExpiring(res)
	kind := strings.TrimSpace(strings.Split(res.Header.Get("content-type"), ";")[0])
	if kind == "" {
		kind = "application/octet-stream"
	}
	return &File{kind, res.Header.Get("x-softmato-pdf-fallback"), data}, nil
}
