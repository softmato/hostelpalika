package billing

import (
	"testing"
	"time"
)

// The SDK's SHARED_VECTOR: if this fails the wire format changed, not the test.
const (
	vecSecret = "whsec_test_2f9a1c"
	vecBody   = `{"event":"payment.success","transaction_id":"TXN-2082/83-00000001"}`
	vecSig    = "7b1621acf4b889b18381561a84badc43490db7d379de864fcfb4f5788a2498d3"
)

var vecAt = time.Unix(1754990400, 0)

func TestVerifyWebhook(t *testing.T) {
	cases := []struct {
		name, sig, ts string
		now           time.Time
		want          string
	}{
		{"shared vector", vecSig, "1754990400", vecAt, ""},
		{"padded timestamp", vecSig, " 1754990400 ", vecAt, ""},
		{"missing signature", "", "1754990400", vecAt, "missing_signature"},
		{"missing timestamp", vecSig, "", vecAt, "malformed_timestamp"},
		{"fractional timestamp", vecSig, "1754990400.5", vecAt, "malformed_timestamp"},
		{"too old", vecSig, "1754990400", vecAt.Add(301 * time.Second), "timestamp_too_old"},
		{"in the future", vecSig, "1754990400", vecAt.Add(-301 * time.Second), "timestamp_in_future"},
		{"edge of window", vecSig, "1754990400", vecAt.Add(300 * time.Second), ""},
		{"wrong signature", vecSig[:63] + "0", "1754990400", vecAt, "signature_mismatch"},
	}
	for _, c := range cases {
		p, reason := VerifyWebhook([]byte(vecBody), vecSecret, c.sig, c.ts, c.now)
		if reason != c.want {
			t.Errorf("%s: reason %q, want %q", c.name, reason, c.want)
		}
		if c.want == "" && (p == nil || p.Event != "payment.success" || p.TransactionID != "TXN-2082/83-00000001") {
			t.Errorf("%s: payload %+v", c.name, p)
		}
	}
	// One byte of re-serialisation breaks it: the raw body is what is signed.
	if _, reason := VerifyWebhook([]byte(vecBody+" "), vecSecret, vecSig, "1754990400", vecAt); reason != "signature_mismatch" {
		t.Errorf("re-serialised body verified: %q", reason)
	}
}

func TestClassifyAndPaisa(t *testing.T) {
	for status, want := range map[string]string{"SUCCEEDED": "settled", "succeeded": "settled", "PENDING": "pending", "CREATED": "pending",
		"RECONCILIATION_REQUIRED": "under_review", "FAILED": "not_completed", "SOMETHING_NEW": "not_completed"} {
		if got := classify(status); got != want {
			t.Errorf("classify(%q) = %q, want %q", status, got, want)
		}
	}
	if r, err := paisaToRupees(1200000); err != nil || r != 12000 {
		t.Errorf("paisaToRupees(1200000) = %d, %v", r, err)
	}
	for _, bad := range []float64{1250, 100.5} {
		if _, err := paisaToRupees(bad); err == nil {
			t.Errorf("paisaToRupees(%v) accepted", bad)
		}
	}
}
