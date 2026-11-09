package email

import (
	"strconv"
	"strings"
)

// PlanDue is plan-due.ts's PlanDueInput.
type PlanDue struct {
	AmountDue                                     int64
	Attached                                      bool
	DueDate, HostelName, InvoiceNumber, OwnerName string
	PayURL, PlanName                              string
}

const planAlreadyPaid = "Already paid? Send us a photo of the payment from your billing page."

func payOnWebsite(payURL string) string {
	return SmallPrint("Pay on the " + PlatformName + " website: " + TextLink(payURL, payURL))
}

func joinNonEmpty(parts ...string) string {
	kept := parts[:0]
	for _, p := range parts {
		if p != "" {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, "\n")
}

func dueWhen(days int) string {
	switch {
	case days <= 0:
		return "today"
	case days == 1:
		return "tomorrow"
	}
	return "in " + strconv.Itoa(days) + " days"
}

func (in PlanDue) attachedLine() string {
	if in.Attached {
		return SmallPrint("The bill (PDF) is attached.")
	}
	return ""
}

// PlanDueSoon is planDueSoonEmail.
func PlanDueSoon(in PlanDue, daysUntilDue int, live bool) Content {
	when := dueWhen(daysUntilDue)
	notLive := ""
	if !live {
		notLive = SmallPrint("Your hostel shows online after you pay.")
	}
	return Content{Category: Billing, Subject: "Please pay your hostel plan fee " + when + " — " + in.HostelName,
		HTML: EmailLayout(Layout{Eyebrow: "Reminder", Heading: "Please pay your plan fee " + when, Preheader: "Pay " + Rupees(in.AmountDue) + " by " + in.DueDate + ".",
			BodyHTML: joinNonEmpty(Greeting(in.OwnerName),
				Paragraph("Please pay your <strong>"+EscapeHTML(in.PlanName)+"</strong> fee for <strong>"+EscapeHTML(in.HostelName)+"</strong> "+when+"."),
				DetailsTable([]DetailRow{{Label: "To pay", Value: Rupees(in.AmountDue), Emphasis: true}, {Label: "Pay by", Value: in.DueDate}, {Label: "Bill no.", Value: in.InvoiceNumber}}),
				CTAButton(in.PayURL, "Pay now"), payOnWebsite(in.PayURL), in.attachedLine(), notLive, SmallPrint(planAlreadyPaid))})}
}

// PlanOverdue is planOverdueEmail.
func PlanOverdue(in PlanDue) Content {
	return Content{Category: Alert, Subject: "Please pay your hostel plan fee — " + in.HostelName,
		HTML: EmailLayout(Layout{Eyebrow: "Late", Heading: "Please pay your plan fee", Urgent: true,
			Preheader: Rupees(in.AmountDue) + " is late. Last date was " + in.DueDate + ".",
			BodyHTML: joinNonEmpty(Greeting(in.OwnerName),
				Paragraph("Your <strong>"+EscapeHTML(in.PlanName)+"</strong> fee for <strong>"+EscapeHTML(in.HostelName)+"</strong> is late. Please pay now."),
				DetailsTable([]DetailRow{{Label: "To pay", Value: Rupees(in.AmountDue), Emphasis: true}, {Label: "Last date was", Value: in.DueDate}, {Label: "Bill no.", Value: in.InvoiceNumber}}),
				CTAButton(in.PayURL, "Pay now"), payOnWebsite(in.PayURL), in.attachedLine(), SmallPrint(planAlreadyPaid))})}
}

// HostelTrialEnding is hostelTrialEndingEmail: the trial runs out soon; KYC first when it is not approved.
func HostelTrialEnding(billingURL string, daysLeft int, hostelName string, kycPending bool, kycURL, ownerName, supportPhone, trialEndsOn string) Content {
	when := "ends today"
	if daysLeft > 0 {
		unit := "days"
		if daysLeft == 1 {
			unit = "day"
		}
		when = "ends in " + strconv.Itoa(daysLeft) + " " + unit
	}
	lead := "The free trial for <strong>" + EscapeHTML(hostelName) + "</strong> ends on " + EscapeHTML(trialEndsOn) + ". After that it moves to the Free plan and its smaller limits. To keep every seat you have now, get your plan — monthly or lifetime."
	if kycPending {
		lead = "The free trial for <strong>" + EscapeHTML(hostelName) + "</strong> ends on " + EscapeHTML(trialEndsOn) + ", and your KYC is not approved yet. After the trial, your portal stays closed until it is. Please complete your KYC first — once our team approves it, you can get your plan."
	}
	phone := ""
	if supportPhone != "" {
		phone = Paragraph("You can also call us on " + EscapeHTML(supportPhone) + " and we will activate your plan for you.")
	}
	button := CTAButton(billingURL, "Get your plan")
	if kycPending && kycURL != "" {
		button = CTAButton(kycURL, "Complete KYC")
	}
	return Content{Category: Info, Subject: hostelName + ": your free trial " + when,
		HTML: EmailLayout(Layout{Heading: "Your free trial " + when, BodyHTML: joinNonEmpty(hello(ownerName), Paragraph(lead), phone, button)})}
}
