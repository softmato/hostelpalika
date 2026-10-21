import { ctaButton, emailLayout, escapeHtml, paragraph, type EmailContent } from "../layout";

/**
 * The quick sign-up's emails (docs/QUICK_SIGNUP_KYC_TRIAL.md): the portal is
 * open, the KYC was approved, the KYC was sent back, the trial is ending.
 * Plain words, facts only — the plan itself is paid on the website.
 */

function hello(name?: string) {
  return paragraph(name ? `Hi ${escapeHtml(name)},` : "Hi,");
}

export function hostelPortalOpenEmail(input: {
  hostelName: string;
  kycUrl: string;
  ownerName?: string;
  trialDays: number;
  trialEndsOn: string;
}): EmailContent {
  return {
    category: "info",
    subject: `Your ${input.hostelName} portal is open — ${input.trialDays} days free`,
    html: emailLayout({
      heading: "Congratulations — your hostel portal is open",
      bodyHtml: [
        hello(input.ownerName),
        paragraph(
          `<strong>${escapeHtml(input.hostelName)}</strong> now has its own hostel portal in the app and on the website. You have <strong>${input.trialDays} days free</strong>, until ${escapeHtml(input.trialEndsOn)}. Enjoy and explore.`,
        ),
        paragraph(
          "Next, complete your hostel KYC: photos, documents, rooms and your address. Our team checks it within 24 hours. Until then some features stay locked, and your hostel is not shown to the public.",
        ),
        ctaButton(input.kycUrl, "Complete KYC"),
      ].join("\n"),
    }),
  };
}

/** The signed agreement, for a hostel already verified when its owner signs. */
export function hostelAgreementEmail(input: { hostelName: string; ownerName?: string; refCode: string }): EmailContent {
  return {
    category: "info",
    subject: `Your HostelPalika agreement for ${input.hostelName}`,
    html: emailLayout({
      heading: "Your signed agreement",
      bodyHtml: [
        hello(input.ownerName),
        paragraph(
          `Thank you for signing. Your agreement with HostelPalika for <strong>${escapeHtml(input.hostelName)}</strong> is attached as a PDF, number <strong>${escapeHtml(input.refCode)}</strong>. Please keep it safe.`,
        ),
        paragraph("It says what you get, how your data is kept safe, and how you can take all of your data with you if you ever leave."),
      ].join("\n"),
    }),
  };
}

export function hostelKycApprovedEmail(input: {
  /** The signed agreement PDF rides on this email. */
  agreementRefCode?: string | null;
  cookCredentials?: { email: string; temporaryPassword: string } | null;
  hostelName: string;
  listingUrl: string;
  ownerName?: string;
  /** The website checkout for this hostel, no sign-in needed. */
  planUrl: string;
  supportPhone?: string | null;
  /** The trial is already over: the plan is the next step, with a few days' grace. */
  trialEnded: boolean;
  trialEndsOn?: string | null;
}): EmailContent {
  return {
    category: "info",
    subject: `${input.hostelName} is verified`,
    html: emailLayout({
      heading: "Your KYC is verified",
      bodyHtml: [
        hello(input.ownerName),
        paragraph(
          `Our team checked the KYC for <strong>${escapeHtml(input.hostelName)}</strong>. Everything is OK. Every feature of the app is open now, and your hostel is live on the website with the Verified badge.`,
        ),
        paragraph(
          input.trialEnded
            ? "Your free trial has ended, so the next step is your plan — monthly or lifetime. Get it from the website with the button below within 3 days to keep your portal open."
            : `Your free trial runs until ${escapeHtml(input.trialEndsOn ?? "its end date")}. When it ends, get your plan — monthly or lifetime — from the button below.`,
        ),
        input.supportPhone
          ? paragraph(`Prefer to talk to us? Call ${escapeHtml(input.supportPhone)} and we will activate your plan for you.`)
          : "",
        input.agreementRefCode
          ? paragraph(
              `Your signed agreement with HostelPalika is attached as a PDF, number <strong>${escapeHtml(input.agreementRefCode)}</strong>. Please keep it safe.`,
            )
          : "",
        input.cookCredentials
          ? paragraph(
              `Your kitchen login: <strong>${escapeHtml(input.cookCredentials.email)}</strong>, password <strong>${escapeHtml(input.cookCredentials.temporaryPassword)}</strong>. The cook sets their own password after signing in.`,
            )
          : "",
        ctaButton(input.planUrl, "Get your plan"),
        paragraph(`Your public page: <a href="${escapeHtml(input.listingUrl)}">${escapeHtml(input.listingUrl)}</a>`),
      ]
        .filter(Boolean)
        .join("\n"),
    }),
  };
}

export function hostelKycSentBackEmail(input: {
  hostelName: string;
  kycUrl: string;
  note: string;
  ownerName?: string;
}): EmailContent {
  return {
    category: "info",
    subject: `${input.hostelName}: please fix your KYC`,
    html: emailLayout({
      heading: "Your KYC needs a change",
      bodyHtml: [
        hello(input.ownerName),
        paragraph(`Our team checked the KYC for <strong>${escapeHtml(input.hostelName)}</strong>.`),
        paragraph(`<strong>What to fix:</strong> ${escapeHtml(input.note)}`),
        paragraph("Fix it in the app and submit again. We check it within 24 hours."),
        ctaButton(input.kycUrl, "Open KYC"),
      ].join("\n"),
    }),
  };
}

export function hostelTrialEndingEmail(input: {
  billingUrl: string;
  daysLeft: number;
  hostelName: string;
  /** The KYC is not approved yet: the plan cannot be bought, so KYC comes first. */
  kycPending?: boolean;
  kycUrl?: string;
  ownerName?: string;
  supportPhone?: string | null;
  trialEndsOn: string;
}): EmailContent {
  const when =
    input.daysLeft <= 0 ? "ends today" : `ends in ${input.daysLeft} ${input.daysLeft === 1 ? "day" : "days"}`;

  return {
    category: "info",
    subject: `${input.hostelName}: your free trial ${when}`,
    html: emailLayout({
      heading: `Your free trial ${when}`,
      bodyHtml: [
        hello(input.ownerName),
        paragraph(
          input.kycPending
            ? `The free trial for <strong>${escapeHtml(input.hostelName)}</strong> ends on ${escapeHtml(input.trialEndsOn)}, and your KYC is not approved yet. After the trial, your portal stays closed until it is. Please complete your KYC first — once our team approves it, you can get your plan.`
            : `The free trial for <strong>${escapeHtml(input.hostelName)}</strong> ends on ${escapeHtml(input.trialEndsOn)}. To keep using your hostel portal after that, get your plan — monthly or lifetime.`,
        ),
        input.supportPhone
          ? paragraph(`You can also call us on ${escapeHtml(input.supportPhone)} and we will activate your plan for you.`)
          : "",
        input.kycPending && input.kycUrl
          ? ctaButton(input.kycUrl, "Complete KYC")
          : ctaButton(input.billingUrl, "Get your plan"),
      ]
        .filter(Boolean)
        .join("\n"),
    }),
  };
}
