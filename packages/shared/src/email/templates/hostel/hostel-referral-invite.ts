import {
  ctaButton,
  detailsTable,
  emailLayout,
  escapeHtml,
  paragraph,
  smallPrint,
  type EmailContent,
} from "../layout";

/**
 * A hostel owner or warden inviting another hostel to register with their code.
 * Sent to someone who is not a user yet, so it says who sent it and carries the
 * code in plain text as well as in the link.
 */
export function hostelReferralInviteEmail(input: {
  code: string;
  fromHostelName: string;
  inviteeName?: string;
  link: string;
  /** "1 month" — what the new hostel gets. Empty when the program gives nothing extra. */
  offer: string;
  platformName: string;
}): EmailContent {
  const greeting = input.inviteeName ? `Hi ${escapeHtml(input.inviteeName)},` : "Hi,";

  return {
    category: "info",
    subject: `${input.fromHostelName} invited you to ${input.platformName}`,
    html: emailLayout({
      heading: "Run your hostel online",
      preheader: `${input.fromHostelName} uses ${input.platformName} and invited you.`,
      bodyHtml: [
        paragraph(greeting),
        paragraph(
          `<strong>${escapeHtml(input.fromHostelName)}</strong> runs their hostel on ${escapeHtml(input.platformName)} — residents, fees, rooms and food in one app — and invited you to register yours.`,
        ),
        input.offer
          ? paragraph(
              `Register with their referral code and your plan gets <strong>${escapeHtml(input.offer)}</strong> extra, free.`,
            )
          : "",
        detailsTable([{ label: "Referral code", value: input.code }]),
        ctaButton(input.link, "Register your hostel"),
        smallPrint("Choose “I have a referral code” when you start, and type the code above if it is not filled in."),
      ]
        .filter(Boolean)
        .join("\n"),
    }),
  };
}
