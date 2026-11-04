// Package gateway is a resident paying a hostel invoice online: an intent per
// attempt, the provider's hand-off (eSewa's signed form, Khalti's payment link),
// and settlement only after the provider's own API says the money moved
// (finance/gateway in TS). A callback's signature proves who sent it, never that
// money moved or how much; Verify does that.
package gateway

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// Credentials are one hostel's merchant keys for one provider (or the sandbox's).
type Credentials struct {
	MerchantCode, Provider, Secret, WebhookSecret string
	Sandbox                                       bool
}

type IntentRequest struct {
	Amount                                                       int64 // rupees
	Attempt                                                      int
	Credentials                                                  Credentials
	CallbackURL, FailureURL, Reference, ReferenceCode, ReturnURL string
}

// Intent is the provider's answer to an attempt: how the browser hands off, and
// the provider's own id for it when it has one (Khalti's pidx).
type Intent struct {
	ExpiresAt   time.Time
	Handoff     ordered.Map // {kind: REDIRECT, url} | {fields, kind: FORM_POST, url}
	ProviderRef *string
}

// Claim is what a callback says happened, after its signature verified.
type Claim struct {
	Amount        int64
	ProviderTxnID string
	Reference     string
}

// Verification is the provider's own account of an attempt. Amount is -1 when the
// provider sent nothing readable, so it can never equal an attempt's amount.
type Verification struct {
	Amount        int64
	ProviderTxnID string
	Status        string // SUCCESS | PENDING | FAILED
}

type Provider interface {
	Name() string
	CreateIntent(ctx context.Context, r IntentRequest) (Intent, error)
	// Reference reads the attempt reference out of a callback without checking
	// anything, only to find whose keys verify it. TS ran the full signed parse
	// with an empty secret here, which no eSewa callback ever passed (P8-5).
	Reference(raw string) string
	ParseWebhook(raw string, headers map[string]string, c Credentials) *Claim
	Verify(ctx context.Context, amount int64, providerTxnID *string, reference string, c Credentials) (Verification, error)
}

const requestTimeout = 10 * time.Second

func unreachable(name string) error {
	return finance.Err("GATEWAY_UNREACHABLE", "Could not reach "+name+". Please try again in a moment.")
}

func unreadable(name string) error {
	return finance.Err("GATEWAY_UNREACHABLE", name+" returned an unreadable response.")
}

// readJSON caps the body: a provider answer is a few hundred bytes.
func readJSON(res *http.Response) (map[string]any, []byte, error) {
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil || out == nil {
		return nil, raw, fmt.Errorf("gateway: unreadable body")
	}
	return out, raw, nil
}

// text is String(v ?? ""), as TS reads a provider field.
func text(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// ---- eSewa (ePay v2) ----

type ESewa struct {
	HTTP *http.Client
	// FormURL/StatusURL override the live or sandbox endpoint (tests).
	FormURL, StatusURL string
	Now                func() time.Time
}

var esewaEndpoints = map[bool][2]string{
	false: {"https://epay.esewa.com.np/api/epay/main/v2/form", "https://esewa.com.np/api/epay/transaction/status/"},
	true:  {"https://rc-epay.esewa.com.np/api/epay/main/v2/form", "https://rc.esewa.com.np/api/epay/transaction/status/"},
}

var esewaSigned = []string{"total_amount", "transaction_uuid", "product_code"}

const esewaIntentTTL = 15 * time.Minute

func (e *ESewa) Name() string { return "ESEWA" }

func (e *ESewa) endpoints(c Credentials) (form, status string) {
	ep := esewaEndpoints[c.Sandbox]
	form, status = ep[0], ep[1]
	if e.FormURL != "" {
		form = e.FormURL
	}
	if e.StatusURL != "" {
		status = e.StatusURL
	}
	return form, status
}

// esewaSign is HMAC-SHA256 over "field=value,…" in the signed fields' order, base64.
func esewaSign(fields []string, values map[string]string, secret string) string {
	parts := make([]string, len(fields))
	for i, f := range fields {
		parts[i] = f + "=" + values[f]
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strings.Join(parts, ",")))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// esewaAmount is Math.round(Number(raw without commas)); -1 when not a number.
func esewaAmount(raw any) int64 {
	s := strings.TrimSpace(strings.ReplaceAll(text(raw), ",", ""))
	if s == "" {
		return 0 // Number("") is 0
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
		return -1
	}
	return int64(math.Floor(f + 0.5))
}

func (e *ESewa) CreateIntent(_ context.Context, r IntentRequest) (Intent, error) {
	amount := strconv.FormatInt(r.Amount, 10)
	values := map[string]string{"total_amount": amount, "transaction_uuid": r.Reference, "product_code": r.Credentials.MerchantCode}
	form, _ := e.endpoints(r.Credentials)
	fields := ordered.Map{{Key: "amount", Value: amount}, {Key: "failure_url", Value: r.FailureURL}, {Key: "product_code", Value: r.Credentials.MerchantCode},
		{Key: "product_delivery_charge", Value: "0"}, {Key: "product_service_charge", Value: "0"}, {Key: "signed_field_names", Value: strings.Join(esewaSigned, ",")},
		{Key: "success_url", Value: r.ReturnURL}, {Key: "tax_amount", Value: "0"}, {Key: "total_amount", Value: amount}, {Key: "transaction_uuid", Value: r.Reference},
		{Key: "signature", Value: esewaSign(esewaSigned, values, r.Credentials.Secret)}}
	return Intent{ExpiresAt: e.Now().Add(esewaIntentTTL), Handoff: ordered.Map{{Key: "fields", Value: fields}, {Key: "kind", Value: "FORM_POST"}, {Key: "url", Value: form}}}, nil
}

// esewaPayload is the callback body: JSON, or base64 JSON (eSewa's `data` param).
func esewaPayload(raw string) map[string]any {
	body := strings.TrimSpace(raw)
	if !strings.HasPrefix(body, "{") {
		if form, err := url.ParseQuery(body); err == nil && form.Get("data") != "" {
			body = form.Get("data")
		}
		// Buffer.from(…, "base64") reads padded, unpadded and URL-safe alike.
		var dec []byte
		var err error
		for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
			if dec, err = enc.DecodeString(body); err == nil {
				break
			}
		}
		if err != nil {
			return nil
		}
		body = string(dec)
	}
	var out map[string]any
	if json.Unmarshal([]byte(body), &out) != nil {
		return nil
	}
	return out
}

