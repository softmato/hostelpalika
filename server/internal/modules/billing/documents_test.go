package billing

import (
	"bytes"
	"os"
	"testing"
	"time"

	"github.com/softmato/hostelpalika/server/internal/platform/softmato"
)

func TestPlanDocumentsRender(t *testing.T) {
	now := time.Now()
	inv := &planInvoice{Amount: 4900, Cycle: "monthly", CycleMonths: 1, PlanName: "Pro", Status: "PARTIAL", IssuedAt: &now}
	inv.BilledTo.Name, inv.BilledTo.Email = "Pay Owner", "o@x.test"
	issuer := Issuer{LegalName: "Softmato Technology", Pan: "123", Email: "work@softmato.com", ProductName: "HostelPalika", Address: "Kathmandu", Phone: "98"}
	a, err := invoicePrint{inv: inv, amountPaid: 1000, number: "HH-INV-1", issuer: issuer, lineLabel: "Pro — Monthly", presentation: &softmato.Presentation{PlanName: "Pro — Monthly", Tagline: "All of it", Features: []string{"Up to 50 residents", "2 warden accounts", "1 cook account"}}}.render()
	if err != nil || !bytes.HasPrefix(a, pdfMagic) {
		t.Fatal(err)
	}
	b, err := receiptPrint{pay: &planPayment{Amount: 1000, Method: "CASH", SettledAt: &now}, number: "HH-TXN-1", invoiceNumber: "HH-INV-1", invoiceTotal: 4900, received: 1000, fromName: "Pay Owner", fromEmail: "o@x.test", issuer: issuer}.render()
	if err != nil || !bytes.HasPrefix(b, pdfMagic) {
		t.Fatal(err)
	}
	if dir := os.Getenv("PLAN_DOC_OUT"); dir != "" {
		_ = os.WriteFile(dir+"/inv.pdf", a, 0o644)
		_ = os.WriteFile(dir+"/rec.pdf", b, 0o644)
	}
}

func TestPresentationDropsWhatSoftmatoRefuses(t *testing.T) {
	if presentFit("Save Rs 500", 60) != "" || presentFit("Free trial", 60) != "" || presentFit("1,200 a bed", 60) != "" {
		t.Fatal("a price must not pass")
	}
	if got := presentFit("<b>Plain</b>  *words*", 60); got != "Plain words" {
		t.Fatal(got)
	}
}
