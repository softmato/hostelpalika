import { ctaButton, emailLayout, escapeHtml, greeting, paragraph, type EmailContent } from "../layout";
import { PLATFORM_NAME } from "../../../brand/brand";

/**
 * A notice the platform team wrote by hand to one or more hostel owners
 * (Listings → Send notice). The text is the team's own, so it is escaped and
 * split into paragraphs on blank lines; single line breaks are kept.
 */
export function platformNoticeEmail(input: {
  body: string;
  dashboardUrl: string;
  hostelName: string;
  ownerName?: string;
  title: string;
}): EmailContent {
  const paragraphs = input.body
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => paragraph(escapeHtml(part).replaceAll("\n", "<br>")));

  return {
    category: "info",
    subject: `${input.title} — ${input.hostelName}`,
    html: emailLayout({
      eyebrow: `From the ${PLATFORM_NAME} team`,
      heading: input.title,
      bodyHtml: [
        greeting(input.ownerName),
        ...paragraphs,
        ctaButton(input.dashboardUrl, "Open your dashboard"),
      ].join("\n"),
    }),
  };
}
