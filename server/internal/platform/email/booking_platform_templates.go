package email

import "strings"

// The booking mails sent from the platform's own screens: a payment check
// refused, money sent back or out, a payout account checked.

// BookingPaymentRejected is bookingPaymentRejectedEmail: the screenshot did not match.
func BookingPaymentRejected(b BookingFacts, bookingURL, name, payBy, reason string) Content {
	body := strings.Join([]string{Greeting(name),
		Paragraph("We did not get the money shown in your screenshot."),
		DetailsTable([]DetailRow{{Label: "Reason", Value: reason}}),
		bookingFactsTable(b, []DetailRow{{Label: "Send again by", Value: payBy}}, true),
		Paragraph("If you have paid, send the screenshot from your banking app again. If you have not, pay first."),
		CTAButton(bookingURL, "Send screenshot again"),
	}, "")
	return Content{Category: Billing, Subject: "We could not find your payment — booking " + b.Code, HTML: EmailLayout(Layout{BodyHTML: body, Eyebrow: "Please check",
		Heading: "We could not find your payment", Preheader: "Booking " + b.Code + ": " + reason, Urgent: true})}
}

// BookingRefundSent is bookingRefundSentEmail: the refund has left our account.
func BookingRefundSent(amount int64, b BookingFacts, bookingURL, documentNumber, name, refundTo, sentOn, transactionID string) Content {
	body := strings.Join([]string{Greeting(name),
		Paragraph("We sent your money back."),
		DetailsTable([]DetailRow{{Emphasis: true, Label: "Refund", Value: Rupees(amount)}, {Label: "Sent to", Value: refundTo}, {Label: "Sent on", Value: sentOn},
			{Label: "Transaction ID", Value: transactionID}, {Label: "Refund slip", Value: documentNumber}, {Label: "Booking", Value: b.Code}, {Label: "Hostel", Value: b.HostelName}}),
		Paragraph("It can take some time to show in your bank or wallet. Not there? Contact us with the transaction ID."),
		CTAButton(bookingURL, "View booking"),
	}, "")
	return Content{Category: Billing, Subject: "We sent your money back — " + Rupees(amount), HTML: EmailLayout(Layout{BodyHTML: body, Eyebrow: "Refund", Heading: "We sent your money back",
		Preheader: Rupees(amount) + " sent to " + refundTo + ". Transaction " + transactionID + "."})}
}

// BookingPayoutSent is bookingPayoutSentEmail: the hostel's share has left our account.
func BookingPayoutSent(amount int64, bookingsURL, code, documentNumber, guestName, hostelName, name, paidTo, roomType, sentOn, transactionID string) Content {
	body := strings.Join([]string{Greeting(name),
		Paragraph(PlatformName + " sent " + EscapeHTML(hostelName) + " its part of a booking fee."),
		DetailsTable([]DetailRow{{Emphasis: true, Label: "Amount", Value: Rupees(amount)}, {Label: "Paid to", Value: paidTo}, {Label: "Sent on", Value: sentOn},
			{Label: "Transaction ID", Value: transactionID}, {Label: "Payment slip", Value: documentNumber}, {Label: "Booking", Value: code}, {Label: "Guest", Value: guestName},
			{Label: "Room type", Value: roomType}}),
		CTAButton(bookingsURL, "Open bookings"),
	}, "")
	return Content{Category: Billing, Subject: "We sent you " + Rupees(amount) + " for booking " + code, HTML: EmailLayout(Layout{BodyHTML: body, Eyebrow: "Payment", Heading: "We sent your money",
		Preheader: Rupees(amount) + " sent to " + paidTo + ". Transaction " + transactionID + "."})}
}

// PayoutAccountReviewed is payoutAccountReviewedEmail: verified, or sent back with our note.
func PayoutAccountReviewed(a PayoutAccountFacts, approved bool, hostelName, name, note, settingsURL string) Content {
	subject, heading, eyebrow, cta := "Please fix your payout account — "+hostelName, "Please fix your payout account", "Please fix", "Fix payout account"
	lead := "We could not check <strong>" + EscapeHTML(hostelName) + "</strong>'s payout account. We will not send money until it is fixed."
	pre := "Money for " + hostelName + " is stopped until the account is fixed."
	if approved {
		subject, heading, eyebrow, cta = "Your payout account is OK — "+hostelName, "Your payout account is OK", "Checked", "View payout account"
		lead = "We checked <strong>" + EscapeHTML(hostelName) + "</strong>'s payout account. We will send booking money here."
		pre = "Booking payouts for " + hostelName + " will go to " + a.MaskedNumber + "."
	}
	noteHTML := ""
	if note != "" {
		noteHTML = Paragraph("<strong>Note:</strong> " + EscapeHTML(note))
	}
	body := strings.Join([]string{Greeting(name), Paragraph(lead), payoutRows(a), noteHTML, CTAButton(settingsURL, cta)}, "")
	return Content{Category: Billing, Subject: subject, HTML: EmailLayout(Layout{BodyHTML: body, Eyebrow: eyebrow, Heading: heading, Preheader: pre, Urgent: !approved})}
}
