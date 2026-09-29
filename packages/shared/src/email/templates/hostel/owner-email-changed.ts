import { ctaButton, emailLayout, escapeHtml, paragraph, type EmailContent } from "../layout";
import { PLATFORM_NAME } from "../../../brand/brand";

/**
 * Sent to both inboxes when a superadmin corrects a hostel's owner email: the
 * old one learns where the hostel went, the new one gets the login. Each names
 * the other address so either side can spot a wrong correction.
 */
export function ownerEmailChangedEmail(input: {
  hostelName: string;
  loginUrl: string;
  newEmail: string;
  previousEmail: string;
  recipient: "new" | "previous";
  /** The new address signs in with Google — say so instead of sending a password. */
  google?: boolean;
  /** Only for the new inbox, and only when the account has no password of its own. */
  temporaryPassword?: string | null;
}): EmailContent {
  const hostel = `<strong>${escapeHtml(input.hostelName)}</strong>`;
  const previous = `<strong>${escapeHtml(input.previousEmail)}</strong>`;
  const next = `<strong>${escapeHtml(input.newEmail)}</strong>`;

  if (input.recipient === "previous") {
    return {
      category: "security",
      subject: `Owner email changed — ${input.hostelName}`,
      html: emailLayout({
        heading: "Owner email changed",
        bodyHtml: [
          paragraph(
            `The owner email for ${hostel} on ${PLATFORM_NAME} was changed from ${previous} to ${next}.`,
          ),
          paragraph("This address no longer logs in to the hostel or gets its emails."),
          paragraph("If this is wrong, reply to this email."),
        ].join("\n"),
      }),
    };
  }

  const login = input.google
    ? [
        paragraph(
          `Your account is now the owner login. On the login page, tap <strong>Continue with Google</strong> and pick ${next}.`,
        ),
        paragraph("Want a password too? Tap <strong>Forgot password</strong> there to set one."),
      ]
    : input.temporaryPassword
    ? [
        paragraph(
          `Email: ${next}<br/>Temporary password: <strong>${escapeHtml(input.temporaryPassword)}</strong>`,
        ),
        paragraph("When you first log in, you will set a new password."),
        paragraph(
          "Use Google? If this email is a Google account, just tap <strong>Continue with Google</strong> on the login page. No password needed.",
        ),
      ]
    : [paragraph("Log in with this email and your password, as before.")];

  return {
    category: "security",
    subject: `Your hostel login — ${input.hostelName}`,
    html: emailLayout({
      heading: "Owner email changed",
      bodyHtml: [
        paragraph(
          `The owner email for ${hostel} was changed from ${previous} to ${next}. Its login and emails now come here.`,
        ),
        ...login,
        ctaButton(input.loginUrl, "Go to your dashboard"),
      ].join("\n"),
    }),
  };
}
