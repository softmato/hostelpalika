package email

import (
	"strconv"
	"strings"
	"time"

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

// GatewayUnhealthy is gatewayUnhealthyEmail: the hostel's online checkout is not
// working, which no screen the owner looks at would show them.
func GatewayUnhealthy(detail, hostelName, providerName, setupURL, title string) Content {
	return Content{Category: Alert, Subject: title + " · " + hostelName, HTML: EmailLayout(Layout{
		Heading: title,
		BodyHTML: strings.Join([]string{
			Paragraph(EscapeHTML(detail)),
			Paragraph("Your " + EscapeHTML(providerName) + " details may have changed (key, merchant code, or your bank turned off online payments). The money you already got is safe."),
			Paragraph("Residents can still pay by QR, wallet or bank. That money still reaches you."),
			CTAButton(setupURL, "Check payment settings"),
		}, "\n"),
	})}
}

// ReminderStage is which of the three pre-due notices: "WEEK", "SOON" or "TODAY".
type ReminderStage string

// PaymentDueReminder is paymentDueReminderEmail (currency NPR). WEEK says "soon":
// it is the rung a hostel can move, so it never names a number of days.
func PaymentDueReminder(amount int64, dueDate time.Time, hostelName, month, paymentsURL, residentName string, stage ReminderStage) Content {
	heading, lead := "Please pay your hostel fee soon", "must be paid soon"
	switch stage {
	case "TODAY":
		heading, lead = "Please pay your hostel fee today", "must be paid today"
	case "SOON":
		heading, lead = "Please pay your hostel fee in 3 days", "must be paid in 3 days"
	}
	return Content{Category: Billing, Subject: heading + " — " + MonthName(month) + " · " + hostelName, HTML: EmailLayout(Layout{
		Heading: heading,
		BodyHTML: strings.Join([]string{
			Paragraph("Hi " + EscapeHTML(residentName) + ", your <strong>" + EscapeHTML(MonthName(month)) + "</strong> fee at " + EscapeHTML(hostelName) + " " + lead + "."),
			Paragraph("To pay: <strong>NPR " + money.GroupUS(amount) + "</strong><br/>Pay by: <strong>" + EscapeHTML(EmailDate(dueDate)) + "</strong>"),
			Paragraph("Pay the way you always do. Then send a photo of the payment so the hostel can check it."),
			CTAButton(paymentsURL, "Send payment photo"),
		}, "\n"),
	})}
}

// PaymentOverdue is paymentOverdueEmail (currency NPR).
func PaymentOverdue(amount int64, daysOverdue int, dueDate time.Time, hostelName, month, paymentsURL, residentName string) Content {
	label := "days"
	if daysOverdue == 1 {
		label = "day"
	}
	return Content{Category: Alert, Subject: "Please pay your hostel fee — " + MonthName(month) + " · " + hostelName, HTML: EmailLayout(Layout{
		Heading: "Your hostel fee is late",
		Urgent:  true,
		BodyHTML: strings.Join([]string{
			Paragraph("Hi " + EscapeHTML(residentName) + ", your <strong>" + EscapeHTML(MonthName(month)) + "</strong> fee at " + EscapeHTML(hostelName) + " is <strong>" + strconv.Itoa(daysOverdue) + " " + label + "</strong> late. Please pay now."),
			Paragraph("To pay: <strong>NPR " + money.GroupUS(amount) + "</strong><br/>Last date was: <strong>" + EscapeHTML(EmailDate(dueDate)) + "</strong>"),
			Paragraph("Already paid? Send a photo of the payment so the hostel can check it."),
			CTAButton(paymentsURL, "Send payment photo"),
		}, "\n"),
	})}
}
