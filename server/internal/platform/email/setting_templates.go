package email

import (
	"strconv"
	"strings"
)

// ComparisonRow is one changed setting: its label, the value now, the value proposed.
type ComparisonRow struct {
	From  string `json:"from"`
	Label string `json:"label"`
	To    string `json:"to"`
}

// ComparisonTable is comparisonTable: Setting / Now / New, the old value struck through.
func ComparisonTable(rows []ComparisonRow) string {
	if len(rows) == 0 {
		return ""
	}
	head := `<tr>
      <td style="padding:0 0 8px;font-family:` + font + `;font-size:12px;line-height:16px;color:` + colorMuted + `;">Setting</td>
      <td style="padding:0 0 8px 12px;font-family:` + font + `;font-size:12px;line-height:16px;color:` + colorMuted + `;">Now</td>
      <td align="right" style="padding:0 0 8px 12px;font-family:` + font + `;font-size:12px;line-height:16px;color:` + colorMuted + `;">New</td>
    </tr>`
	var body strings.Builder
	for _, r := range rows {
		body.WriteString(`<tr>
        <td style="padding:10px 0;border-top:1px solid ` + colorBorder + `;font-family:` + font + `;font-size:14px;line-height:20px;color:` + colorMuted + `;">` + EscapeHTML(r.Label) + `</td>
        <td style="padding:10px 0 10px 12px;border-top:1px solid ` + colorBorder + `;font-family:` + font + `;font-size:14px;line-height:20px;color:` + colorMuted + `;text-decoration:line-through;">` + EscapeHTML(r.From) + `</td>
        <td align="right" style="padding:10px 0 10px 12px;border-top:1px solid ` + colorBorder + `;font-family:` + font + `;font-size:14px;line-height:20px;font-weight:600;color:` + colorStrong + `;">` + EscapeHTML(r.To) + `</td>
      </tr>`)
	}
	return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 8px;border-bottom:1px solid ` + colorBorder + `;">` + head + body.String() + `</table>`
}

// SettingChangeConfirm is settingChangeConfirmEmail: a change waits for the link.
func SettingChangeConfirm(confirmURL, expiresAt, name string, rows []ComparisonRow, label string) Content {
	return Content{Category: Security, Subject: "Please confirm: " + label + " change", HTML: EmailLayout(Layout{
		BodyHTML: Greeting(name) +
			Paragraph("You changed <strong>"+EscapeHTML(label)+"</strong>. It is not saved until you confirm.") +
			ComparisonTable(rows) +
			CTAButton(confirmURL, "Confirm change") +
			SmallPrint("This link works one time, until "+EscapeHTML(expiresAt)+", only while you are logged in as this superadmin.") +
			SmallPrint("Not you? Do not open the link. Log out of all devices and change your Google password."),
		Eyebrow: "Security", Heading: "Please confirm this change", Preheader: "Confirm the " + label + " change. It is not saved until you do.",
	})}
}

// PlatformAdminInvitation is platformAdminInvitationEmail. A team member is told
// what a team member does; TS described them as a moderator (P7-30).
func PlatformAdminInvitation(acceptURL string, expiresInDays int, invitedByName, roleLabel string) Content {
	what := "A moderator approves and checks hostels and can read reports. They cannot change the website, plans, settings or admins."
	switch {
	case strings.Contains(strings.ToLower(roleLabel), "superadmin"):
		what = "A superadmin can see and change everything: all hostels, all payments, the website, and who is admin."
	case roleLabel == "Team Member":
		what = "A team member registers hostels in the field and records the cash they collect. They cannot see the platform's payments, settings or admins."
	}
	return Content{Category: Security, Subject: "You are invited as " + roleLabel, HTML: EmailLayout(Layout{
		Heading: "You are invited to our team",
		BodyHTML: strings.Join([]string{
			Paragraph("<strong>" + EscapeHTML(invitedByName) + "</strong> invited you to join the team as <strong>" + EscapeHTML(roleLabel) + "</strong>."),
			Paragraph(what),
			Paragraph("Tap the button below to accept. No form and no password. Confirm on the page, then log in with Google using this email."),
			CTAButton(acceptURL, "Accept"),
			Paragraph(`<span style="color:#64748b;font-size:13px;">This link works one time, for ` + strconv.Itoa(expiresInDays) + ` day(s). Not expecting this? Ignore it. Nothing changes unless you open the link.</span>`),
		}, "\n"),
	})}
}
