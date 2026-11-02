package email

import (
	"strings"
	"unicode/utf16"
)

// jsUnits is String#length; jsPrefix is String#slice(0, n).
func jsUnits(s string) int { return len(utf16.Encode([]rune(s))) }

func jsPrefix(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n]))
}

// ResidentNewNotice is residentNewNoticeEmail (templates/resident/new-notice.ts).
// Its mailbox depends on the notice: an urgent one is the hostel raising its voice.
func ResidentNewNotice(body, category, hostelName string, isUrgent bool, noticesURL, title string) Content {
	preview := body
	if units := jsUnits(body); units > 400 {
		preview = strings.TrimRight(jsPrefix(body, 400), " \t\r\n") + "…"
	}
	prefix, heading, cat := "New notice", "New notice", Info
	if isUrgent {
		prefix, heading, cat = "Urgent notice", "Urgent notice", Alert
	}
	lead := "<strong>" + EscapeHTML(hostelName) + "</strong> has a new notice"
	if category != "" {
		lead += " (" + EscapeHTML(category) + ")"
	}
	lead += "."
	return Content{Category: cat, Subject: prefix + ": " + title + " — " + hostelName, HTML: EmailLayout(Layout{
		Heading: heading, Urgent: isUrgent,
		BodyHTML: strings.Join([]string{Paragraph(lead), Paragraph("<strong>" + EscapeHTML(title) + "</strong>"),
			Paragraph(strings.ReplaceAll(EscapeHTML(preview), "\n", "<br/>")), CTAButton(noticesURL, "Read notice")}, "\n")})}
}

var complaintStatusLabel = map[string]string{"IN_PROGRESS": "in progress", "PENDING": "pending", "REJECTED": "closed", "RESOLVED": "fixed"}

// ComplaintStatusUpdated is complaintStatusUpdatedEmail (templates/resident/complaint-status-updated.ts).
func ComplaintStatusUpdated(complaintsURL, hostelName, response, status, title string) Content {
	label, ok := complaintStatusLabel[status]
	if !ok {
		label = strings.ToLower(status)
	}
	parts := []string{Paragraph("<strong>" + EscapeHTML(hostelName) + "</strong> updated your complaint <strong>" + EscapeHTML(title) + "</strong>."),
		Paragraph("Status: <strong>" + EscapeHTML(label) + "</strong>")}
	if response != "" {
		parts = append(parts, Paragraph("Note from the hostel: “"+EscapeHTML(response)+"”"))
	}
	parts = append(parts, CTAButton(complaintsURL, "See complaint"))
	return Content{Category: Support, Subject: "Your complaint is now " + label + " — " + hostelName,
		HTML: EmailLayout(Layout{Heading: "Your complaint is updated", BodyHTML: strings.Join(parts, "\n")})}
}

// ComplaintResolved is complaintResolvedEmail (templates/resident/complaint-resolved.ts).
func ComplaintResolved(complaintsURL, hostelName, response, title string) Content {
	parts := []string{Paragraph("<strong>" + EscapeHTML(hostelName) + "</strong> says your complaint <strong>" + EscapeHTML(title) + "</strong> is fixed.")}
	if response != "" {
		parts = append(parts, Paragraph("What they did: “"+EscapeHTML(response)+"”"))
	}
	parts = append(parts, Paragraph("Is it really fixed? Tap below to say yes. If not, open it again and tell them."), CTAButton(complaintsURL, "Yes, it is fixed"))
	return Content{Category: Support, Subject: "Your complaint is fixed: " + title + " — " + hostelName,
		HTML: EmailLayout(Layout{Heading: "Your complaint is fixed", BodyHTML: strings.Join(parts, "\n")})}
}
