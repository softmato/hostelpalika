package email

import (
	"strconv"
	"strings"

	"github.com/softmato/hostelpalika/server/internal/platform/money"
)

var roomTypeNames = map[string]string{"double sharing": "Double Sharing Room", "four sharing": "Four Sharing Room", "single": "Single Sitter Room",
	"single room": "Single Sitter Room", "triple sharing": "Triple Sharing Room",
	"three sharing": "Three Sharing Room", "two sharing": "Two Sharing Room"}

// RoomTypeLabel is roomTypeLabel (packages/shared constants/room-types.ts).
func RoomTypeLabel(roomType string) string {
	if roomType == "" {
		return ""
	}
	parts := strings.Split(roomType, " — ")
	base := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(parts[0], "_", " ")))
	if name, ok := roomTypeNames[base]; ok {
		return strings.Join(append([]string{name}, parts[1:]...), " — ")
	}
	return strings.ReplaceAll(roomType, "_", " ")
}

// Rupees is rupees: "Rs 1,000", the way every booking email prints money.
func Rupees(amount int64) string { return "Rs " + money.GroupIN(amount) }

// BookingStay is a short stay's nights, as an email states them.
type BookingStay struct {
	Amount int64
	Dates  string
	Nights int64
}

// BookingFacts is BookingFacts (templates/booking/parts.ts); Total is fee plus nights.
type BookingFacts struct {
	Code, HostelName, RoomType string
	Fee, MonthlyRent, Total    int64
	Stay                       *BookingStay
}

func bookingFactsTable(f BookingFacts, extra []DetailRow, emphasisFee bool) string {
	rows := []DetailRow{{Label: "Booking", Value: f.Code}, {Label: "Hostel", Value: f.HostelName}, {Label: "Room type", Value: f.RoomType}}
	if f.Stay != nil {
		rows = append(rows, DetailRow{Label: "Stay", Value: strconv.FormatInt(f.Stay.Nights, 10) + " nights · " + f.Stay.Dates},
			DetailRow{Label: "Nights", Value: Rupees(f.Stay.Amount)}, DetailRow{Label: "Booking fee", Value: Rupees(f.Fee)},
			DetailRow{Emphasis: emphasisFee, Label: "Total", Value: Rupees(payable(f))})
	} else {
		rows = append(rows, DetailRow{Label: "Monthly rent", Value: Rupees(f.MonthlyRent)}, DetailRow{Emphasis: emphasisFee, Label: "Booking fee", Value: Rupees(f.Fee)})
	}
	return DetailsTable(append(rows, extra...))
}

// RefundRow is RefundLadderRow; days and percent are already as JS prints them.
type RefundRow struct {
	FromDay, ThroughDay, RefundPercent string
	Refund                             int64
}

func refundLadderTable(fee, noShowRefund int64, rows []RefundRow, stay *BookingStay) string {
	out := []DetailRow{{Label: "Cancel before the hostel says yes", Value: Rupees(fee)}, {Label: "Hostel says no or does not answer", Value: Rupees(fee)}}
	if stay != nil {
		oneNight := int64(float64(stay.Amount)/float64(stay.Nights) + 0.5) // Math.round
		out = append(out, DetailRow{Label: "Nights, cancelled before the move-in day", Value: Rupees(stay.Amount) + " (all)"},
			DetailRow{Label: "Nights, cancelled on the move-in day or never checked in", Value: Rupees(stay.Amount-oneNight) + " (one night kept)"},
			DetailRow{Label: "Booking fee, after the hostel says yes", Value: "As below"})
	}
	for _, r := range rows {
		label := "Cancel on days " + r.FromDay + "–" + r.ThroughDay + " after the hostel says yes"
		if r.FromDay == r.ThroughDay {
			label = "Cancel on day " + r.FromDay + " after the hostel says yes"
		}
		out = append(out, DetailRow{Label: label, Value: Rupees(r.Refund) + " (" + r.RefundPercent + "%)"})
	}
	return DetailsTable(append(out, DetailRow{Label: "Never move in", Value: Rupees(noShowRefund)}))
}

// BookingInvoiceInput is bookingInvoiceEmail's argument.
type BookingInvoiceInput struct {
	Booking                                           BookingFacts
	BookingURL, Name, InvoiceNumber, PayBy, PolicyURL string
	HostelAnswerHours, PaymentCheckHours              string
	NoShowRefund                                      int64
	RefundRows                                        []RefundRow
}

