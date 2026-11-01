package email

import (
	"strconv"
	"strings"
	"time"
)

// SOSAlert is sosAlertEmail (templates/guardian/sos-alert.ts).
func SOSAlert(actionURL, hostelName, message string, guardian bool, residentName, residentPhone string, triggeredAt time.Time) Content {
	lead := "<strong>" + EscapeHTML(residentName) + "</strong> pressed SOS at <strong>" + EscapeHTML(hostelName) + "</strong>. They need help. Please go now."
	if guardian {
		lead = "<strong>" + EscapeHTML(residentName) + "</strong> pressed SOS at <strong>" + EscapeHTML(hostelName) + "</strong>. They need help. The hostel staff also got this message."
	}
	parts := []string{Paragraph(lead), Paragraph("Time: " + EscapeHTML(triggeredAt.UTC().Format("2006-01-02 15:04")) + " UTC.")}
	if residentPhone != "" {
		parts = append(parts, Paragraph("Resident phone: <strong>"+EscapeHTML(residentPhone)+"</strong>"))
	}
	if message != "" {
		parts = append(parts, Paragraph("Message: \u201c"+EscapeHTML(message)+"\u201d"))
	}
	parts = append(parts, CTAButton(actionURL, "Open SOS"))
	return Content{Category: Alert, Subject: "SOS: " + residentName + " needs help \u2014 " + hostelName, HTML: EmailLayout(Layout{
		Heading: "\U0001F6A8 SOS \u2014 needs help now", Urgent: true, BodyHTML: strings.Join(parts, "\n")})}
}

// NewComplaint is newComplaintEmail (templates/hostel/staff-alerts.ts).
func NewComplaint(complaintsURL, from, hostelName, title, kind string) Content {
	return Content{Category: Support, Subject: "New complaint: " + title + " \u2014 " + hostelName, HTML: EmailLayout(Layout{
		Heading: "New complaint",
		BodyHTML: strings.Join([]string{DetailsTable([]DetailRow{{Label: "From", Value: from}, {Label: "Type", Value: typeLabel(kind)}, {Label: "Complaint", Value: title}}),
			CTAButton(complaintsURL, "Open complaints")}, "\n")})}
}

func typeLabel(kind string) string {
	lower := strings.ReplaceAll(strings.ToLower(kind), "_", " ")
	if lower == "" {
		return ""
	}
	return strings.ToUpper(lower[:1]) + lower[1:]
}

// ClearedMembership names one staff place stood down.
type ClearedMembership struct{ HostelName, Role string }

func roleLabel(role string) string {
	switch role {
	case "GUARDIAN":
		return "Guardian"
	case "HOSTEL_ADMIN":
		return "Hostel admin"
	case "RESIDENT":
		return "Resident"
	case "SERVICE_PROVIDER":
		return "Service provider"
	case "WARDEN":
		return "Warden"
	}
	return strings.ReplaceAll(strings.ToLower(role), "_", " ")
}

// ResidentAccessCleared is residentAccessClearedEmail: says exactly what becoming
// a resident took away.
func ResidentAccessCleared(memberships []ClearedMembership, clearedRole, hostelName string, reactivatedInvite bool, residentName string) Content {
	var items strings.Builder
	item := func(html string) { items.WriteString(`<li style="margin:0 0 8px;">` + html + `</li>`) }
	if clearedRole != "" {
		item("Your old <strong>" + EscapeHTML(roleLabel(clearedRole)) + "</strong> access is closed. Your account is now a resident account.")
	}
	for _, m := range memberships {
		item("You are no longer " + EscapeHTML(strings.ToLower(roleLabel(m.Role))) + " at <strong>" + EscapeHTML(m.HostelName) + "</strong>.")
	}
	if reactivatedInvite {
		item("An old invite you did not accept is closed. Your account is now on.")
	}
	return Content{Category: Info, Subject: "Your account is now a resident account at " + hostelName, HTML: EmailLayout(Layout{
		Heading: "Your account has changed",
		BodyHTML: strings.Join([]string{
			Paragraph("Hi " + EscapeHTML(residentName) + ", <strong>" + EscapeHTML(hostelName) + "</strong> added you as a resident. So now you log in as a resident."),
			Paragraph("So we removed this:"),
			`<ul style="margin:0 0 16px;padding-left:20px;font-size:15px;line-height:1.6;">` + items.String() + `</ul>`,
			Paragraph("Your password and Google login are the same. Log in the same way as before. Nothing else changed."),
			Paragraph("Something wrong? Reply to this email and we will fix it."),
		}, "\n")})}
}

