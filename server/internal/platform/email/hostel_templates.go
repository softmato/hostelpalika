package email

import (
	"strconv"
	"strings"
)

// hello is the quick sign-up templates' greeting: a name when there is one.
func hello(name string) string {
	if name != "" {
		return Paragraph("Hi " + EscapeHTML(name) + ",")
	}
	return Paragraph("Hi,")
}

// HostelPortalOpen is hostelPortalOpenEmail (templates/hostel/hostel-kyc.ts).
func HostelPortalOpen(hostelName, kycURL, ownerName string, trialDays int, trialEndsOn string) Content {
	days := strconv.Itoa(trialDays)
	return Content{Category: Info, Subject: "Your " + hostelName + " portal is open — " + days + " days free", HTML: EmailLayout(Layout{
		Heading: "Congratulations — your hostel portal is open",
		BodyHTML: strings.Join([]string{
			hello(ownerName),
			Paragraph("<strong>" + EscapeHTML(hostelName) + "</strong> now has its own hostel portal in the app and on the website. You have <strong>" + days + " days free</strong>, until " + EscapeHTML(trialEndsOn) + ". Enjoy and explore."),
			Paragraph("Next, complete your hostel KYC: photos, documents, rooms and your address. Our team checks it within 24 hours. Until then some features stay locked, and your hostel is not shown to the public."),
			CTAButton(kycURL, "Complete KYC"),
		}, "\n"),
	})}
}

// HostelSubmissionReceived is hostelSubmissionReceivedEmail: "we got your details".
func HostelSubmissionReceived(hostelName, ownerName string) Content {
	return Content{Category: Info, Subject: "We got your hostel details — " + hostelName, HTML: EmailLayout(Layout{
		Heading: "We got your details",
		BodyHTML: strings.Join([]string{
			hello(ownerName),
			Paragraph("Thank you for adding <strong>" + EscapeHTML(hostelName) + "</strong> to HostelPalika. We will check your details and documents soon."),
			Paragraph("We will email you when your hostel is approved, or if we need anything more."),
		}, "\n"),
	})}
}

// ServiceProviderRegistrationReceived is serviceProviderRegistrationReceivedEmail (EMAIL_SYSTEM.md §6.1).
func ServiceProviderRegistrationReceived(category, fullName string) Content {
	return Content{Category: Info, Subject: "We got your details", HTML: EmailLayout(Layout{
		Heading: "We got your details",
		BodyHTML: strings.Join([]string{
			Paragraph("Hi " + EscapeHTML(fullName) + ","),
			Paragraph("Thank you for joining as <strong>" + EscapeHTML(category) + "</strong> on HostelPalika. We will check your details and documents soon."),
			Paragraph("We will email you when you are approved."),
		}, "\n"),
	})}
}
