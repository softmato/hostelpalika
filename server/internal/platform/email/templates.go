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
