package email

import "strings"

// HostelReferralInvite is hostelReferralInviteEmail (templates/hostel/hostel-referral-invite.ts).
func HostelReferralInvite(code, fromHostelName, inviteeName, link, offer string) Content {
	greeting := "Hi,"
	if inviteeName != "" {
		greeting = "Hi " + EscapeHTML(inviteeName) + ","
	}
	parts := []string{Paragraph(greeting), Paragraph("<strong>" + EscapeHTML(fromHostelName) + "</strong> runs their hostel on " + EscapeHTML(PlatformName) + " — residents, fees, rooms and food in one app — and invited you to register yours.")}
	if offer != "" {
		parts = append(parts, Paragraph("Register with their referral code and your plan gets <strong>"+EscapeHTML(offer)+"</strong> extra, free."))
	}
	parts = append(parts, DetailsTable([]DetailRow{{Label: "Referral code", Value: code}}), CTAButton(link, "Register your hostel"),
		SmallPrint("Choose “I have a referral code” when you start, and type the code above if it is not filled in."))
	return Content{Category: Info, Subject: fromHostelName + " invited you to " + PlatformName, HTML: EmailLayout(Layout{Heading: "Run your hostel online", Preheader: fromHostelName + " uses " + PlatformName + " and invited you.", BodyHTML: strings.Join(parts, "\n")})}
}
