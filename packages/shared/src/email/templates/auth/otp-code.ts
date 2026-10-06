import { emailLayout, escapeHtml, paragraph, type EmailContent } from "../layout";

/**
 * The signup one-time code (docs/EMAIL_SYSTEM.md §1.0).
 *
 * `siteName` is optional for the same reason it is on `emailLayout`: this is
 * called from the auth service, which sends the code before there is a session
 * or a request scope to hang a settings read on. Left out, the shell falls back
 * to the shipped product name — the sender identity on the envelope is still
 * the configured one, because that is resolved inside `sendEmail()`.
 */
export function otpCodeEmail(input: {
  code: string;
  expiresInMinutes?: number;
  /** What the code is for. Left out, it is the signup line. */
  instruction?: string;
  siteName?: string;
}): EmailContent {
  const brand = input.siteName?.trim();
  const expiry =
    input.expiresInMinutes && input.expiresInMinutes > 0
      ? `This code works for ${Math.round(input.expiresInMinutes)} minutes.`
      : "This code works for a short time only.";

  return {
    category: "security",
    subject: brand ? `Your ${brand} code` : "Your code",
    html: emailLayout({
      heading: "Your code",
      ...(brand ? { siteName: brand } : {}),
      bodyHtml: [
        paragraph(
          input.instruction ?? "Enter this code to finish making your account.",
        ),
        `<div style="margin:28px 0;text-align:center;">
          <span style="display:inline-block;border:1px dashed #14b8a6;border-radius:12px;background:#f0fdfa;padding:14px 24px;font-size:30px;font-weight:800;letter-spacing:8px;color:#0f766e;">${escapeHtml(input.code)}</span>
        </div>`,
        paragraph(
          `${escapeHtml(expiry)} Did not ask for it? Ignore this email.`,
        ),
      ].join("\n"),
    }),
  };
}
