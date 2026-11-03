import { ctaButton, emailLayout, escapeHtml, paragraph, type EmailContent } from "../layout";

/**
 * Sent when a superadmin invites somebody onto the platform admin roster.
 *
 * No password is minted and none is sent — the sibling `credentialsIssued`
 * mail does that, for the older path where the account is created up front.
 * Here the link *is* the credential: opening it proves the mailbox is theirs,
 * which is the whole reason a platform role may be granted through it, and the
 * recipient signs in with Google on the same address afterwards.
 *
 * The grade being granted is named in the subject and again in the body,
 * because "you have been made a superadmin" and "you have been made a
 * moderator" are very different messages to receive and the recipient should
 * not have to accept one to find out which it was.
 */
export function platformAdminInvitationEmail(input: {
  acceptUrl: string;
  expiresInDays: number;
  invitedByName: string;
  roleLabel: string;
  siteName?: string;
}): EmailContent {
  const isSuperadmin = input.roleLabel.toLowerCase().includes("superadmin");

  return {
    category: "security",
    subject: `You are invited as ${input.roleLabel}`,
    html: emailLayout({
      heading: "You are invited to our team",
      siteName: input.siteName,
      bodyHtml: [
        paragraph(
          `<strong>${escapeHtml(input.invitedByName)}</strong> invited you to join the team as <strong>${escapeHtml(input.roleLabel)}</strong>.`,
        ),
        paragraph(
          isSuperadmin
            ? "A superadmin can see and change everything: all hostels, all payments, the website, and who is admin."
            : input.roleLabel === "Team Member"
              ? "A team member registers hostels in the field and records the cash they collect. They cannot see the platform's payments, settings or admins."
              : "A moderator approves and checks hostels and can read reports. They cannot change the website, plans, settings or admins.",
        ),
        paragraph(
          "Tap the button below to accept. No form and no password. Confirm on the page, then log in with Google using this email.",
        ),
        ctaButton(input.acceptUrl, "Accept"),
        paragraph(
          `<span style="color:#64748b;font-size:13px;">This link works one time, for ${input.expiresInDays} day(s). Not expecting this? Ignore it. Nothing changes unless you open the link.</span>`,
        ),
      ].join("\n"),
    }),
  };
}
