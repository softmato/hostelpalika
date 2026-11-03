package gateway

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The callback eSewa sends after a payment: base64 JSON signed over the fields
// it names, with the merchant's secret.
func esewaCallback(t *testing.T, secret string) string {
	t.Helper()
	fields := []string{"transaction_code", "status", "total_amount", "transaction_uuid", "product_code", "signed_field_names"}
	values := map[string]string{"transaction_code": "000AWEO", "status": "COMPLETE", "total_amount": "1,000.0", "transaction_uuid": "HP-ABC-1",
		"product_code": "EPAYTEST", "signed_field_names": "transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names"}
	body := map[string]string{}
	for k, v := range values {
		body[k] = v
	}
	body["signature"] = esewaSign(fields, values, secret)
	raw, _ := json.Marshal(body)
	return base64.StdEncoding.EncodeToString(raw)
}

func TestESewaCallback(t *testing.T) {
	e := &ESewa{Now: time.Now}
	raw := esewaCallback(t, "8gBm/:&EnhH.1/q")
	// P8-5: the reference is readable before any key is known, so the intent
	// (and with it the hostel's key) can be found.
	if got := e.Reference(raw); got != "HP-ABC-1" {
		t.Fatalf("Reference = %q", got)
	}
	if e.ParseWebhook(raw, nil, Credentials{}) != nil {
		t.Fatal("an empty secret must never verify")
	}
	if e.ParseWebhook(raw, nil, Credentials{Secret: "other"}) != nil {
		t.Fatal("a wrong secret verified")
	}
	claim := e.ParseWebhook("data="+raw, nil, Credentials{Secret: "8gBm/:&EnhH.1/q"})
	if claim == nil || claim.Amount != 1000 || claim.Reference != "HP-ABC-1" || claim.ProviderTxnID != "000AWEO" {
		t.Fatalf("claim = %+v", claim)
	}
}

func TestESewaIntentSignsTheForm(t *testing.T) {
	e := &ESewa{Now: time.Now}
	in, err := e.CreateIntent(context.Background(), IntentRequest{Amount: 1500, Reference: "HP-ABC-2", Credentials: Credentials{MerchantCode: "EPAYTEST", Secret: "s", Sandbox: true}})
	if err != nil {
		t.Fatal(err)
	}
	fields, _ := in.Handoff.Get("fields")
	m := map[string]string{}
	b, _ := json.Marshal(fields)
	_ = json.Unmarshal(b, &m)
	want := esewaSign(esewaSigned, map[string]string{"total_amount": "1500", "transaction_uuid": "HP-ABC-2", "product_code": "EPAYTEST"}, "s")
	if m["signature"] != want || m["total_amount"] != "1500" {
		t.Fatalf("form = %v", m)
	}
	if u, _ := in.Handoff.Get("url"); u != esewaEndpoints[true][0] {
		t.Fatalf("sandbox form url = %v", u)
	}
}

func TestVerifyStatuses(t *testing.T) {
	for _, tc := range []struct {
		body   string
		status string
		amount int64
	}{
		{`{"status":"COMPLETE","total_amount":"1000.0","ref_id":"R1"}`, "SUCCESS", 1000},
		{`{"status":"AMBIGUOUS","total_amount":1000}`, "PENDING", 1000},
		{`{"status":"CANCELED","total_amount":"x"}`, "FAILED", -1},
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(tc.body)) }))
		e := &ESewa{HTTP: srv.Client(), StatusURL: srv.URL, Now: time.Now}
		v, err := e.Verify(context.Background(), 1000, nil, "HP-1", Credentials{})
		srv.Close()
		if err != nil || v.Status != tc.status || v.Amount != tc.amount {
			t.Errorf("%s: got %+v %v", tc.body, v, err)
		}
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"Completed","total_amount":150000,"transaction_id":"T9","refunded":false}`))
	}))
	defer srv.Close()
	k := &Khalti{HTTP: srv.Client(), BaseURL: srv.URL, Now: time.Now}
	pidx := "pidx-1"
	v, err := k.Verify(context.Background(), 1500, &pidx, "HP-2", Credentials{Secret: "k"})
	if err != nil || v.Status != "SUCCESS" || v.Amount != 1500 || v.ProviderTxnID != "T9" {
		t.Fatalf("khalti = %+v %v", v, err)
	}
	if v, _ := k.Verify(context.Background(), 1500, nil, "HP-2", Credentials{}); v.Status != "FAILED" {
		t.Fatal("no pidx must fail")
	}
}