func (e *ESewa) Reference(raw string) string {
	return strings.TrimSpace(text(esewaPayload(raw)["transaction_uuid"]))
}

func (e *ESewa) ParseWebhook(raw string, _ map[string]string, c Credentials) *Claim {
	payload := esewaPayload(raw)
	if payload == nil {
		return nil
	}
	claimed := text(payload["signature"])
	var fields []string
	for _, f := range strings.Split(text(payload["signed_field_names"]), ",") {
		if f = strings.TrimSpace(f); f != "" {
			fields = append(fields, f)
		}
	}
	if claimed == "" || len(fields) == 0 || c.Secret == "" {
		return nil
	}
	values := map[string]string{}
	for _, f := range fields {
		values[f] = text(payload[f])
	}
	if !crypto.SecretsMatch(claimed, esewaSign(fields, values, c.Secret)) {
		return nil
	}
	ref := strings.TrimSpace(text(payload["transaction_uuid"]))
	if ref == "" {
		return nil
	}
	return &Claim{Amount: esewaAmount(payload["total_amount"]), ProviderTxnID: strings.TrimSpace(text(payload["transaction_code"])), Reference: ref}
}

func (e *ESewa) Verify(ctx context.Context, amount int64, providerTxnID *string, reference string, c Credentials) (Verification, error) {
	_, status := e.endpoints(c)
	q := url.Values{"product_code": {c.MerchantCode}, "total_amount": {strconv.FormatInt(amount, 10)}, "transaction_uuid": {reference}}
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, status+"?"+q.Encode(), nil)
	if err != nil {
		return Verification{}, err
	}
	req.Header.Set("Accept", "application/json")
	res, err := e.HTTP.Do(req)
	if err != nil {
		return Verification{}, unreachable("eSewa")
	}
	defer res.Body.Close()
	body, _, err := readJSON(res)
	if err != nil {
		return Verification{}, unreadable("eSewa")
	}
	st := "FAILED"
	switch strings.ToUpper(text(body["status"])) {
	case "COMPLETE":
		st = "SUCCESS"
	case "PENDING", "AMBIGUOUS":
		st = "PENDING"
	}
	txn := strings.TrimSpace(text(body["ref_id"]))
	if txn == "" && providerTxnID != nil && *providerTxnID != "" {
		txn = *providerTxnID
	}
	if txn == "" {
		txn = reference
	}
	return Verification{Amount: esewaAmount(body["total_amount"]), ProviderTxnID: txn, Status: st}, nil
}

// ---- Khalti (ePayment v2) ----

type Khalti struct {
	HTTP    *http.Client
	BaseURL string // overrides live/sandbox (tests)
	Now     func() time.Time
}

const (
	khaltiIntentTTL   = 30 * time.Minute
	khaltiMinPaisa    = 1000
	khaltiPaisaPerNPR = 100
)

func (k *Khalti) Name() string { return "KHALTI" }