// BookingInvoice is bookingInvoiceEmail: sent when the booking is created.
func BookingInvoice(in BookingInvoiceInput) Content {
	b := in.Booking
	body := strings.Join([]string{
		Greeting(in.Name),
		Paragraph("Please pay to book your bed at <strong>" + EscapeHTML(b.HostelName) + "</strong>."),
		bookingFactsTable(b, []DetailRow{{Label: "Bill no.", Value: in.InvoiceNumber}, {Label: "Pay by", Value: in.PayBy}}, true),
		Paragraph("Open your booking and scan the " + PlatformName + " QR. Pay <strong>" + Rupees(payable(b)) + "</strong> and write <strong>" + EscapeHTML(b.Code) + "</strong> in the remarks. Then send us the payment screenshot."),
		CTAButton(in.BookingURL, "Pay booking fee"),
		Paragraph("We check it in " + in.PaymentCheckHours + " hours. Then the hostel has " + in.HostelAnswerHours + " hours to say yes to your bed."),
		Paragraph("<strong>Refunds</strong>"),
		refundLadderTable(payable(b), in.NoShowRefund, in.RefundRows, b.Stay),
		SmallPrint("Refund rules: " + TextLink(in.PolicyURL, "read here") + "."),
	}, "")
	return Content{Category: Billing, Subject: "Please pay " + Rupees(payable(b)) + " to book your bed — " + b.HostelName, HTML: EmailLayout(Layout{BodyHTML: body, Eyebrow: "Bill", Heading: "Please pay your booking fee",
		Preheader: "Pay " + Rupees(payable(b)) + " with code " + b.Code + " to book " + RoomTypeLabel(b.RoomType) + " at " + b.HostelName + "."})}
}

// bookingEndedCopy is ENDED_COPY; {h} is the escaped hostel name.
var bookingEndedCopy = map[string][2]string{
	"CANCELLED_BEFORE_CONFIRMATION": {"Booking cancelled", "You cancelled this booking before the hostel said yes."},
	"CANCELLED_BY_HOSTEL":           {"The hostel cancelled your booking", "{h} cancelled your booking."},
	"CANCELLED_BY_PLATFORM":         {"Booking cancelled by " + PlatformName, PlatformName + " cancelled this booking."},
	"CANCELLED_BY_USER":             {"Booking cancelled", "You cancelled this booking. The bed is no longer kept for you."},
	"DECLINED":                      {"The hostel said no", "{h} said no to your booking."},
	"EXPIRED":                       {"Booking closed", "We did not get your payment screenshot in time, so this booking is closed."},
	"HOSTEL_NO_RESPONSE":            {"The hostel did not answer", "{h} did not answer in time, so the booking is cancelled."},
	"NO_SHOW":                       {"Your booking has ended", "You did not move in on time, so the bed is no longer kept for you."},
}

// BookingEnded is bookingEndedEmail: sent on every ending.
func BookingEnded(b BookingFacts, bookingURL, cause, name string, paid bool, reason string, refund int64, refundPercent, refundTo string) Content {
	text := bookingEndedCopy[cause]
	hostel := EscapeHTML(b.HostelName)
	var moneyHTML string
	switch {
	case !paid:
		moneyHTML = Paragraph("You did not pay anything, so you owe nothing.")
	case refund > 0:
		moneyHTML = DetailsTable([]DetailRow{{Emphasis: true, Label: "Refund", Value: Rupees(refund) + " (" + refundPercent + "%)"}, {Label: "Refund to", Value: refundTo}}) +
			Paragraph("We will send the money to the account above and email you the transaction ID.")
	default:
		moneyHTML = Paragraph("As per the refund rules, no money comes back.")
	}
	eyebrow, pre := "Booking", "Booking "+b.Code+" at "+b.HostelName+" has ended."
	if paid && refund > 0 {
		eyebrow, pre = "Refund", "We will send "+Rupees(refund)+" of your booking fee back to "+refundTo+"."
	}
	body := strings.Join([]string{Greeting(name), Paragraph(strings.ReplaceAll(text[1], "{h}", hostel)),
		bookingFactsTable(b, []DetailRow{{Label: "Reason", Value: reason}}, false), moneyHTML, CTAButton(bookingURL, "View booking")}, "")
	return Content{Category: Billing, Subject: text[0] + " — booking " + b.Code, HTML: EmailLayout(Layout{BodyHTML: body, Eyebrow: eyebrow, Heading: text[0], Preheader: pre})}
}

