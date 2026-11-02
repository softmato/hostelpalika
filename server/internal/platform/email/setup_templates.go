package email

import "strings"

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
