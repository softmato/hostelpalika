package email

import (
	"strconv"
	"strings"
)

// PayoutAccountFacts is the account block of the payout emails.
type PayoutAccountFacts struct {
	MethodLabel, HolderName, BankName, MaskedNumber string
}

func payoutRows(a PayoutAccountFacts) string {
	return DetailsTable([]DetailRow{{Label: "Paid to", Value: a.MethodLabel}, {Label: "Name on account", Value: a.HolderName}, {Label: "Bank", Value: a.BankName}, {Label: "Number", Value: a.MaskedNumber}})
}

// PayoutAccountChanged is payoutAccountChangedEmail (no support address).
func PayoutAccountChanged(a PayoutAccountFacts, changedAt, hostelName, name, settingsURL string) Content {
	return Content{Category: Security, Subject: "Payout account changed for " + hostelName, HTML: EmailLayout(Layout{
		BodyHTML: strings.Join([]string{
			Greeting(name),
			Paragraph("The account where " + PlatformName + " sends <strong>" + EscapeHTML(hostelName) + "</strong>'s booking money was changed on " + EscapeHTML(changedAt) + "."),
			payoutRows(a),
			Paragraph("We check every new account before we send money to it."),
			CTAButton(settingsURL, "View payout account"),
			SmallPrint("Not you? Reply to this email now."),
		}, ""),
		Eyebrow: "Security", Heading: "Payout account changed",
		Preheader: "After we check it, money for " + hostelName + " will go to " + a.MethodLabel + " " + a.MaskedNumber + ".",
	})}
}

// HostelLeaveRequested is hostelLeaveRequestedEmail: to the owner, we got it.
func HostelLeaveRequested(holdDays int, hostelName, ownerName, pageURL string) Content {
	return Content{Category: Info, Subject: "We got your request to leave — " + hostelName, HTML: EmailLayout(Layout{
		Heading: "Request to leave received",
		BodyHTML: strings.Join([]string{
			Greeting(ownerName),
			Paragraph("We got your request to take <strong>" + EscapeHTML(hostelName) + "</strong> off HostelPalika. Our team will check it and write to you."),
			DetailsTable([]DetailRow{{Label: "Hostel", Value: hostelName}, {Label: "We hold your data for", Value: strconv.Itoa(holdDays) + " days after approval"}}),
			Paragraph("Nothing changes until we approve it. You can cancel it until then."),
			CTAButton(pageURL, "Open request"),
		}, "\n"),
	})}
}

// HostelLeavePending is hostelLeavePendingEmail: to platform staff.
func HostelLeavePending(holdDays int, hostelName, ownerEmail, ownerName, queueURL, reason string) Content {
	return Content{Category: Info, Subject: "Hostel wants to leave — " + hostelName, HTML: EmailLayout(Layout{
		Heading: "Hostel wants to leave",
		BodyHTML: strings.Join([]string{
			Paragraph("A hostel owner asked to take their hostel off HostelPalika. Their plan bills are cleared."),
			DetailsTable([]DetailRow{{Label: "Hostel", Value: hostelName}, {Label: "Owner", Value: ownerName}, {Label: "Email", Value: ownerEmail}, {Label: "Hold data for", Value: strconv.Itoa(holdDays) + " days"}, {Label: "Reason", Value: reason}}),
			CTAButton(queueURL, "Review request"),
		}, "\n"),
	})}
}

// HostelAgreement is hostelAgreementEmail: the signed PDF rides on it.
func HostelAgreement(hostelName, ownerName, refCode string) Content {
	return Content{Category: Info, Subject: "Your HostelPalika agreement for " + hostelName, HTML: EmailLayout(Layout{
		Heading: "Your signed agreement",
		BodyHTML: strings.Join([]string{
			hello(ownerName),
			Paragraph("Thank you for signing. Your agreement with HostelPalika for <strong>" + EscapeHTML(hostelName) + "</strong> is attached as a PDF, number <strong>" + EscapeHTML(refCode) + "</strong>. Please keep it safe."),
			Paragraph("It says what you get, how your data is kept safe, and how you can take all of your data with you if you ever leave."),
		}, "\n"),
	})}
}
