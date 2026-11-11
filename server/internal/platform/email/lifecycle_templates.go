package email

import (
	"regexp"
	"strings"
)

// The hostel lifecycle emails a platform admin's review sends
// (packages/shared/src/email/templates/hostel/*).

// Credentials is an email and the temporary password issued with it.
type Credentials struct{ Email, TemporaryPassword string }

// CookLogin is the kitchen login issued with an approval.
type CookLogin struct{ CookName, Email, TemporaryPassword string }

func joinBody(parts ...string) string {
	out := parts[:0:0]
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, "\n")
}

// HostelApproved is hostelApprovedEmail.
func HostelApproved(hostelName, loginURL string, creds *Credentials, cook *CookLogin) Content {
	body := []string{Paragraph("<strong>" + EscapeHTML(hostelName) + "</strong> is approved. It is now on " + PlatformName + ".")}
	if creds != nil {
		body = append(body,
			Paragraph("Email: <strong>"+EscapeHTML(creds.Email)+"</strong><br/>Temporary password: <strong>"+EscapeHTML(creds.TemporaryPassword)+"</strong>"),
			Paragraph("When you first log in, you will set a new password."),
			Paragraph("Use Google? If this email is a Google account, just tap <strong>Continue with Google</strong> on the login page. No password needed."))
	} else {
		body = append(body, Paragraph("Log in with the same account you used to register. It is now a hostel admin account."))
	}
	body = append(body, CTAButton(loginURL, "Go to your dashboard"))
	if cook != nil {
		body = append(body,
			`<hr style="margin:28px 0;border:none;border-top:1px solid #e2e8f0;" />`,
			`<p style="margin:0 0 12px;font-size:16px;font-weight:600;">Cook login</p>`,
			Paragraph("We made a kitchen login for <strong>"+EscapeHTML(cook.CookName)+"</strong>. Give it to your cook. They can tell residents about meals from their phone."),
			Paragraph("Login: <strong>"+EscapeHTML(cook.Email)+"</strong><br/>Password: <strong>"+EscapeHTML(cook.TemporaryPassword)+"</strong>"),
			Paragraph("The first cook to log in sets a new password. All cooks use that same password."),
			Paragraph("Keep it safe. Share it only with cooks. When a cook leaves, make a new password from your Food page. Cooks cannot see payments, complaints or resident details."))
	}
	return Content{Category: Info, Subject: "Your hostel is approved — " + hostelName, HTML: EmailLayout(Layout{Heading: "Hostel approved", BodyHTML: strings.Join(body, "\n")})}
}

// HostelPublished is hostelPublishedEmail.
func HostelPublished(hostelName, listingURL string) Content {
	return Content{Category: Info, Subject: "Your hostel is now online — " + hostelName, HTML: EmailLayout(Layout{Heading: "Your hostel is online", BodyHTML: joinBody(
		Paragraph("<strong>"+EscapeHTML(hostelName)+"</strong> is now on "+PlatformName+". Students looking for a hostel can see it."),
		Paragraph("Keep your photos, prices and free beds up to date. Then more people will contact you."),
		CTAButton(listingURL, "See your hostel"))})}
}

// HostelUnpublished is hostelUnpublishedEmail.
func HostelUnpublished(hostelName, loginURL, reason string) Content {
	return Content{Category: Info, Subject: "Your hostel is hidden from search — " + hostelName, HTML: EmailLayout(Layout{Heading: "Your hostel is hidden", BodyHTML: joinBody(
		Paragraph("The "+PlatformName+" team has hidden <strong>"+EscapeHTML(hostelName)+"</strong> from search."),
		Paragraph("Reason: "+EscapeHTML(reason)),
		Paragraph("Your hostel data is safe. Only the public page is hidden. Fix the problem above, then reply to this email and we will check again."),
		CTAButton(loginURL, "Go to your dashboard"))})}
}

// HostelRejected is hostelRejectedEmail.
func HostelRejected(hostelName, reason string) Content {
	return Content{Category: Info, Subject: "Your hostel is not approved — " + hostelName, HTML: EmailLayout(Layout{Heading: "Not approved", BodyHTML: joinBody(
		Paragraph("We checked <strong>"+EscapeHTML(hostelName)+"</strong>. We cannot approve it now."),
		Paragraph("Reason: "+EscapeHTML(reason)),
		Paragraph("You can fix your details and send again. Think we made a mistake? Reply to this email."))})}
}

