package email

import (
	"strconv"
	"strings"

	"github.com/softmato/hostelpalika/server/internal/platform/money"
)

// The hostel admins' summary emails (staff-alerts.ts): one table each, one button.

// staffMaxRows: a list stops here; the rest is "…and N more in the app".
const staffMaxRows = 50

func staffMore(total int) string {
	if total > staffMaxRows {
		return SmallPrint("…and " + strconv.Itoa(total-staffMaxRows) + " more in the app.")
	}
	return ""
}

func firstRows[T any](rows []T) []T {
	if len(rows) > staffMaxRows {
		return rows[:staffMaxRows]
	}
	return rows
}

// PaymentLine is one row of the payment tables; Amount is what the caller passes.
type PaymentLine struct {
	Amount int64
	Month  string
	Name   string
}

func paymentTable(lines []PaymentLine, amountLabel string) string {
	var sum int64
	rows := make([][]string, 0, len(lines))
	for _, l := range lines {
		sum += l.Amount
	}
	for _, l := range firstRows(lines) {
		month := MonthName(l.Month)
		if month == "" {
			month = "—"
		}
		rows = append(rows, []string{l.Name, month, money.FormatNPR(l.Amount)})
	}
	var total []string
	if len(lines) > 1 {
		total = []string{"Total", "", money.FormatNPR(sum)}
	}
	return ListTable([]ListColumn{{Label: "Name"}, {Label: "Month"}, {Label: amountLabel, Right: true}}, rows, total) + staffMore(len(lines))
}

// PaymentSummary is paymentSummaryEmail: the morning payments email.
func PaymentSummary(hostelName, paymentsURL string, received, waiting []PaymentLine) Content {
	subject := plural(len(received), "payment", "payments") + " received — " + hostelName
	if len(waiting) > 0 {
		subject = plural(len(waiting), "payment", "payments") + " to check — " + hostelName
	}
	var pre []string
	if len(waiting) > 0 {
		pre = append(pre, strconv.Itoa(len(waiting))+" to check")
	}
	if len(received) > 0 {
		pre = append(pre, strconv.Itoa(len(received))+" received")
	}
	var body []string
	if len(waiting) > 0 {
		body = append(body, SectionTitle("To check ("+strconv.Itoa(len(waiting))+")")+SmallPrint("Residents sent a payment photo. Check each one, then verify it.")+paymentTable(waiting, "Amount"))
	} else {
		body = append(body, "")
	}
	if len(received) > 0 {
		body = append(body, SectionTitle("Received since yesterday ("+strconv.Itoa(len(received))+")")+paymentTable(received, "Amount"))
	} else {
		body = append(body, "")
	}
	label := "Open payments"
	if len(waiting) > 0 {
		label = "Check payments"
	}
	body = append(body, CTAButton(paymentsURL, label))
	return Content{Category: Billing, Subject: subject,
		HTML: EmailLayout(Layout{Heading: "Payments", Preheader: strings.Join(pre, ", "), BodyHTML: strings.Join(body, "\n")})}
}

// UnpaidFees is unpaidFeesEmail: residents who ran out of automatic reminders.
func UnpaidFees(hostelName, paymentsURL string, reminders int, residents []PaymentLine) Content {
	who := "these residents"
	if len(residents) == 1 {
		who = "this resident"
	}
	return Content{Category: Billing, Subject: plural(len(residents), "resident", "residents") + " still not paid — " + hostelName,
		HTML: EmailLayout(Layout{Heading: "Fees still not paid", BodyHTML: strings.Join([]string{
			Paragraph("We reminded " + who + " " + strconv.Itoa(reminders) + " times. They have not paid, so we stopped the reminders. Please talk to them."),
			paymentTable(residents, "Unpaid"),
			CTAButton(paymentsURL, "Open payments"),
		}, "\n")})}
}

// OverdueComplaint is one row of OverdueComplaints.
type OverdueComplaint struct {
	HoursLate int
	Title     string
	Type      string
}

func lateBy(hours int) string {
	if hours < 24 {
		return plural(hours, "hour", "hours")
	}
	return plural(hours/24, "day", "days")
}

// OverdueComplaints is overdueComplaintsEmail.
func OverdueComplaints(complaints []OverdueComplaint, complaintsURL, hostelName string) Content {
	n := len(complaints)
	lead := "These complaints are"
	if n == 1 {
		lead = "This complaint is"
	}
	rows := make([][]string, 0, n)
	for _, c := range firstRows(complaints) {
		rows = append(rows, []string{c.Title, typeLabel(c.Type), lateBy(c.HoursLate)})
	}
	return Content{Category: Alert, Subject: plural(n, "complaint", "complaints") + " past the deadline — " + hostelName,
		HTML: EmailLayout(Layout{Heading: "Complaints past the deadline", BodyHTML: strings.Join([]string{
			Paragraph(lead + " not fixed yet."),
			ListTable([]ListColumn{{Label: "Complaint"}, {Label: "Type"}, {Label: "Late by", Right: true}}, rows, nil),
			staffMore(n),
			CTAButton(complaintsURL, "Open complaints"),
		}, "\n")})}
}

// AwayResident is one row of AttendanceAlert.
type AwayResident struct {
	Days int
	Name string
}

// AttendanceAlert is attendanceAlertEmail.
func AttendanceAlert(attendanceURL, hostelName string, residents []AwayResident) Content {
	n := len(residents)
	lead := "These residents have"
	if n == 1 {
		lead = "This resident has"
	}
	rows := make([][]string, 0, n)
	for _, r := range firstRows(residents) {
		rows = append(rows, []string{r.Name, strconv.Itoa(r.Days)})
	}
	return Content{Category: Alert, Subject: plural(n, "resident", "residents") + " away from the hostel — " + hostelName,
		HTML: EmailLayout(Layout{Heading: "Residents away", BodyHTML: strings.Join([]string{
			Paragraph(lead + " not been seen at the hostel for a while."),
			ListTable([]ListColumn{{Label: "Name"}, {Label: "Days away", Right: true}}, rows, nil),
			staffMore(n),
			CTAButton(attendanceURL, "Open attendance"),
		}, "\n")})}
}
