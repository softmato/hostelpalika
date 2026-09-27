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
 * The email that turns *Pay now* on.
 *
 * The one the owner has been waiting for since they submitted: their documents
 * and details have been read by a person and accepted. It is deliberately
 * separate from `hostel-approved`, which hands over admin credentials — this
 * one has a single job, which is to say the wait is over and point at the
 * button that is now live.
 *
 * Two wordings, because the owner may already have chosen a plan while waiting
 * (the registration page lets them, on purpose). If they have, there is exactly
 * one thing left to do and the email says so; if they have not, the next step
 * is choosing.
 *
 * For a public registration the portal is **not** open yet — it opens with the
 * payment — and the email says so plainly. An owner who registered without an
 * account also gets a temporary password here: paying happens behind a sign-in,
 * and without one they would have no way to reach the button this email is
 * about.
 */
export function hostelVerifiedEmail(input: {
  /**
   * A way to sign in, for an owner who registered without an account and so
   * had none. It opens their public account — enough to pay — not the portal.
   */
  credentials?: { email: string; temporaryPassword: string } | null;
  /**
   * The plan went live on its free months at verification: nothing to pay
   * until `until`. Replaces the "pay for it" wording.
   */
  free?: { months: number; supportPhone?: string; until: string } | null;
  hostelName: string;
  ownerName?: string;
  /** A public registration: the hostel portal opens with the payment, not before. */
  portalOpensOnPayment?: boolean;
  /** The plan they picked during the wait, if they picked one. */
  selectedPlanName?: string | null;
  statusUrl: string;
}): EmailContent {
  const greeting = input.ownerName ? `Hi ${escapeHtml(input.ownerName)},` : "Hi,";

  return {
    category: "info",
    subject: `${input.hostelName} is checked and ready`,
    html: emailLayout({
      heading: "Your details are OK",
      bodyHtml: [
        paragraph(greeting),
        paragraph(
          `We checked the details and documents for <strong>${escapeHtml(input.hostelName)}</strong>. Everything is OK.`,
        ),
        input.free
          ? [
              paragraph(
                `Your hostel is online now on <strong>${escapeHtml(input.selectedPlanName ?? "your plan")}</strong>, free for ${input.free.months} ${input.free.months === 1 ? "month" : "months"} — until ${escapeHtml(input.free.until)}. There is nothing to pay until then.`,
              ),
              paragraph(
                `After that, recharge this hostel yourself from Billing in your dashboard on the website${input.free.supportPhone ? `, or call us on ${escapeHtml(input.free.supportPhone)}` : ""}.`,
              ),
            ].join("\n")
          : input.selectedPlanName
            ? paragraph(
                `You chose <strong>${escapeHtml(input.selectedPlanName)}</strong>. One step left: pay for it, and your hostel goes online.`,
              )
            : paragraph(
                "One step left: choose a plan and pay. Then your hostel goes online.",
              ),
        input.portalOpensOnPayment
          ? paragraph(
              "Your hostel app opens after you pay. We will email you.",
            )
          : "",
        input.credentials
          ? [
              paragraph("Log in with these details to pay:"),
              detailsTable([
                { label: "Email", value: input.credentials.email },
                { label: "Password", value: input.credentials.temporaryPassword },
              ]),
              smallPrint("After you log in, you will set your own password."),
            ].join("\n")
          : "",
        ctaButton(
          input.statusUrl,
          input.free ? "See your hostel" : input.selectedPlanName ? "Pay now" : "Choose a plan",
        ),
      ]
        .filter(Boolean)
        .join("\n"),
    }),
  };
}
