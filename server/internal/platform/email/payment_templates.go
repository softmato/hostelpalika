package email

import (
	"strconv"
	"strings"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
)

// MonthName is monthName: a BS key by its BS name, an old Gregorian key in English,
// anything else as it stands.
func MonthName(period string) string {
	if period == "" {
		return ""
	}
	if bs.IsBsPeriod(period) {
		if named := bs.FormatPeriod(period); named != "" {
			return named
		}
	}
	if len(period) == 7 && period[4] == '-' {
		if m, err := strconv.Atoi(period[5:]); err == nil && m >= 1 && m <= 12 {
			return monthNames[m-1] + " " + period[:4]
		}
	}
	return period
}

// PaymentVerified is paymentVerifiedEmail.
func PaymentVerified(amount int64, certificationCode, hostelName, month, offerProgramURL, paymentsURL, receiptNumber string, remaining int64, residentName string) Content {
	still := "Nothing"
	if remaining > 0 {
		still = money.FormatNPR(remaining)
	}
	small, cta := "Next time, write your reference code when you pay, so it counts for the Resident Offer Program.", paymentsURL
	if certificationCode != "" {
		small, cta = "This receipt counts for the Resident Offer Program.", offerProgramURL
	}
	return Content{Category: Billing, Subject: "Payment received — " + MonthName(month) + " · " + hostelName, HTML: EmailLayout(Layout{
		Heading: "Payment received",
		BodyHTML: strings.Join([]string{
			Paragraph("Hi " + EscapeHTML(residentName) + ", " + EscapeHTML(hostelName) + " got your payment. Thank you."),
			DetailsTable([]DetailRow{{Emphasis: true, Label: "Amount", Value: money.FormatNPR(amount)}, {Label: "Month", Value: MonthName(month)}, {Label: "Receipt number", Value: receiptNumber},
				{Label: "Still to pay", Value: still}, {Label: "Verification code", Value: certificationCode}}),
			SmallPrint(small),
			CTAButton(cta, "View receipt"),
		}, "\n"),
	})}
}

// PaymentRejected is paymentRejectedEmail.
func PaymentRejected(hostelName, month, paymentsURL, reason, residentName string) Content {
	return Content{Category: Billing, Subject: "Please send your payment photo again — " + MonthName(month) + " · " + hostelName, HTML: EmailLayout(Layout{
		Heading: "Your payment photo was not accepted",
		BodyHTML: strings.Join([]string{
			Paragraph("Hi " + EscapeHTML(residentName) + ", " + EscapeHTML(hostelName) + " could not check your payment photo for <strong>" + EscapeHTML(MonthName(month)) + "</strong>."),
			Paragraph("Reason: <strong>" + EscapeHTML(reason) + "</strong>"),
			Paragraph("Please send a correct photo again from your dashboard."),
			CTAButton(paymentsURL, "Send photo again"),
		}, "\n"),
	})}
}

// PaymentReversed is paymentReversedEmail.
func PaymentReversed(amount int64, hostelName string, outstanding int64, paymentsURL string, period *string, reason, residentName string) Content {
	forPeriod, subjectPeriod := "", ""
	if period != nil && *period != "" {
		forPeriod = " for <strong>" + EscapeHTML(MonthName(*period)) + "</strong>"
		subjectPeriod = " — " + *period
	}
	owed := "The receipt for this payment is cancelled. You have nothing to pay now."
	if outstanding > 0 {
		owed = "You now need to pay <strong>NPR " + money.GroupUS(outstanding) + "</strong>. The receipt for this payment is cancelled."
	}
	return Content{Category: Billing, Subject: "A payment was cancelled" + subjectPeriod + " · " + hostelName, HTML: EmailLayout(Layout{
		Heading: "A payment was cancelled",
		BodyHTML: strings.Join([]string{
			Paragraph("Hi " + EscapeHTML(residentName) + ", " + EscapeHTML(hostelName) + " cancelled a payment of <strong>NPR " + money.GroupUS(amount) + "</strong>" + forPeriod + "."),
			Paragraph("Reason: <strong>" + EscapeHTML(reason) + "</strong>"),
			Paragraph(owed),
			Paragraph("Think this is wrong? Talk to your hostel."),
			CTAButton(paymentsURL, "View payments"),
		}, "\n"),
	})}
}
