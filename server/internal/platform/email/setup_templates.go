package email

import (
	"strconv"
	"strings"
	"time"

	"github.com/softmato/hostelpalika/server/internal/platform/money"
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

// HostelChangeRequest is hostelChangeRequestEmail: to every superadmin.
func HostelChangeRequest(change, hostelName, hostelSlug, newValue, reason string) Content {
	return Content{Category: Support, Subject: "Change request: " + change + " — " + hostelName, HTML: EmailLayout(Layout{
		Heading: "A hostel asked for a change",
		BodyHTML: strings.Join([]string{
			DetailsTable([]DetailRow{{Label: "Hostel", Value: hostelName + " (" + hostelSlug + ")"}, {Label: "Change", Value: change}, {Label: "New value", Value: newValue}, {Label: "Reason", Value: reason}}),
			Paragraph("Check it, then make the change in the platform portal. The owner gets an email when it is done."),
		}, "\n"),
	})}
}

// SubscriptionClaimReceived is subscriptionClaimReceivedEmail.
func SubscriptionClaimReceived(amount int64, hostelName, invoiceNumber, ownerName, planName, reference, worksUntil string) Content {
	small := "Your plan keeps working while we check."
	if worksUntil != "" {
		small = "Your plan keeps working until " + EscapeHTML(worksUntil) + "."
	}
	shown := "Rs " + money.GroupIN(amount)
	return Content{Category: Billing, Subject: "We got your payment photo — " + shown, HTML: EmailLayout(Layout{
		Heading: "We got your payment photo",
		BodyHTML: strings.Join([]string{
			Greeting(ownerName),
			Paragraph("Thank you. We will check it in 1–2 working days and email you."),
			DetailsTable([]DetailRow{{Emphasis: true, Label: "Amount", Value: shown}, {Label: "Plan", Value: planName}, {Label: "Hostel", Value: hostelName}, {Label: "Bill number", Value: invoiceNumber}, {Label: "Your reference", Value: reference}}),
			SmallPrint(small),
		}, "\n"),
	})}
}

// SubscriptionReceipt is subscriptionReceiptEmail: money received against a plan
// invoice, for money Softmato never saw (their own email receipts the rest).
func SubscriptionReceipt(amount int64, attached bool, dueBy, hostelName, invoiceNumber, method string, outstanding int64, planName string) Content {
	settled := outstanding <= 0
	label := map[string]string{"CASH": "Cash", "SOFTMATO": "Online payment"}[method]
	if label == "" {
		label = method
	}
	rows := []DetailRow{{Emphasis: true, Label: "Paid", Value: Rupees(amount)}, {Label: "Paid with", Value: label}, {Label: "Bill no.", Value: invoiceNumber}}
	subject, pre, heading, line := "We got your "+Rupees(amount)+" payment", "We got "+Rupees(amount)+" for "+planName+".", "Thank you, we got your payment",
		"Your bill is fully paid. Your plan is on and your hostel shows online."
	if !settled {
		rows = append(rows, DetailRow{Label: "Left to pay", Value: Rupees(outstanding)}, DetailRow{Label: "Pay by", Value: dueBy})
		subject = "We got " + Rupees(amount) + ". " + Rupees(outstanding) + " left to pay"
		pre, heading, line = subject+".", "We got part of your payment", "Your hostel stays online while you pay the rest."
	}
	small := "You can download your receipt from your billing page."
	if attached {
		small = "Your receipt and bill are attached."
	}
	return Content{Category: Billing, Subject: subject, HTML: EmailLayout(Layout{
		BodyHTML: strings.Join([]string{
			Paragraph("We got your payment for <strong>" + EscapeHTML(planName) + "</strong> (<strong>" + EscapeHTML(hostelName) + "</strong>)."),
			DetailsTable(rows), Paragraph(line), SmallPrint(small),
		}, "\n"),
		Eyebrow: "Payment received", Heading: heading, Preheader: pre,
	})}
}

// HostelLeaveApproved is hostelLeaveApprovedEmail: to the owner, with the data files attached.
func HostelLeaveApproved(claimURL string, files []string, filesUntil, holdUntil time.Time, hostelName, ownerName string, sheets []string) Content {
	attached := ""
	if len(files) > 0 {
		pick := func(ext, fallback string) string {
			for _, f := range files {
				if strings.HasSuffix(f, ext) {
					return f
				}
			}
			return fallback
		}
		escaped := make([]string, len(sheets))
		for i, s := range sheets {
			escaped[i] = EscapeHTML(s)
		}
		attached = strings.Join([]string{
			Paragraph("Your hostel's data, from its first day to today, is attached in two files:"),
			DetailsTable([]DetailRow{{Label: pick(".xlsx", "Workbook"), Value: "Excel / Google Sheets"}, {Label: pick(".json", "JSON"), Value: "To import into other software"}}),
			Paragraph("The workbook opens on an About sheet that explains the rest. Its sheets: " + strings.Join(escaped, ", ") + "."),
		}, "\n")
	}
	return Content{Category: Info, Subject: hostelName + " is off HostelPalika", HTML: EmailLayout(Layout{
		Heading: "Your hostel is off HostelPalika",
		BodyHTML: strings.Join([]string{
			Greeting(ownerName),
			Paragraph("We approved your request. <strong>" + EscapeHTML(hostelName) + "</strong> is no longer on HostelPalika, and its portal is closed."),
			attached,
			Paragraph("Your original files — photos, documents and receipts — are ready to download until " + EscapeHTML(EmailDate(filesUntil)) + ": sign in with this email and open the link below. Take everything as one ZIP, or pick files one by one."),
			DetailsTable([]DetailRow{{Emphasis: true, Label: "We hold your data until", Value: EmailDate(holdUntil)}}),
			Paragraph("Changed your mind? Sign in with this email before that date and claim your hostel back. Everything comes back as it was."),
			CTAButton(claimURL, "Download files or claim hostel back"),
			SmallPrint("After that date your hostel and its data are erased for good."),
		}, "\n"),
	})}
}

// HostelLeaveRejected is hostelLeaveRejectedEmail.
func HostelLeaveRejected(hostelName, note, ownerName string) Content {
	return Content{Category: Info, Subject: "Your request to leave was not approved — " + hostelName, HTML: EmailLayout(Layout{
		Heading: "Request not approved",
		BodyHTML: strings.Join([]string{
			Greeting(ownerName),
			Paragraph("We did not approve the request to take <strong>" + EscapeHTML(hostelName) + "</strong> off HostelPalika. Your hostel stays as it is."),
			Paragraph("Reason: " + EscapeHTML(note)),
			Paragraph("Questions? Reply to this email."),
		}, "\n"),
	})}
}

// ServiceProviderApproved is serviceProviderApprovedEmail.
func ServiceProviderApproved(category, fullName, jobsURL, siteName string) Content {
	return Content{Category: Info, Subject: "You are approved on " + EscapeHTML(siteName), HTML: EmailLayout(Layout{
		Heading: "You are listed", SiteName: siteName,
		BodyHTML: strings.Join([]string{
			Paragraph("Hi " + EscapeHTML(fullName) + ","),
			Paragraph("You are approved as <strong>" + EscapeHTML(category) + "</strong>. Hostels in your area can now find you and call you."),
			Paragraph("Log in with the same Google account you used to register. No password needed. You will see a <strong>Jobs</strong> tab in the menu."),
			CTAButton(jobsURL, "Open my jobs"),
			Paragraph("Your ID card comes in another email. Show it when you go to a hostel."),
			Paragraph("Hostels will call you for jobs. You only get the job details, not residents' personal details."),
		}, "\n"),
	})}
}

// ServiceProviderRejected is serviceProviderRejectedEmail.
func ServiceProviderRejected(fullName, reason string) Content {
	parts := []string{Paragraph("Hi " + EscapeHTML(fullName) + ","), Paragraph("We cannot approve you right now.")}
	if reason != "" {
		parts = append(parts, Paragraph("<strong>Reason:</strong> "+EscapeHTML(reason)))
	}
	parts = append(parts, Paragraph("You can register again with correct details or clearer documents."))
	return Content{Category: Info, Subject: "You are not approved yet", HTML: EmailLayout(Layout{Heading: "Not approved", BodyHTML: strings.Join(parts, "\n")})}
}
