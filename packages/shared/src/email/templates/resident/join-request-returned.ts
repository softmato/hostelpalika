import { ctaButton, emailLayout, escapeHtml, paragraph, type EmailContent } from "../layout";

/**
 * The hostel sent a join request back to be fixed. Says what they wrote and
 * where to fix it — the same link, the same request, nothing to start again.
 */
export function joinRequestReturnedEmail(input: {
  fixUrl: string;
  hostelName: string;
  reason: string;
  residentName: string;
}): EmailContent {
  return {
    category: "info",
    subject: `${input.hostelName} sent your request back`,
    html: emailLayout({
      heading: "Please fix your request",
      bodyHtml: [
        paragraph(
          `Hi ${escapeHtml(input.residentName)}, <strong>${escapeHtml(input.hostelName)}</strong> checked your request to be added as a resident and sent it back.`,
        ),
        paragraph(`They wrote: <strong>${escapeHtml(input.reason)}</strong>`),
        paragraph("Fix it and send it again from the same link. It stays the same request."),
        ctaButton(input.fixUrl, "Fix my request"),
      ].join("\n"),
    }),
  };
}