func (k *Khalti) base(c Credentials) string {
	switch {
	case k.BaseURL != "":
		return k.BaseURL
	case c.Sandbox:
		return "https://dev.khalti.com/api/v2"
	}
	return "https://khalti.com/api/v2"
}

func (k *Khalti) post(ctx context.Context, path string, body any, c Credentials) (map[string]any, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, k.base(c)+path, strings.NewReader(string(raw)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Key "+c.Secret)
	req.Header.Set("Content-Type", "application/json")
	res, err := k.HTTP.Do(req)
	if err != nil {
		return nil, unreachable("Khalti")
	}
	defer res.Body.Close()
	out, _, err := readJSON(res)
	if err != nil {
		return nil, unreadable("Khalti")
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		if res.StatusCode >= 500 {
			return nil, finance.Err("GATEWAY_UNREACHABLE", "Khalti is unavailable right now.")
		}
		detail, ok := out["detail"].(string)
		if !ok {
			detail = "Khalti rejected the request."
		}
		return nil, finance.Err("GATEWAY_VERIFICATION_FAILED", detail)
	}
	return out, nil
}

func (k *Khalti) CreateIntent(ctx context.Context, r IntentRequest) (Intent, error) {
	paisa := r.Amount * khaltiPaisaPerNPR
	if paisa < khaltiMinPaisa {
		return Intent{}, finance.Err("AMOUNT_OUT_OF_BOUNDS", fmt.Sprintf("Khalti cannot take payments under NPR %d. Please use another method.", khaltiMinPaisa/khaltiPaisaPerNPR))
	}
	origin := r.ReturnURL
	if u, err := url.Parse(r.ReturnURL); err == nil {
		origin = u.Scheme + "://" + u.Host
	}
	body, err := k.post(ctx, "/epayment/initiate/", ordered.Map{{Key: "amount", Value: paisa}, {Key: "purchase_order_id", Value: r.Reference},
		{Key: "purchase_order_name", Value: "Hostel invoice " + r.ReferenceCode}, {Key: "return_url", Value: r.ReturnURL}, {Key: "website_url", Value: origin}}, r.Credentials)
	if err != nil {
		return Intent{}, err
	}
	link, pidx := text(body["payment_url"]), text(body["pidx"])
	if link == "" || pidx == "" {
		return Intent{}, finance.Err("GATEWAY_UNREACHABLE", "Khalti did not return a payment link.")
	}
	ttl := khaltiIntentTTL
	if secs, ok := body["expires_in"].(float64); ok && secs > 0 && !math.IsInf(secs, 0) {
		ttl = time.Duration(secs * float64(time.Second))
	}
	return Intent{ExpiresAt: k.Now().Add(ttl), Handoff: ordered.Map{{Key: "kind", Value: "REDIRECT"}, {Key: "url", Value: link}}, ProviderRef: &pidx}, nil
}

// Khalti signs nothing it sends back: its return carries pidx and
// purchase_order_id in the query. So a Khalti callback only names the attempt,
// and Verify's lookup with our key is the whole proof.
// Khalti signs no callback, and accepting its unsigned redirect parameters
// would let a stranger make us call Khalti against our own rate limit. Nothing
// is resolved from one; the resident's return page polls Verify instead.
func (k *Khalti) Reference(string) string { return "" }

func (k *Khalti) ParseWebhook(string, map[string]string, Credentials) *Claim { return nil }

func (k *Khalti) Verify(ctx context.Context, _ int64, providerTxnID *string, _ string, c Credentials) (Verification, error) {
	if providerTxnID == nil || *providerTxnID == "" {
		return Verification{Status: "FAILED"}, nil
	}
	body, err := k.post(ctx, "/epayment/lookup/", ordered.Map{{Key: "pidx", Value: *providerTxnID}}, c)
	if err != nil {
		return Verification{}, err
	}
	amount := int64(-1)
	if paisa, ok := body["total_amount"].(float64); ok && !math.IsInf(paisa, 0) && !math.IsNaN(paisa) {
		amount = int64(math.Floor(paisa / khaltiPaisaPerNPR))
	} else if s, ok := body["total_amount"].(string); ok {
		if f, err := strconv.ParseFloat(strings.TrimSpace(s), 64); err == nil {
			amount = int64(math.Floor(f / khaltiPaisaPerNPR))
		}
	}
	st := "FAILED"
	switch strings.ToLower(strings.TrimSpace(text(body["status"]))) {
	case "completed":
		if refunded, _ := body["refunded"].(bool); !refunded {
			st = "SUCCESS"
		}
	case "pending", "initiated":
		st = "PENDING"
	}
	txn := strings.TrimSpace(text(body["transaction_id"]))
	if txn == "" {
		txn = *providerTxnID
	}
	return Verification{Amount: amount, ProviderTxnID: txn, Status: st}, nil
}
