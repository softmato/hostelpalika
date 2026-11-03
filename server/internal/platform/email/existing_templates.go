package email

import (
	"strings"

	"github.com/softmato/hostelpalika/server/internal/platform/money"
)

// ListColumn is one column of ListTable.
type ListColumn struct {
	Label string
	Right bool
}

// ListTable is listTable: several things at once, one row each; total adds a bold last row.
func ListTable(columns []ListColumn, rows [][]string, total []string) string {
	if len(rows) == 0 {
		return ""
	}
	cell := func(value string, index int, style string) string {
		align, pad := "left", "10px 0 10px 12px"
		if index < len(columns) && columns[index].Right {
			align = "right"
		}
		if index == 0 {
			pad = "10px 0"
		}
		return `<td align="` + align + `" style="padding:` + pad + `;font-family:` + font + `;font-size:14px;line-height:20px;` + style + `">` + EscapeHTML(value) + `</td>`
	}
	line := func(values []string, style func(int) string) string {
		var b strings.Builder
		b.WriteString("<tr>")
		for i, v := range values {
			b.WriteString(cell(v, i, style(i)))
		}
		b.WriteString("</tr>")
		return b.String()
	}
	labels := make([]string, len(columns))
	for i, c := range columns {
		labels[i] = c.Label
	}
	var body strings.Builder
	body.WriteString(line(labels, func(int) string { return "font-size:12px;line-height:16px;color:" + colorMuted + ";padding-top:0;" }))
	for _, r := range rows {
		body.WriteString(line(r, func(int) string { return "border-top:1px solid " + colorBorder + ";color:" + colorStrong + ";" }))
	}
	if total != nil {
		body.WriteString(line(total, func(int) string {
			return "border-top:1px solid " + colorBorder + ";font-weight:700;color:" + colorStrong + ";"
		}))
	}
	return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 20px;border-bottom:1px solid ` + colorBorder + `;">` + body.String() + `</table>`
}

// ExistingDue is one bill in the added-resident mail.
type ExistingDue struct {
	Amount int64
	Code   string
	Label  string
}

// ExistingAddedInput is existingResidentAddedEmail's argument.
type ExistingAddedInput struct {
	ActivationExpiresOn, ActivationURL string
	DashboardURL, OfferProgramURL      string
	DepositPaid                        int64
	Dues                               []ExistingDue
	HasAccount                         bool
	HostelName                         string
	MonthlyRent                        int64
	NextBillMonth, PaidTill, PayBy     string
	ResidentName, RoomType             string
}

// ExistingResidentAdded is existingResidentAddedEmail: a hostel that already had
// residents has put them on the platform.
func ExistingResidentAdded(in ExistingAddedInput) Content {
	rupees := func(v int64) string { return "Rs " + money.GroupIN(v) }
	var total int64
	for _, d := range in.Dues {
		total += d.Amount
	}
	var money string
	if total == 0 {
		money = strings.Join([]string{SectionTitle("Nothing to pay now"), DetailsTable([]DetailRow{{Label: "Paid till", Value: in.PaidTill}, {Label: "Next bill", Value: in.NextBillMonth}})}, "\n")
	} else {
		rows := make([][]string, len(in.Dues))
		for i, d := range in.Dues {
			code := d.Code
			if code == "" {
				code = "—"
			}
			rows[i] = []string{d.Label, code, rupees(d.Amount)}
		}
		var foot []string
		if len(in.Dues) > 1 {
			foot = []string{"Total", "", rupees(total)}
		}
		money = strings.Join([]string{SectionTitle("To pay by " + in.PayBy),
			ListTable([]ListColumn{{Label: "Bill"}, {Label: "Code"}, {Label: "Amount", Right: true}}, rows, foot),
			SmallPrint("Write the code when you pay, so the hostel knows which bill you paid.")}, "\n")
	}
	var access []string
	switch {
	case in.HasAccount:
		access = []string{CTAButton(in.DashboardURL, "Open my account"), SmallPrint("Log in to " + PlatformName + " with this email.")}
	case in.ActivationURL != "":
		access = []string{CTAButton(in.ActivationURL, "Start my account"), SmallPrint("This link works till " + EscapeHTML(in.ActivationExpiresOn) + ".")}
	default:
		access = []string{SmallPrint("To use the app, ask the hostel for your code.")}
	}
	var rent, deposit string
	if in.MonthlyRent != 0 {
		rent = rupees(in.MonthlyRent)
	}
	if in.DepositPaid > 0 {
		deposit = rupees(in.DepositPaid)
	}
	subject := in.HostelName + " is now on " + PlatformName
	if total != 0 {
		subject += " — please pay " + rupees(total)
	}
	parts := []string{
		Paragraph("Hi " + EscapeHTML(in.ResidentName) + ", <strong>" + EscapeHTML(in.HostelName) + "</strong> now uses " + PlatformName + ". You can pay rent and get receipts in the app."),
		DetailsTable([]DetailRow{{Label: "Room type", Value: in.RoomType}, {Label: "Monthly rent", Value: rent}, {Label: "Deposit paid", Value: deposit}}),
		money,
	}
	parts = append(parts, access...)
	parts = append(parts, SmallPrint("Every payment made with its code counts for the "+TextLink(in.OfferProgramURL, "Resident Offer Program")+"."), SmallPrint("Something wrong? Tell the hostel."))
	return Content{Category: Info, Subject: subject, HTML: EmailLayout(Layout{Heading: "Your hostel is now on " + PlatformName, BodyHTML: strings.Join(parts, "\n")})}
}

// JoinRequestReturned is joinRequestReturnedEmail.
func JoinRequestReturned(fixURL, hostelName, reason, residentName string) Content {
	return Content{Category: Info, Subject: hostelName + " sent your request back", HTML: EmailLayout(Layout{Heading: "Please fix your request", BodyHTML: strings.Join([]string{
		Paragraph("Hi " + EscapeHTML(residentName) + ", <strong>" + EscapeHTML(hostelName) + "</strong> checked your request to be added as a resident and sent it back."),
		Paragraph("They wrote: <strong>" + EscapeHTML(reason) + "</strong>"),
		Paragraph("Fix it and send it again from the same link. It stays the same request."),
		CTAButton(fixURL, "Fix my request"),
	}, "\n")})}
}
