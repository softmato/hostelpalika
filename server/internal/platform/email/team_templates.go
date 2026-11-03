package email

import (
	"strconv"
	"strings"
)

// FreeSpan is freeSpan (templates/hostel/hostel-verified.ts): "15 days" for a
// trial, "3 months" for free months chosen before trials.
func FreeSpan(days *int, months int) string {
	if days != nil && *days != 0 {
		return plural(*days, "day", "days")
	}
	return plural(months, "month", "months")
}

func plural(n int, one, many string) string {
	if n == 1 {
		return strconv.Itoa(n) + " " + one
	}
	return strconv.Itoa(n) + " " + many
}

// FreeTime is the free time a plan went live on: a trial (Days) or free months.
type FreeTime struct {
	Days   *int
	Months int
	Until  string
}

// HostelRegisteredByTeam is hostelRegisteredByTeamEmail (templates/hostel/hostel-registered-by-team.ts).
func HostelRegisteredByTeam(agentName string, amountPaid int64, billingURL, dueBy string, free *FreeTime, hostelName, listingURL string,
	outstanding int64, ownerName, planName string, setupFee int64, supportPhone string) Content {
	owes := outstanding > 0
	call := "reply to this email"
	if supportPhone != "" {
		call = "call us on " + EscapeHTML(supportPhone)
	}
	intro := "<strong>" + EscapeHTML(hostelName) + "</strong> is now online. Students can see it."
	if agentName != "" {
		intro = "<strong>" + EscapeHTML(agentName) + "</strong> from our team added <strong>" + EscapeHTML(hostelName) + "</strong> with you. It is now online. Students can see it."
	}
	plan := planName
	if free != nil {
		plan = planName + " — free until " + free.Until
	}
	rows := []DetailRow{{Label: "Plan", Value: plan}}
	if setupFee != 0 {
		rows = append(rows, DetailRow{Label: "Setup fee paid", Value: Rupees(setupFee)})
	} else {
		paid := ""
		if amountPaid > 0 {
			paid = Rupees(amountPaid)
		}
		rows = append(rows, DetailRow{Label: "Paid today", Value: paid})
	}
	if owes {
		rows = append(rows, DetailRow{Label: "Left to pay", Value: Rupees(outstanding), Emphasis: true}, DetailRow{Label: "Pay by", Value: dueBy})
	}
	body := []string{Greeting(ownerName), Paragraph(intro), DetailsTable(rows)}
	if free != nil {
		body = append(body, Paragraph("Your plan is free for "+FreeSpan(free.Days, free.Months)+", until "+EscapeHTML(free.Until)+". There is nothing to pay for it until then. After that, recharge this hostel yourself from Billing on the website, or "+call+"."))
	}
	if setupFee != 0 {
		body = append(body, SmallPrint("You paid our team member a setup fee of "+Rupees(setupFee)+". That is the only amount they may take. If you paid them more, or anything for the plan, please "+call+"."))
	}
	if owes && billingURL != "" {
		body = append(body, CTAButton(billingURL, "Pay now"), SmallPrint("Your hostel stays online while you pay. "+TextLink(listingURL, "See your hostel")))
	} else {
		line := "Your plan is fully paid. Nothing more to pay."
		switch {
		case owes:
			line = "You can pay the rest from your dashboard. Your hostel stays online."
		case free != nil:
			line = "Nothing more to pay today."
		}
		body = append(body, Paragraph(line), CTAButton(listingURL, "See your hostel"))
	}
	pre := hostelName + " is online and your plan is fully paid."
	switch {
	case owes:
		pre = hostelName + " is online. Please pay " + Rupees(outstanding)
		if dueBy != "" {
			pre += " by " + dueBy
		}
		pre += "."
	case free != nil:
		pre = hostelName + " is online, free until " + free.Until + "."
	}
	return Content{Category: Info, Subject: hostelName + " is now online on " + PlatformName, HTML: EmailLayout(Layout{
		BodyHTML: strings.Join(body, "\n"), Heading: "Your hostel is online", Preheader: pre,
	})}
}

// SubscriptionInvoice is subscriptionInvoiceEmail (templates/billing/subscription-invoice.ts).
func SubscriptionInvoice(actionLabel, actionURL string, amount int64, attached bool, cycleLabel, documentURL, dueAt string, goesLiveOnPayment bool,
	hostelName, invoiceNumber, ownerName, planName string) Content {
	body := []string{
		Greeting(ownerName),
		Paragraph("Here is your bill for <strong>" + EscapeHTML(planName) + "</strong> (<strong>" + EscapeHTML(hostelName) + "</strong>)."),
		DetailsTable([]DetailRow{{Label: "Amount", Value: Rupees(amount), Emphasis: true}, {Label: "Plan", Value: planName + " · " + cycleLabel},
			{Label: "Bill no.", Value: invoiceNumber}, {Label: "Pay by", Value: dueAt}}),
		CTAButton(actionURL, actionLabel),
	}
	if goesLiveOnPayment {
		body = append(body, SmallPrint("Your hostel shows online after you pay."))
	}
	if attached {
		body = append(body, SmallPrint("The bill (PDF) is attached."))
	} else if documentURL != "" {
		body = append(body, SmallPrint(TextLink(documentURL, "Download the bill")+" (PDF)."))
	}
	pre := Rupees(amount) + " for " + planName
	if dueAt != "" {
		pre += ", pay by " + dueAt
	}
	return Content{Category: Billing, Subject: "Your hostel plan bill — " + hostelName, HTML: EmailLayout(Layout{
		BodyHTML: strings.Join(body, "\n"), Eyebrow: "Bill", Heading: "Your plan bill", Preheader: pre + ".",
	})}
}

// FieldCashReceived is the email submitFieldCash sends once Softmato has the cash
// (billing/cash-filing.service.ts; inline there, no template file).
func FieldCashReceived(amount int64, collectedBy, planName, transactionID string) Content {
	if collectedBy == "" {
		collectedBy = "Field agent"
	}
	return Content{Category: Billing, Subject: Rupees(amount) + " cash received — receipt to follow", HTML: EmailLayout(Layout{
		BodyHTML: Paragraph("We have your cash payment for <strong>"+EscapeHTML(planName)+"</strong>.") +
			DetailsTable([]DetailRow{{Label: "Amount", Value: Rupees(amount), Emphasis: true}, {Label: "Received by", Value: collectedBy}, {Label: "Reference", Value: transactionID}}) +
			SmallPrint("Your receipt will be emailed to you once we verify this cash. Thank you for your patience."),
		Eyebrow: "Cash received", Heading: "Cash payment received", Preheader: Rupees(amount) + " cash received. Your receipt follows once it is confirmed.",
	})}
}
