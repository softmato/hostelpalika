package email

import (
	"strconv"
	"strings"
)

func cookLoginLine(login, password string) string {
	return Paragraph("Login: <strong>" + EscapeHTML(login) + "</strong><br/>Password: <strong>" + EscapeHTML(password) + "</strong>")
}

// CookCredentials is cookCredentialsEmail (templates/cook/credentials.ts).
func CookCredentials(cookName, login, password, hostelName, loginURL string, rotated bool) Content {
	subject, heading := "Cook sign-in for "+cookName+" — "+hostelName, "Cook login is ready"
	lead := "Here is the login for <strong>" + EscapeHTML(cookName) + "</strong> at <strong>" + EscapeHTML(hostelName) + "</strong>."
	if rotated {
		subject, heading = "New cook password — "+hostelName, "New cook password"
		lead = "Here is a new password for <strong>" + EscapeHTML(cookName) + "</strong> at <strong>" + EscapeHTML(hostelName) + "</strong>. The old one does not work now."
	}
	return Content{Category: Security, Subject: subject, HTML: EmailLayout(Layout{Heading: heading, BodyHTML: strings.Join([]string{Paragraph(lead), cookLoginLine(login, password),
		Paragraph("Give both to your cook. On first login, they will set their own password. Nobody can see it after that. If they forget it, make a new one from the Cooks screen."),
		Paragraph("The cook can only tell residents about meals and post food photos. They cannot see residents, payments or complaints."),
		CTAButton(loginURL, "Log in")}, "\n")})}
}

// CookInvitation is cookInvitationEmail (templates/cook/invitation.ts).
func CookInvitation(acceptURL, cookName string, expiresInDays int, hostelName string) Content {
	return Content{Category: Security, Subject: "You are invited as cook — " + hostelName, HTML: EmailLayout(Layout{Heading: "You are invited as cook", BodyHTML: strings.Join([]string{
		Paragraph("Hi " + EscapeHTML(cookName) + ", <strong>" + EscapeHTML(hostelName) + "</strong> wants you as their cook on " + PlatformName + "."),
		Paragraph("You will log in with this email. You can tell residents when food is ready and post food photos. You cannot see residents, money or complaints."),
		CTAButton(acceptURL, "Accept"),
		Paragraph("This link works one time, for " + strconv.Itoa(expiresInDays) + " day(s). If it stops working, ask the hostel for a new one.")}, "\n")})}
}

// CookPortalEnabled is cookPortalEnabledEmail (templates/hostel/cook-portal-enabled.ts).
func CookPortalEnabled(cookName, login, password, hostelName, loginURL string) Content {
	return Content{Category: Security, Subject: "Cook login is ready — " + hostelName, HTML: EmailLayout(Layout{Heading: "Cook login is ready", BodyHTML: strings.Join([]string{
		Paragraph("<strong>" + EscapeHTML(cookName) + "</strong> can now log in as cook for <strong>" + EscapeHTML(hostelName) + "</strong>."),
		Paragraph("Give this login to your cook. It works on phones. They can tell residents about meals with one tap."),
		cookLoginLine(login, password),
		Paragraph("The first cook to log in sets a new password. All cooks use that same password. You can make a new password from your Food page."),
		CTAButton(loginURL, "Log in")}, "\n")})}
}