// RequestedDocument is one document a reviewer asked for.
type RequestedDocument struct{ DocumentType, Note string }

// HostelDocumentsRequested is hostelDocumentsRequestedEmail.
func HostelDocumentsRequested(docs []RequestedDocument, hostelName, note, ownerName, statusURL string) Content {
	items := make([]string, len(docs))
	for i, d := range docs {
		detail := ""
		if d.Note != "" {
			detail = " — " + EscapeHTML(d.Note)
		}
		items[i] = `<li style="margin-bottom:6px;"><strong>` + EscapeHTML(d.DocumentType) + "</strong>" + detail + "</li>"
	}
	hi := "Hi"
	if ownerName != "" {
		hi += " " + EscapeHTML(ownerName)
	}
	noteP := ""
	if note != "" {
		noteP = Paragraph(EscapeHTML(note))
	}
	return Content{Category: Info, Subject: "Please send more documents — " + hostelName, HTML: EmailLayout(Layout{Heading: "Please send more documents", BodyHTML: joinBody(
		Paragraph(hi+", we checked <strong>"+EscapeHTML(hostelName)+"</strong>. We need a few more documents before we can say yes."),
		noteP,
		`<ul style="padding-left:20px;margin:0 0 16px;color:#334155;">`+strings.Join(items, "\n")+`</ul>`,
		Paragraph("Please open your registration and upload these documents. Then we will check again."),
		CTAButton(statusURL, "Upload documents"))})}
}

// OwnerEmailChanged is ownerEmailChangedEmail; toPrevious picks the old inbox's notice.
func OwnerEmailChanged(hostelName, loginURL, newEmail, previousEmail string, toPrevious, google bool, temporaryPassword string) Content {
	hostel := "<strong>" + EscapeHTML(hostelName) + "</strong>"
	prev := "<strong>" + EscapeHTML(previousEmail) + "</strong>"
	next := "<strong>" + EscapeHTML(newEmail) + "</strong>"
	if toPrevious {
		return Content{Category: Security, Subject: "Owner email changed — " + hostelName, HTML: EmailLayout(Layout{Heading: "Owner email changed", BodyHTML: joinBody(
			Paragraph("The owner email for "+hostel+" on "+PlatformName+" was changed from "+prev+" to "+next+"."),
			Paragraph("This address no longer logs in to the hostel or gets its emails."),
			Paragraph("If this is wrong, reply to this email."))})}
	}
	var login []string
	switch {
	case google:
		login = []string{Paragraph("Your account is now the owner login. On the login page, tap <strong>Continue with Google</strong> and pick " + next + "."),
			Paragraph("Want a password too? Tap <strong>Forgot password</strong> there to set one.")}
	case temporaryPassword != "":
		login = []string{Paragraph("Email: " + next + "<br/>Temporary password: <strong>" + EscapeHTML(temporaryPassword) + "</strong>"),
			Paragraph("When you first log in, you will set a new password."),
			Paragraph("Use Google? If this email is a Google account, just tap <strong>Continue with Google</strong> on the login page. No password needed.")}
	default:
		login = []string{Paragraph("Log in with this email and your password, as before.")}
	}
	body := append([]string{Paragraph("The owner email for " + hostel + " was changed from " + prev + " to " + next + ". Its login and emails now come here.")}, login...)
	body = append(body, CTAButton(loginURL, "Go to your dashboard"))
	return Content{Category: Security, Subject: "Your hostel login — " + hostelName, HTML: EmailLayout(Layout{Heading: "Owner email changed", BodyHTML: strings.Join(body, "\n")})}
}