var bookingClosedCopy = map[string][2]string{
	"CANCELLED_BEFORE_CONFIRMATION": {"Booking cancelled by the guest", "The guest cancelled before you answered. You do not need to do anything."},
	"CANCELLED_BY_PLATFORM":         {"Booking cancelled by " + PlatformName, PlatformName + " cancelled this booking and refunded the guest."},
	"DECLINED":                      {"You said no to a booking", "You said no to this booking. " + PlatformName + " gives the guest all the money back. You do not need to do anything."},
	"CANCELLED_BY_USER":             {"Booking cancelled by the guest", "The guest cancelled. The bed is free again."},
	"HOSTEL_NO_RESPONSE":            {"Booking missed", "Nobody answered this booking in time. The guest gets all the money back. This counts as a missed booking for your hostel."},
	"NO_SHOW":                       {"Guest did not move in", "The guest did not move in on time. The bed is free again."},
}

// BookingClosedForHostel is bookingClosedForHostelEmail.
func BookingClosedForHostel(bookingsURL, cause, code, guestName, hostelName string, hostelShare int64, name, reason, roomType string) Content {
	c := bookingClosedCopy[cause]
	share := ""
	if hostelShare > 0 {
		share = Rupees(hostelShare)
	}
	body := strings.Join([]string{Greeting(name), Paragraph(c[1]), DetailsTable([]DetailRow{{Label: "Booking", Value: code}, {Label: "Guest", Value: guestName}, {Label: "Room type", Value: roomType},
		{Label: "Reason", Value: reason}, {Emphasis: hostelShare > 0, Label: "Your share", Value: share}}), CTAButton(bookingsURL, "Open bookings")}, "")
	return Content{Category: Billing, Subject: c[0] + " — " + guestName + ", " + RoomTypeLabel(roomType), HTML: EmailLayout(Layout{BodyHTML: body, Eyebrow: "Bookings", Heading: c[0],
		Preheader: code + " at " + hostelName + ": " + c[1]})}
}

var hostelFaultCopy = map[string][2]string{
	"CANCELLED_BY_HOSTEL": {"cancelled this booking after confirming it", "cancelled"},
	"DECLINED":            {"declined this booking", "declined"},
	"HOSTEL_NO_RESPONSE":  {"did not answer this booking in time", "did not answer"},
}

// BookingHostelFaultRefund is bookingHostelFaultRefundEmail.
func BookingHostelFaultRefund(cause, code, guestName, hostelName, queueURL, reason string, refund int64, refundTo, roomType string) Content {
	c := hostelFaultCopy[cause]
	body := strings.Join([]string{Paragraph(EscapeHTML(hostelName) + " " + c[0] + ". Check and send the refund."),
		DetailsTable([]DetailRow{{Label: "Booking", Value: code}, {Label: "Guest", Value: guestName}, {Label: "Hostel", Value: hostelName}, {Label: "Room", Value: roomType},
			{Label: "Reason", Value: reason}, {Emphasis: true, Label: "Refund", Value: Rupees(refund)}, {Label: "Refund to", Value: refundTo}}),
		CTAButton(queueURL, "Send refund")}, "")
	return Content{Category: Alert, Subject: "Refund to send — " + hostelName + " " + c[1] + " booking " + code, HTML: EmailLayout(Layout{BodyHTML: body, Eyebrow: "Bookings", Heading: "Refund to send",
		Preheader: hostelName + " " + c[1] + " " + code + ". Refund " + Rupees(refund) + " to " + guestName + "."})}
}

// BookingsPaused is bookingsPausedEmail: to the hostel's admins.
func BookingsPaused(bookingsURL, hostelName, name string, strikes int64, windowDays string) Content {
	n := strconv.FormatInt(strikes, 10)
	body := strings.Join([]string{Greeting(name), Paragraph(EscapeHTML(hostelName) + " missed or cancelled " + n + " bookings in " + windowDays + " days. So people cannot book it now."),
		Paragraph("Bookings you already said yes to stay the same. Contact " + PlatformName + " to turn bookings on again."), CTAButton(bookingsURL, "Open bookings")}, "")
	return Content{Category: Billing, Subject: "Bookings are stopped for " + hostelName, HTML: EmailLayout(Layout{BodyHTML: body, Eyebrow: "Bookings", Heading: "Bookings are stopped",
		Preheader: n + " missed or cancelled bookings in " + windowDays + " days.", Urgent: true})}
}

