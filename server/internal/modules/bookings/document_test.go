package bookings

import (
	"os"
	"testing"
	"time"

	"github.com/softmato/hostelpalika/server/internal/platform/pdf/pdftest"
)

func TestDocumentsMatchTS(t *testing.T) {
	at := time.Date(2026, 9, 1, 6, 0, 0, 0, time.UTC)
	issuer := Issuer{Address: "Kathmandu", Email: "billing@softmato.com", LegalName: "Softmato Pvt. Ltd.", Pan: "622209876", Phone: "9800000000", ProductName: "HostelPalika"}
	base := func() *Booking {
		b := &Booking{Code: "BK-7F3K2Q", CreatedAt: at, Currency: "NPR", Fee: 1500, InvoiceNumber: "HH-BKI-2083-84-000012", MonthlyRent: 15000, PaymentDueBy: time.Date(2026, 9, 1, 18, 20, 0, 0, time.UTC),
			RoomType: "Double Sharing", Status: "AWAITING_PAYMENT", Terms: Terms{CancelSteps: []CancelStep{{75, 2}, {50, 5}, {25, 7}}, FeePercent: 10, HoldDays: 7, HostelAnswerHours: 48, HostelSharePercent: 50}}
		b.Guest.Email, b.Guest.Name = "sita@example.com", "Sita Sharma"
		b.HostelSnapshot.Name = "Fixture Lakeside Hostel"
		return b
	}
	verified, receipt := time.Date(2026, 9, 2, 4, 5, 0, 0, time.UTC), "HH-BKR-2083-84-00000007"
	paid := func() *Booking {
		b := base()
		b.PaymentVerifiedAt, b.ReceiptNumber, b.Status = &verified, &receipt, "AWAITING_HOSTEL"
		return b
	}
	stay := base()
	stay.Fee, stay.Kind = 3000, "SHORT_STAY"
	stay.Stay = &Stay{Amount: 3000, DailyRate: 1000, HoldBlocks: 2, HostelSharePercent: 80, MoveIn: time.Date(2026, 10, 4, 0, 0, 0, 0, time.UTC), MoveOut: time.Date(2026, 10, 7, 0, 0, 0, 0, time.UTC), Nights: 3}
	softmato, invoiceNo := base(), "INV-000123"
	softmato.SoftmatoInvoiceNo = &invoiceNo
	refunded := paid()
	refunded.Status = "CANCELLED_BY_USER"
	pct := 75.0
	refunded.Settlement = &struct {
		HostelShare   *int64   `bson:"hostelShare"`
		Refund        *int64   `bson:"refund"`
		RefundPercent *float64 `bson:"refundPercent"`
	}{RefundPercent: &pct}
	method, number, tx := "ESEWA", "HH-BRF-2083-84-00000003", "TX-555"
	transfer := &Transfer{Amount: 1125, Destination: &Destination{HolderName: "Sita", Method: &method, NumberLast4: "4321"}, DocumentNumber: &number, SentAt: &at, Status: "SENT", TransactionID: &tx}

	for _, tc := range []struct {
		name, kind string
		b          *Booking
		t          *Transfer
	}{
		{"invoice", "invoice", base(), nil}, {"invoice-paid", "invoice", paid(), nil}, {"invoice-stay", "invoice", stay, nil},
		{"invoice-softmato", "invoice", softmato, nil}, {"receipt", "receipt", paid(), nil}, {"refund", "refund", refunded, transfer},
	} {
		t.Run(tc.name, func(t *testing.T) {
			want, err := os.ReadFile("../../../testdata/golden/pdf/bookings/" + tc.name + ".pdf")
			if err != nil {
				t.Fatal(err)
			}
			got, err := renderDocument(documentLayout(tc.kind, tc.b, tc.t, issuer))
			if err != nil {
				t.Fatal(err)
			}
			if d := pdftest.Diff(got, want, 0.05); d != "" {
				t.Error(d)
			}
		})
	}
}

func TestAmountInWords(t *testing.T) {
	for in, want := range map[int64]string{0: "Zero Rupees Only", 150: "One Hundred Fifty Rupees Only", 150000: "One Lakh Fifty Thousand Rupees Only", 12345678: "One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Rupees Only"} {
		if got := amountInWords(in); got != want {
			t.Errorf("%d: %q", in, got)
		}
	}
}

func TestSettlementSumsBack(t *testing.T) {
	terms := Terms{CancelSteps: []CancelStep{{75, 2}}, HostelSharePercent: 50}
	for _, fee := range []int64{1, 333, 1500, 2501} {
		s := settlementFor(fee, 75, terms.HostelSharePercent)
		if s.Refund+s.HostelShare+s.PlatformShare != fee {
			t.Errorf("fee %d: %+v", fee, s)
		}
	}
	confirmed := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	if holdDayAt(confirmed, confirmed.Add(24*time.Hour-time.Millisecond)) != 1 || holdDayAt(confirmed, confirmed.Add(24*time.Hour)) != 2 {
		t.Error("a hold day is a 24-hour block from confirmation")
	}
}