// HostelVerified is hostelVerifiedEmail ("pay now is on"). free.Until is a formatted date.
func HostelVerified(creds *Credentials, free *FreeTime, supportPhone, hostelName, ownerName string, portalOpensOnPayment bool, selectedPlan *string, statusURL string) Content {
	greet := "Hi,"
	if ownerName != "" {
		greet = "Hi " + EscapeHTML(ownerName) + ","
	}
	plan := ""
	switch {
	case free != nil:
		name := "your plan"
		if selectedPlan != nil {
			name = *selectedPlan
		}
		call := ""
		if supportPhone != "" {
			call = ", or call us on " + EscapeHTML(supportPhone)
		}
		plan = Paragraph("Your hostel is online now on <strong>"+EscapeHTML(name)+"</strong>, free for "+FreeSpan(free.Days, free.Months)+" — until "+EscapeHTML(free.Until)+". There is nothing to pay until then.") + "\n" +
			Paragraph("After that, recharge this hostel yourself from Billing in your dashboard on the website"+call+".")
	case selectedPlan != nil:
		plan = Paragraph("You chose <strong>" + EscapeHTML(*selectedPlan) + "</strong>. One step left: pay for it, and your hostel goes online.")
	default:
		plan = Paragraph("One step left: choose a plan and pay. Then your hostel goes online.")
	}
	portal := ""
	if portalOpensOnPayment {
		portal = Paragraph("Your hostel app opens after you pay. We will email you.")
	}
	login := ""
	if creds != nil {
		login = Paragraph("Log in with these details to pay:") + "\n" + DetailsTable([]DetailRow{{Label: "Email", Value: creds.Email}, {Label: "Password", Value: creds.TemporaryPassword}}) + "\n" +
			SmallPrint("After you log in, you will set your own password.")
	}
	label := "Choose a plan"
	if free != nil {
		label = "See your hostel"
	} else if selectedPlan != nil {
		label = "Pay now"
	}
	return Content{Category: Info, Subject: hostelName + " is checked and ready", HTML: EmailLayout(Layout{Heading: "Your details are OK", BodyHTML: joinBody(
		Paragraph(greet),
		Paragraph("We checked the details and documents for <strong>"+EscapeHTML(hostelName)+"</strong>. Everything is OK."),
		plan, portal, login, CTAButton(statusURL, label))})}
}

// HostelKycApproved is hostelKycApprovedEmail.
func HostelKycApproved(agreementRef string, cook *Credentials, hostelName, listingURL, ownerName, planURL, supportPhone string, trialEnded bool, trialEndsOn string) Content {
	trial := "Your free trial has ended, so the next step is your plan — monthly or lifetime. Get it from the website with the button below within 3 days to keep your portal open."
	if !trialEnded {
		on := trialEndsOn
		if on == "" {
			on = "its end date"
		}
		trial = "Your free trial runs until " + EscapeHTML(on) + ". When it ends, get your plan — monthly or lifetime — from the button below."
	}
	phone, agreement, kitchen := "", "", ""
	if supportPhone != "" {
		phone = Paragraph("Prefer to talk to us? Call " + EscapeHTML(supportPhone) + " and we will activate your plan for you.")
	}
	if agreementRef != "" {
		agreement = Paragraph("Your signed agreement with HostelPalika is attached as a PDF, number <strong>" + EscapeHTML(agreementRef) + "</strong>. Please keep it safe.")
	}
	if cook != nil {
		kitchen = Paragraph("Your kitchen login: <strong>" + EscapeHTML(cook.Email) + "</strong>, password <strong>" + EscapeHTML(cook.TemporaryPassword) + "</strong>. The cook sets their own password after signing in.")
	}
	return Content{Category: Info, Subject: hostelName + " is verified", HTML: EmailLayout(Layout{Heading: "Your KYC is verified", BodyHTML: joinBody(
		hello(ownerName),
		Paragraph("Our team checked the KYC for <strong>"+EscapeHTML(hostelName)+"</strong>. Everything is OK. Every feature of the app is open now, and your hostel is live on the website with the Verified badge."),
		Paragraph(trial), phone, agreement, kitchen,
		CTAButton(planURL, "Get your plan"),
		Paragraph(`Your public page: <a href="`+EscapeHTML(listingURL)+`">`+EscapeHTML(listingURL)+`</a>`))})}
}

