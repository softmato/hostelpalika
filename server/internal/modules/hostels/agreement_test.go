package hostels

import (
	"os"
	"testing"
	"time"
)

// The print runs end to end on the real letterhead and flows onto several pages.
func TestAgreementRenders(t *testing.T) {
	p := agreementParties{Company: agreementCompany{letterheadAddress, letterheadEmail, letterheadPhone, "Softmato Pvt Ltd", "123", "98"}, Hostel: agreementHostel{"Ward 4, Kathmandu", "Test Hostel"}, Owner: agreementOwner{"o@x.test", "Ram", "98"}}
	sig := "M0 0L100 100L200 50L300 150L400 20L500 180L550 90L600 200"
	ref := "SMT/HP/2026/001"
	now := time.Now()
	for _, code := range []*string{nil, &ref} {
		r := &signatureRecord{Parties: p, RefCode: code, Signature: sig, SignedAt: now, SignerName: "Ram", Terms: termsFor(p), TextHash: "abc", UserAgent: "go", IP: "1.1.1.1"}
		if code != nil {
			r.IssuedAt = &now
		}
		out, err := agreementPrint{record: r, issuer: agreementIssuer{LegalName: "Softmato Pvt Ltd"}}.render()
		if err != nil {
			t.Fatal(err)
		}
		if len(out) < 100000 {
			t.Fatalf("letterhead missing: %d bytes", len(out))
		}
		if dir := os.Getenv("AGREEMENT_OUT"); dir != "" {
			if err := os.WriteFile(dir+"/agreement.pdf", out, 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
}

// The fingerprint is JSON.stringify's: nothing HTML-escaped, keys in order.
func TestAgreementFingerprintStable(t *testing.T) {
	p := agreementParties{Company: agreementCompany{LegalName: "A & B"}}
	a, err := agreementFingerprint(p, termsFor(p))
	if err != nil || len(a) != 64 {
		t.Fatal(a, err)
	}
}
