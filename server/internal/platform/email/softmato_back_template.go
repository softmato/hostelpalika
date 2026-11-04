package email

// SoftmatoBack is retry.ts backEmail: the server answers again, finish what you started.
func SoftmatoBack(link, name string) Content {
	lead := "T"
	if name != "" {
		lead = "Hi " + name + ", t"
	}
	return Content{Category: Billing, Subject: "The server is back — you can complete your payment",
		HTML: EmailLayout(Layout{Heading: "You can finish now", Preheader: "The server is back. Your payment is ready to complete.",
			BodyHTML: Paragraph(lead+"hank you for waiting. Our parent company's server is responding again, so you can finish what you started.") + CTAButton(link, "Complete it now")})}
}