// HostelKycSentBack is hostelKycSentBackEmail.
func HostelKycSentBack(hostelName, kycURL, note, ownerName string) Content {
	return Content{Category: Info, Subject: hostelName + ": please fix your KYC", HTML: EmailLayout(Layout{Heading: "Your KYC needs a change", BodyHTML: joinBody(
		hello(ownerName),
		Paragraph("Our team checked the KYC for <strong>"+EscapeHTML(hostelName)+"</strong>."),
		Paragraph("<strong>What to fix:</strong> "+EscapeHTML(note)),
		Paragraph("Fix it in the app and submit again. We check it within 24 hours."),
		CTAButton(kycURL, "Open KYC"))})}
}

// PlanSuspensionNotice is planSuspensionNoticeEmail: pay by a date or the portal stops.
func PlanSuspensionNotice(amount int64, hostelName string, invoiceAttached bool, invoiceNumber, ownerName, payBy, payURL, planName string) Content {
	rs := Rupees(amount)
	attached := ""
	if invoiceAttached {
		attached = "The bill is attached. "
	}
	return Content{Category: Billing, Subject: "Please pay your hostel plan fee by " + payBy + " — " + hostelName, HTML: EmailLayout(Layout{Heading: "Your plan fee is not paid", BodyHTML: strings.Join([]string{
		Greeting(ownerName),
		Paragraph("<strong>" + EscapeHTML(hostelName) + "</strong> has not paid the plan fee. You need to pay <strong>" + EscapeHTML(rs) + "</strong>."),
		Paragraph("Please pay by <strong>" + EscapeHTML(payBy) + "</strong>. If not, the app will stop working for you, your wardens, residents, guardians and cooks until you pay."),
		DetailsTable([]DetailRow{{Label: "Bill no.", Value: invoiceNumber}, {Label: "Plan", Value: planName}, {Label: "To pay", Value: rs, Emphasis: true}, {Label: "Pay by", Value: payBy}}),
		CTAButton(payURL, "Pay now"),
		SmallPrint(attached + "The app works again as soon as we get your payment."),
	}, "\n")})}
}

// SubscriptionClaimRejected is subscriptionClaimRejectedEmail: the claim could not
// be confirmed, said without accusing, with the balance restated.
func SubscriptionClaimRejected(amount int64, hostelName, invoiceNumber string, outstanding int64, ownerName, planName, reason string) Content {
	greeting := "Hi,"
	if ownerName != "" {
		greeting = "Hi " + EscapeHTML(ownerName) + ","
	}
	parts := []string{Paragraph(greeting),
		Paragraph("We checked your payment photo for <strong>" + Rupees(amount) + "</strong> (bill <strong>" + EscapeHTML(invoiceNumber) + "</strong>, <strong>" + EscapeHTML(hostelName) + "</strong>). We did not get this money.")}
	if reason != "" {
		parts = append(parts, Paragraph("Reason: <strong>"+EscapeHTML(reason)+"</strong>"))
	}
	parts = append(parts,
		Paragraph("You still need to pay <strong>"+Rupees(outstanding)+"</strong> for <strong>"+EscapeHTML(planName)+"</strong>."),
		Paragraph("If you did pay, send a clear screenshot again. It must show the amount, the date and the transaction ID. Bank payments can take one day to reach us, so you can also try again tomorrow."),
		Paragraph("Nothing else has changed. Need help? Reply to this email."))
	return Content{Category: Billing, Subject: "We could not find your payment — " + hostelName, HTML: EmailLayout(Layout{Heading: "We could not find your payment", BodyHTML: strings.Join(parts, "\n")})}
}

var blankLines = regexp.MustCompile(`\n{2,}`)

// PlatformNotice is platformNoticeEmail: a notice the platform team wrote to a
// hostel owner. The text is escaped, split into paragraphs on blank lines, and
// single line breaks are kept.
func PlatformNotice(body, dashboardURL, hostelName, ownerName, title string) Content {
	parts := []string{Greeting(ownerName)}
	for _, p := range blankLines.Split(body, -1) {
		if p = strings.TrimSpace(p); p != "" {
			parts = append(parts, Paragraph(strings.ReplaceAll(EscapeHTML(p), "\n", "<br>")))
		}
	}
	parts = append(parts, CTAButton(dashboardURL, "Open your dashboard"))
	return Content{Category: Info, Subject: title + " — " + hostelName, HTML: EmailLayout(Layout{Eyebrow: "From the " + PlatformName + " team", Heading: title, BodyHTML: joinBody(parts...)})}
}
