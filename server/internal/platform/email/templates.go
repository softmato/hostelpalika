package email

import (
	"math"
	"strconv"
	"strings"
)

// OTPCode is otpCodeEmail. expiresInMinutes <= 0 reads "a short time only".
func OTPCode(code string, expiresInMinutes float64, instruction, siteName string) Content {
	brand := strings.TrimSpace(siteName)
	expiry := "This code works for a short time only."
	if expiresInMinutes > 0 {
		// Math.round: half rounds up.
		expiry = "This code works for " + strconv.FormatFloat(math.Floor(expiresInMinutes+0.5), 'f', -1, 64) + " minutes."
	}
	if instruction == "" {
		instruction = "Enter this code to finish making your account."
	}
	subject := "Your code"
	if brand != "" {
		subject = "Your " + brand + " code"
	}
	return Content{Category: Security, Subject: subject, HTML: EmailLayout(Layout{
		Heading:  "Your code",
		SiteName: brand,
		BodyHTML: strings.Join([]string{
			Paragraph(instruction),
			`<div style="margin:28px 0;text-align:center;">
          <span style="display:inline-block;border:1px dashed #14b8a6;border-radius:12px;background:#f0fdfa;padding:14px 24px;font-size:30px;font-weight:800;letter-spacing:8px;color:#0f766e;">` + EscapeHTML(code) + `</span>
        </div>`,
			Paragraph(EscapeHTML(expiry) + " Did not ask for it? Ignore this email."),
		}, "\n"),
	})}
}

// PasswordReset is passwordResetEmail.
func PasswordReset(resetURL string, expiresInMinutes int) Content {
	return Content{Category: Security, Subject: "Reset your " + PlatformName + " password", HTML: EmailLayout(Layout{
		Heading: "Reset your password",
		BodyHTML: strings.Join([]string{
			Paragraph("Someone asked to reset the password for your " + PlatformName + " account."),
			CTAButton(resetURL, "Reset password"),
			Paragraph("This link works for " + strconv.Itoa(expiresInMinutes) + " minutes. Did not ask for it? Ignore this email. Your password stays the same."),
		}, "\n"),
	})}
}

// Verification is verificationEmail.
func Verification(verifyURL string, expiresInHours int) Content {
	return Content{Category: Security, Subject: "Please check your email", HTML: EmailLayout(Layout{
		Heading: "Check your email",
		BodyHTML: strings.Join([]string{
			Paragraph("Welcome to " + PlatformName + "! Tap the button to start your account."),
			CTAButton(verifyURL, "Yes, this is my email"),
			Paragraph("This link works for " + strconv.Itoa(expiresInHours) + " hours. If it stops working, ask for a new one on the login page."),
		}, "\n"),
	})}
}

// AccountDeletionCancelled is accountDeletionCancelledEmail.
func AccountDeletionCancelled(loginURL, userName string) Content {
	who := "We"
	if userName != "" {
		who = EscapeHTML(userName) + ", we"
	}
	return Content{Category: Security, Subject: "Your account is back on", HTML: EmailLayout(Layout{
		Heading: "Your account is active again",
		BodyHTML: strings.Join([]string{
			Paragraph(who + " stopped the delete request for your " + PlatformName + " account. You can log in now."),
			Paragraph("Nothing was deleted. Everything is the same as before."),
			Paragraph("Not you? Change your password now and tell your hostel."),
			CTAButton(loginURL, "Log in"),
		}, "\n"),
	})}
}

// AccountDeletionRequested is accountDeletionRequestedEmail.
func AccountDeletionRequested(cancelURL, scheduledDeletionDate, userName string) Content {
	who := "You"
	if userName != "" {
		who = EscapeHTML(userName) + ", you"
	}
	date := EscapeHTML(scheduledDeletionDate)
	return Content{Category: Security, Subject: "Your account will be deleted in 60 days", HTML: EmailLayout(Layout{
		Heading: "Your account will be deleted",
		BodyHTML: strings.Join([]string{
			Paragraph(who + " asked us to delete your " + PlatformName + " account. Your account is now closed. You cannot log in."),
			Paragraph("Nothing is deleted yet. We keep your data until <strong>" + date + "</strong> (60 days). After that, it is deleted forever."),
			Paragraph("We will delete: your account, your profile, your location and attendance history, and your devices. Your posts stay, but without your name."),
			Paragraph("We will keep: payment and receipt records, without your name. Hostels must keep these for their accounts."),
			Paragraph("<strong>Not you, or changed your mind? Cancel before " + date + ".</strong> Your account will come back as it was."),
			CTAButton(cancelURL, "Keep my account"),
		}, "\n"),
	})}
}

// AccountDeletionReview is accountDeletionReviewEmail.
func AccountDeletionReview(hostelNames []string, queueURL, reason, requesterEmail, requesterName, requesterRole string) Content {
	who, subjectWho := EscapeHTML(requesterEmail), requesterEmail
	if requesterName != "" {
		who, subjectWho = EscapeHTML(requesterName)+" ("+EscapeHTML(requesterEmail)+")", requesterName
	}
	hostels := Paragraph("No hostels are on this account.")
	if len(hostelNames) > 0 {
		hostels = Paragraph("Hostels on this account: <strong>" + EscapeHTML(strings.Join(hostelNames, ", ")) + "</strong>. If you delete it first, these hostels will have no admin.")
	}
	return Content{Category: Alert, Subject: "Account deletion request from " + subjectWho, HTML: EmailLayout(Layout{
		Heading: "Someone wants to delete their account",
		BodyHTML: strings.Join([]string{
			Paragraph(who + " — <strong>" + EscapeHTML(requesterRole) + "</strong> — has asked for their account to be deleted."),
			hostels,
			Paragraph("Their reason: “" + EscapeHTML(reason) + "”"),
			Paragraph("Nothing has changed yet. They can still log in until you say yes."),
			CTAButton(queueURL, "Check request"),
		}, "\n"),
	})}
}

// ConsultationRequest is consultationRequestEmail (platform/team-requests.ts).
func ConsultationRequest(details []DetailRow, name string) Content {
	return Content{Category: Support, Subject: "Help choosing a hostel — " + name, HTML: EmailLayout(Layout{
		Heading:  "Someone wants help choosing a hostel",
		BodyHTML: DetailsTable(details) + "\n" + Paragraph("Please call or email them."),
	})}
}
