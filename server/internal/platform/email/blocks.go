package email

import "strings"

// Greeting is greeting: `Hi Sita,` — or `Hi,` when there is no name worth using.
func Greeting(name string) string {
	if t := strings.TrimSpace(name); t != "" {
		return Paragraph("Hi " + EscapeHTML(t) + ",")
	}
	return Paragraph("Hi,")
}

// SmallPrint is smallPrint: secondary lines under the action. Trusted markup.
func SmallPrint(html string) string {
	return `<p style="margin:0 0 12px;font-family:` + font + `;font-size:13px;line-height:20px;color:` + colorMuted + `;">` + html + `</p>`
}

// TextLink is textLink: an inline link in the brand colour.
func TextLink(url, label string) string {
	return `<a href="` + EscapeHTML(url) + `" style="color:` + colorBrand + `;font-weight:600;text-decoration:none;">` + EscapeHTML(label) + `</a>`
}

// DetailRow is one row of a details table; a blank value drops the row.
type DetailRow struct {
	Label, Value string
	Emphasis     bool
}

// DetailsTable is detailsTable: label left, value right, a hairline between rows.
func DetailsTable(rows []DetailRow) string {
	var visible []DetailRow
	for _, r := range rows {
		if strings.TrimSpace(r.Value) != "" {
			visible = append(visible, r)
		}
	}
	if len(visible) == 0 {
		return ""
	}
	var body strings.Builder
	for i, r := range visible {
		rule := ""
		if i > 0 {
			rule = "border-top:1px solid " + colorBorder + ";"
		}
		size := "font-size:14px;line-height:20px;"
		if r.Emphasis {
			size = "font-size:18px;line-height:26px;"
		}
		body.WriteString(`<tr>
        <td style="padding:12px 0;` + rule + `font-family:` + font + `;font-size:14px;line-height:20px;color:` + colorMuted + `;">` + EscapeHTML(r.Label) + `</td>
        <td align="right" style="padding:12px 0 12px 16px;` + rule + `font-family:` + font + `;` + size + `font-weight:600;color:` + colorStrong + `;">` + EscapeHTML(r.Value) + `</td>
      </tr>`)
	}
	return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 8px;border-top:1px solid ` + colorBorder + `;border-bottom:1px solid ` + colorBorder + `;">` + body.String() + `</table>`
}

// HostelInquiryReceived is hostelInquiryReceivedEmail: a visitor's question for
// a hostel's admins.
func HostelInquiryReceived(dashboardURL, hostelName, message, preferredVisitDate, visitorEmail, visitorName, visitorPhone string) Content {
	parts := []string{
		Paragraph("Someone asked about <strong>" + EscapeHTML(hostelName) + "</strong>. Please call or message them."),
		DetailsTable([]DetailRow{{Label: "Name", Value: visitorName}, {Label: "Phone", Value: visitorPhone},
			{Label: "Email", Value: visitorEmail}, {Label: "Wants to visit", Value: preferredVisitDate}}),
	}
	if message != "" {
		parts = append(parts, Paragraph("“"+EscapeHTML(message)+"”"))
	}
	parts = append(parts, CTAButton(dashboardURL, "See all questions"))
	var kept []string
	for _, p := range parts {
		if p != "" {
			kept = append(kept, p)
		}
	}
	return Content{Category: Support, Subject: "Someone wants to know about " + hostelName,
		HTML: EmailLayout(Layout{Heading: "New question about your hostel", BodyHTML: strings.Join(kept, "\n")})}
}

// NewHostelPending is newHostelPendingEmail: a hostel waiting for review.
func NewHostelPending(city, hostelName, ownerEmail, ownerName, queueURL string) Content {
	return Content{Category: Info, Subject: "New hostel to check — " + hostelName, HTML: EmailLayout(Layout{
		Heading: "New hostel to check",
		BodyHTML: strings.Join([]string{
			Paragraph("A new hostel is waiting for approval. Check the documents first."),
			DetailsTable([]DetailRow{{Label: "Hostel", Value: hostelName}, {Label: "City", Value: city},
				{Label: "Owner", Value: ownerName}, {Label: "Email", Value: ownerEmail}}),
			CTAButton(queueURL, "Check hostel"),
		}, "\n"),
	})}
}