// HostelBookingsPaused is hostelBookingsPausedEmail: to the superadmins.
func HostelBookingsPaused(hostelName, reviewURL string, strikes int64, windowDays string) Content {
	n := strconv.FormatInt(strikes, 10)
	body := strings.Join([]string{Paragraph(EscapeHTML(hostelName) + " missed or cancelled " + n + " bookings in " + windowDays + " days. Its Book button is off until a superadmin turns it on."),
		CTAButton(reviewURL, "Review hostel")}, "")
	return Content{Category: Alert, Subject: "Bookings stopped — " + hostelName, HTML: EmailLayout(Layout{BodyHTML: body, Eyebrow: "Bookings", Heading: "Hostel bookings stopped",
		Preheader: hostelName + ": " + n + " strikes in " + windowDays + " days."})}
}

// ConfirmedStep is one line of the cancel ladder in the confirmation mail.
type ConfirmedStep struct {
	Refund        int64
	RefundPercent string
	Until         string
}

// BookingConfirmed is bookingConfirmedEmail: the hostel said yes.
func BookingConfirmed(b BookingFacts, address, bookingURL, directionsURL, holdEndsAt, hostelPhone, landmark, name string, noShowRefund int64, schedule []ConfirmedStep) Content {
	steps := make([]DetailRow, 0, len(schedule)+1)
	for _, s := range schedule {
		steps = append(steps, DetailRow{Label: "Cancel before " + s.Until, Value: Rupees(s.Refund) + " back (" + s.RefundPercent + "%)"})
	}
	steps = append(steps, DetailRow{Label: "Not moved in by " + holdEndsAt, Value: Rupees(noShowRefund) + " back"})
	directions := ""
	if directionsURL != "" {
		directions = CTAButton(directionsURL, "Get directions")
	}
	body := strings.Join([]string{Greeting(name),
		Paragraph("<strong>" + EscapeHTML(b.HostelName) + "</strong> said yes. One " + EscapeHTML(b.RoomType) + " bed is kept for you until <strong>" + EscapeHTML(holdEndsAt) + "</strong>."),
		DetailsTable([]DetailRow{{Label: "Booking", Value: b.Code}, {Label: "Room type", Value: b.RoomType}, {Label: "Monthly rent", Value: Rupees(b.MonthlyRent)},
			{Emphasis: true, Label: "Move in by", Value: holdEndsAt}, {Label: "Address", Value: address}, {Label: "Landmark", Value: landmark}, {Label: "Hostel phone", Value: hostelPhone}}),
		directions,
		Paragraph("At the hostel, show your " + PlatformName + " ID card. The hostel scans it and you can move in."),
		Paragraph("<strong>If you cancel</strong>"), DetailsTable(steps),
		SmallPrint("The booking fee is not part of your rent, admission fee or deposit. You pay those to the hostel. " + TextLink(bookingURL, "View booking") + "."),
	}, "")
	return Content{Category: Billing, Subject: "Your bed is booked at " + b.HostelName + " — move in by " + holdEndsAt, HTML: EmailLayout(Layout{BodyHTML: body, Eyebrow: "Booked", Heading: "Your bed is booked",
		Preheader: "One " + RoomTypeLabel(b.RoomType) + " bed at " + b.HostelName + " is kept for you until " + holdEndsAt + "."})}
}

func payable(f BookingFacts) int64 {
	if f.Total != 0 {
		return f.Total
	}
	return f.Fee
}

