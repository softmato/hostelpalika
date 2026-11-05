import { ctaButton, emailLayout, escapeHtml, paragraph } from "../layout";

/**
 * Sent once Softmato answers again to someone whose payment hit the outage:
 * finish what you started. The name is escaped (it was not, Go P11-22).
 */
export function softmatoBackEmail(input: { link: string; name?: string | null }) {
  return {
    category: "billing" as const,
    html: emailLayout({
      bodyHtml: [
        paragraph(
          `${input.name ? `Hi ${escapeHtml(input.name)}, t` : "T"}hank you for waiting. Our parent company's server is responding again, so you can finish what you started.`,
        ),
        ctaButton(input.link, "Complete it now"),
      ].join(""),
      heading: "You can finish now",
      preheader: "The server is back. Your payment is ready to complete.",
    }),
    subject: "The server is back — you can complete your payment",
  };
}
