package financeadmin

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/softmato/hostelpalika/server/internal/platform/pdf"
)

const sampleLedger = `{"entries":[
 {"paidAmount":9000,"paidDate":"2026-08-20T05:00:00.000Z","month":"2083-04","residentName":"Asha Rai"},
 {"paidAmount":0,"paidDate":"2026-08-21T05:00:00.000Z","month":"2083-04","residentName":"Unpaid"},
 {"paidAmount":4000,"createdAt":"2026-09-02T05:00:00.000Z","month":null,"residentName":""}],
 "expenses":[
 {"amount":1500,"status":"RECORDED","spentOn":"2026-09-03","categoryLabel":"Gas","what":"2 cylinders","payer":"HOSTEL","recordedBy":{"id":"a","name":"Ram","role":"HOSTEL_ADMIN"}},
 {"amount":2000,"status":"RECORDED","spentOn":"2026-09-04","categoryLabel":"Staff cash","payer":"HOSTEL","cashTo":{"name":"Sita","userId":"w1"},"cashStatus":"ACCEPTED","recordedBy":{"id":"a","name":"Ram","role":"HOSTEL_ADMIN"}},
 {"amount":300,"status":"RECORDED","spentOn":"2026-09-05","categoryLabel":"Tea","what":"","payer":"STAFF","recordedBy":{"id":"w1","name":"Sita","role":"WARDEN"}}],
 "openingBalance":{"amount":10000,"asOf":"2026-08-01"}}`

func TestStatementTotals(t *testing.T) {
	var l ledgerDoc
	if err := json.Unmarshal([]byte(sampleLedger), &l); err != nil {
		t.Fatal(err)
	}
	// 2083-05 is BS Bhadra: 17 Aug to 16 Sep 2026.
	st, err := buildStatement(&l, "2083-05", "2083-05")
	if err != nil {
		t.Fatal(err)
	}
	if st.opening != 10000 || st.credit != 13000 || st.debit != 1800 || st.closing != 21200 {
		t.Fatalf("opening %d credit %d debit %d closing %d", st.opening, st.credit, st.debit, st.closing)
	}
	if len(st.staff) != 1 || st.staff[0].given != 2000 || st.staff[0].spent != 300 || st.staff[0].left != 1700 {
		t.Fatalf("staff %+v", st.staff)
	}
	d := pdf.New()
	drawStatement(d, st, "Test Hostel", time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC))
	body, err := d.Bytes()
	if err != nil || len(body) < 1000 {
		t.Fatal(err)
	}
	if out := os.Getenv("PDF_OUT"); out != "" {
		os.WriteFile(out, body, 0o644)
	}
}