// BookingPaymentVerified is bookingPaymentVerifiedEmail: the guest's receipt.
func BookingPaymentVerified(b BookingFacts, bookingURL, hostelAnswerBy, name, paidOn, receiptNumber string) Content {
	body := strings.Join([]string{Greeting(name),
		Paragraph("We got your booking fee. " + PlatformName + " keeps it safe until the booking ends."),
		bookingFactsTable(b, []DetailRow{{Label: "Receipt", Value: receiptNumber}, {Label: "Paid on", Value: paidOn}, {Label: "Hostel answers by", Value: hostelAnswerBy}}, true),
		Paragraph("Now " + EscapeHTML(b.HostelName) + " will say yes or no. If it says no or does not answer by " + EscapeHTML(hostelAnswerBy) + ", you get all " + Rupees(payable(b)) + " back."),
		CTAButton(bookingURL, "View booking"),
	}, "")
	return Content{Category: Billing, Subject: "We got your booking fee — " + b.HostelName, HTML: EmailLayout(Layout{BodyHTML: body, Eyebrow: "Receipt", Heading: "We got your booking fee",
		Preheader: "Receipt " + receiptNumber + ": " + Rupees(payable(b)) + " for booking " + b.Code + "."})}
}

// BookingRequest is bookingRequestEmail: a paid booking for the hostel to answer.
func BookingRequest(answerBy string, answerHours float64, bookingsURL, code, guestName, guestPhone string, holdDays float64, hostelName string, hostelShare int64, name, roomType string) Content {
	num := func(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }
	body := strings.Join([]string{Greeting(name),
		Paragraph("<strong>" + EscapeHTML(guestName) + "</strong> booked a <strong>" + EscapeHTML(roomType) + "</strong> at " + EscapeHTML(hostelName) + " and paid the booking fee to " + PlatformName + "."),
		DetailsTable([]DetailRow{{Label: "Booking", Value: code}, {Label: "Guest", Value: guestName}, {Label: "Phone", Value: guestPhone}, {Label: "Room type", Value: roomType},
			{Emphasis: true, Label: "Answer by", Value: answerBy}, {Label: "You get after they move in", Value: Rupees(hostelShare)}}),
		Paragraph("Say yes to keep one bed for " + num(holdDays) + " days. They move in when you scan their " + PlatformName + " ID card."),
		CTAButton(bookingsURL, "Say yes or no"),
		SmallPrint("If you do not answer in " + num(answerHours) + " hours, the booking is cancelled, the guest gets all the money back, and it counts as a missed booking."),
	}, "")
	return Content{Category: Billing, Subject: "New booking from " + guestName + " — please answer by " + answerBy, HTML: EmailLayout(Layout{BodyHTML: body, Eyebrow: "New booking", Heading: "You have a new booking",
		Preheader: guestName + " booked a " + RoomTypeLabel(roomType) + ". Answer by " + answerBy + "."})}
}

// BookingProofReceived is bookingProofReceivedEmail: the screenshot arrived; nothing is confirmed yet.
func BookingProofReceived(b BookingFacts, bookingURL, checkBy, name, reference string) Content {
	body := strings.Join([]string{Greeting(name),
		Paragraph("We got your payment screenshot. We are checking it now."),
		bookingFactsTable(b, []DetailRow{{Label: "Your reference", Value: reference}, {Label: "We check by", Value: checkBy}}, true),
		Paragraph("We will email you when it is checked."),
		CTAButton(bookingURL, "View booking"),
	}, "")
	return Content{Category: Billing, Subject: "We got your payment screenshot — booking " + b.Code, HTML: EmailLayout(Layout{BodyHTML: body, Eyebrow: "Payment", Heading: "We got your screenshot",
		Preheader: "We are checking your " + Rupees(payable(b)) + " payment for booking " + b.Code + "."})}
}

// BookingProofToCheck is bookingProofToCheckEmail: a screenshot for the platform to match against money received.
func BookingProofToCheck(amount int64, checkBy, code, guestName, hostelName, queueURL, reference string) Content {
	body := strings.Join([]string{
		Paragraph("A booking fee screenshot is waiting. Check it with our bank account."),
		DetailsTable([]DetailRow{{Label: "Booking", Value: code}, {Label: "Guest", Value: guestName}, {Label: "Hostel", Value: hostelName},
			{Label: "Amount", Value: Rupees(amount), Emphasis: true}, {Label: "Their reference", Value: reference}, {Label: "Check by", Value: checkBy}}),
		CTAButton(queueURL, "Check payment"),
	}, "")
	return Content{Category: Alert, Subject: "Booking payment to check — " + Rupees(amount) + " (" + code + ")", HTML: EmailLayout(Layout{BodyHTML: body, Eyebrow: "Bookings", Heading: "Booking payment to check",
		Preheader: guestName + " sent a screenshot for " + Rupees(amount) + " (" + code + ")."})}
}