// GuardianInvitation is guardianInvitationEmail.
func GuardianInvitation(acceptURL string, expiresInDays int, hostelName string, permissions []string, residentName string) Content {
	list := Paragraph("They have not shared anything yet. You will only see the hostel's contact details.")
	if len(permissions) > 0 {
		var b strings.Builder
		for _, x := range permissions {
			b.WriteString("<li>" + EscapeHTML(x) + "</li>")
		}
		list = `<ul style="margin:0 0 16px;padding-left:20px;font-size:15px;line-height:1.6;">` + b.String() + `</ul>`
	}
	return Content{Category: Info, Subject: residentName + " added you as their guardian \u2014 " + hostelName, HTML: EmailLayout(Layout{
		Heading: "You are invited as guardian",
		BodyHTML: strings.Join([]string{
			Paragraph("<strong>" + EscapeHTML(residentName) + "</strong> added you as their guardian at <strong>" + EscapeHTML(hostelName) + "</strong>."),
			Paragraph("You can see:"), list,
			Paragraph("You will only see the things above. The resident can change this any time."),
			CTAButton(acceptURL, "Accept"),
			Paragraph(`<span style="color:#64748b;font-size:13px;">This link works for ` + strconv.Itoa(expiresInDays) + ` days.</span>`),
		}, "\n")})}
}

// CredentialsIssued is credentialsIssuedEmail.
func CredentialsIssued(roleLabel, addr, temporaryPassword, loginURL string) Content {
	return Content{Category: Security, Subject: "Your " + PlatformName + " login details", HTML: EmailLayout(Layout{
		Heading: "Your account is ready",
		BodyHTML: strings.Join([]string{
			Paragraph("We made a " + PlatformName + " account for you as <strong>" + EscapeHTML(roleLabel) + "</strong>."),
			Paragraph("Email: <strong>" + EscapeHTML(addr) + "</strong><br/>Temporary password: <strong>" + EscapeHTML(temporaryPassword) + "</strong>"),
			Paragraph("When you first log in, you will set a new password. Do not share this password with anyone."),
			CTAButton(loginURL, "Log in"),
		}, "\n")})}
}

// AccountUpgraded is accountUpgradedEmail.
func AccountUpgraded(roleLabel, dashboardURL, hostelName string) Content {
	context := ""
	if hostelName != "" {
		context = " for <strong>" + EscapeHTML(hostelName) + "</strong>"
	}
	return Content{Category: Security, Subject: "You have new access on " + PlatformName, HTML: EmailLayout(Layout{
		Heading: "You have new access",
		BodyHTML: strings.Join([]string{
			Paragraph("Your " + PlatformName + " account is now <strong>" + EscapeHTML(roleLabel) + "</strong>" + context + "."),
			Paragraph("Log in the same way as before (email and password, or Google). You will see your new dashboard."),
			CTAButton(dashboardURL, "Open dashboard"),
		}, "\n")})}
}

// HostelReclaimed is hostelReclaimedEmail.
func HostelReclaimed(hostelName, ownerName, portalURL string) Content {
	return Content{Category: Info, Subject: hostelName + " is back on HostelPalika", HTML: EmailLayout(Layout{
		Heading: "Your hostel is back",
		BodyHTML: strings.Join([]string{
			Greeting(ownerName),
			Paragraph("You claimed <strong>" + EscapeHTML(hostelName) + "</strong> back. Its portal and data are as you left them."),
			CTAButton(portalURL, "Open portal"),
		}, "\n"),
	})}
}
