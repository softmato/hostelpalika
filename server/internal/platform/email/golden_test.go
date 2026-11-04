package email

import (
	"encoding/json"
	"os"
	"strconv"
	"testing"
	"time"
)

// TestTemplatesMatchTS replays testdata/vectors/emails.json: every template
// output must equal the TS template's, byte for byte.
func TestTemplatesMatchTS(t *testing.T) {
	raw, err := os.ReadFile("../../../testdata/vectors/emails.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Name  string          `json:"name"`
		Input json.RawMessage `json:"input"`
		Out   struct {
			Category string `json:"category"`
			Subject  string `json:"subject"`
			HTML     string `json:"html"`
		} `json:"out"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	for i, v := range vectors {
		var in map[string]any
		_ = json.Unmarshal(v.Input, &in)
		s := func(k string) string { x, _ := in[k].(string); return x }
		var got Content
		switch v.Name {
		case "hostelInquiryReceived":
			got = HostelInquiryReceived(s("dashboardUrl"), s("hostelName"), s("message"), s("preferredVisitDate"), s("visitorEmail"), s("visitorName"), s("visitorPhone"))
		case "newHostelPending":
			got = NewHostelPending(s("city"), s("hostelName"), s("ownerEmail"), s("ownerName"), s("queueUrl"))
		case "hostelPortalOpen":
			days, _ := in["trialDays"].(float64)
			got = HostelPortalOpen(s("hostelName"), s("kycUrl"), s("ownerName"), int(days), s("trialEndsOn"))
		case "accountDeletionRequested":
			got = AccountDeletionRequested(s("cancelUrl"), s("scheduledDeletionDate"), s("userName"))
		case "accountDeletionReview":
			var names []string
			for _, n := range in["hostelNames"].([]any) {
				names = append(names, n.(string))
			}
			got = AccountDeletionReview(names, s("queueUrl"), s("reason"), s("requesterEmail"), s("requesterName"), s("requesterRole"))
		case "consultationRequest":
			var rows []DetailRow
			for _, r := range in["details"].([]any) {
				m := r.(map[string]any)
				rows = append(rows, DetailRow{Label: m["label"].(string), Value: m["value"].(string)})
			}
			got = ConsultationRequest(rows, s("name"))
		case "storeOrderPlacedBuyer":
			got = StoreOrderPlacedBuyer(storeFacts(in), s("createdAt"), s("orderUrl"))
		case "storeOrderReceivedPlatform":
			got = StoreOrderReceivedPlatform(storeFacts(in), s("placedByName"), s("ordersUrl"))
		case "paymentDueReminder":
			got = PaymentDueReminder(int64(in["amount"].(float64)), dueAt(in), s("hostelName"), s("month"), s("paymentsUrl"), s("residentName"), ReminderStage(s("stage")))
		case "paymentOverdue":
			got = PaymentOverdue(int64(in["amount"].(float64)), int(in["daysOverdue"].(float64)), dueAt(in), s("hostelName"), s("month"), s("paymentsUrl"), s("residentName"))
		case "unpaidFees":
			var rows []PaymentLine
			for _, r := range in["residents"].([]any) {
				m := r.(map[string]any)
				line := PaymentLine{Amount: int64(m["amount"].(float64)), Name: m["name"].(string)}
				line.Month, _ = m["month"].(string)
				rows = append(rows, line)
			}
			got = UnpaidFees(s("hostelName"), s("paymentsUrl"), int(in["reminders"].(float64)), rows)
		case "storeOrderStatusBuyer":
			got = StoreOrderStatusBuyer(s("status"), s("orderNumber"), s("orderUrl"), s("deliveryPromise"), s("note"), s("cancelledReason"), int64(in["total"].(float64)), storeItems(in["items"]))
		case "hostelSubmissionReceived":

			got = HostelSubmissionReceived(s("hostelName"), s("ownerName"))
		case "bookingInvoice":
			var rows []RefundRow
			list, _ := in["refundRows"].([]any)
			for _, r := range list {
				m := r.(map[string]any)
				rows = append(rows, RefundRow{FromDay: num(m["fromDay"]), ThroughDay: num(m["throughDay"]), RefundPercent: num(m["refundPercent"]), Refund: int64(m["refund"].(float64))})
			}
			got = BookingInvoice(BookingInvoiceInput{Booking: bookingFacts(in["booking"]), BookingURL: s("bookingUrl"), Name: s("name"), InvoiceNumber: s("invoiceNumber"), PayBy: s("payBy"), PolicyURL: s("policyUrl"),
				HostelAnswerHours: num(in["hostelAnswerHours"]), PaymentCheckHours: num(in["paymentCheckHours"]), NoShowRefund: int64(in["noShowRefund"].(float64)), RefundRows: rows})
		case "bookingEnded":
			paid, _ := in["paid"].(bool)
			got = BookingEnded(bookingFacts(in["booking"]), s("bookingUrl"), s("cause"), s("name"), paid, s("reason"), int64(in["refund"].(float64)), num(in["refundPercent"]), s("refundTo"))
		case "bookingClosedForHostel":
			got = BookingClosedForHostel(s("bookingsUrl"), s("cause"), s("code"), s("guestName"), s("hostelName"), int64(in["hostelShare"].(float64)), s("name"), s("reason"), s("roomType"))
		case "bookingHostelFaultRefund":
			got = BookingHostelFaultRefund(s("cause"), s("code"), s("guestName"), s("hostelName"), s("queueUrl"), s("reason"), int64(in["refund"].(float64)), s("refundTo"), s("roomType"))
		case "bookingsPaused":
			got = BookingsPaused(s("bookingsUrl"), s("hostelName"), s("name"), int64(in["strikes"].(float64)), num(in["windowDays"]))
		case "hostelBookingsPaused":
			got = HostelBookingsPaused(s("hostelName"), s("reviewUrl"), int64(in["strikes"].(float64)), num(in["windowDays"]))
		default:
			t.Fatalf("vector %d: no Go template for %q", i, v.Name)
		}
		if string(got.Category) != v.Out.Category || got.Subject != v.Out.Subject || got.HTML != v.Out.HTML {
			t.Errorf("vector %d (%s %s): category %q/%q subject %q/%q html equal=%v", i, v.Name, v.Input,
				got.Category, v.Out.Category, got.Subject, v.Out.Subject, got.HTML == v.Out.HTML)
		}
	}
}

func num(v any) string { return strconv.FormatFloat(v.(float64), 'f', -1, 64) }

func bookingFacts(v any) BookingFacts {
	m := v.(map[string]any)
	f := BookingFacts{Code: m["code"].(string), Fee: int64(m["fee"].(float64)), HostelName: m["hostelName"].(string), MonthlyRent: int64(m["monthlyRent"].(float64)), RoomType: m["roomType"].(string), Total: int64(m["total"].(float64))}
	if st, ok := m["stay"].(map[string]any); ok {
		f.Stay = &BookingStay{Amount: int64(st["amount"].(float64)), Dates: st["dates"].(string), Nights: int64(st["nights"].(float64))}
	}
	return f
}

func storeItems(v any) []StoreItem {
	var out []StoreItem
	for _, r := range v.([]any) {
		m := r.(map[string]any)
		it := StoreItem{LineTotal: int64(m["lineTotal"].(float64)), Name: m["name"].(string), Quantity: int64(m["quantity"].(float64)), Unit: m["unit"].(string), UnitPrice: int64(m["unitPrice"].(float64))}
		if u, ok := m["imageUrl"].(string); ok {
			it.ImageURL = u
		}
		if n, ok := m["stockAfterOrder"].(float64); ok {
			k := int64(n)
			it.StockAfterOrder = &k
		}
		out = append(out, it)
	}
	return out
}

func storeFacts(in map[string]any) StoreOrderFacts {
	s := func(k string) string { x, _ := in[k].(string); return x }
	n := func(k string) int64 { x, _ := in[k].(float64); return int64(x) }
	return StoreOrderFacts{Address: s("address"), ContactName: s("contactName"), DeliveryPromise: s("deliveryPromise"), HostelName: s("hostelName"), Note: s("note"),
		OrderNumber: s("orderNumber"), Phone: s("phone"), DeliveryFee: n("deliveryFee"), Subtotal: n("subtotal"), Total: n("total"), Items: storeItems(in["items"])}
}

func dueAt(in map[string]any) time.Time {
	t, _ := time.Parse(time.RFC3339, in["dueDate"].(string))
	return t
}
