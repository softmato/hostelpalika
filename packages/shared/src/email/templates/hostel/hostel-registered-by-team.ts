import {
  ctaButton,
  detailsTable,
  emailLayout,
  escapeHtml,
  greeting,
  paragraph,
  smallPrint,
  textLink,
  type EmailContent,
} from "../layout";
import { formatRupees } from "../billing/subscription-invoice";
import { PLATFORM_NAME } from "../../../brand/brand";

/**
 * What an owner gets when our own field team registered them.
 *
 * There is no queue and no waiting in this one, because there was none: an
 * agent sat with them, checked the papers, and the listing went live on the
 * spot. So this email is a confirmation rather than an acknowledgement, and it
 * must not borrow the "we'll review this shortly" language of the public path —
 * the owner would be left waiting for a second email that is never coming.
 *
 * When money is still owed it says so in the same breath as the good news, and
 * this is the email that carries *Pay now*: it is the first one that knows what
 * is actually left after the agent collected. Burying a balance under a
 * celebration is how a due goes unpaid until it becomes a suspension nobody saw
 * coming.
 */
export function hostelRegisteredByTeamEmail(input: {
  agentName?: string;
  amountPaid: number;
  /** The hostel's plan billing page, where a balance is paid. */
  billingUrl?: string;
  dueBy?: string | null;
  /** The plan went live on its free months: how many, and the last free day. */
  free?: { months: number; until: string } | null;
  hostelName: string;
  listingUrl: string;
  outstanding: number;
  ownerName?: string;
  planName: string;
  /**
   * The setup fee the agent reported collecting. Stated plainly so an owner
   * who handed over more can tell us — the call is our check on field cash.
   */
  setupFee?: number | null;
  supportPhone?: string;
}): EmailContent {
  const owes = input.outstanding > 0;
  const call = input.supportPhone ? `call us on ${escapeHtml(input.supportPhone)}` : "reply to this email";

  return {
    category: "info",
    subject: `${input.hostelName} is now online on ${PLATFORM_NAME}`,
    html: emailLayout({
      bodyHtml: [
        greeting(input.ownerName),
        paragraph(
          input.agentName
            ? `<strong>${escapeHtml(input.agentName)}</strong> from our team added <strong>${escapeHtml(input.hostelName)}</strong> with you. It is now online. Students can see it.`
            : `<strong>${escapeHtml(input.hostelName)}</strong> is now online. Students can see it.`,
        ),
        detailsTable([
          {
            label: "Plan",
            value: input.free ? `${input.planName} — free until ${input.free.until}` : input.planName,
          },
          input.setupFee
            ? { label: "Setup fee paid", value: formatRupees(input.setupFee) }
            : {
                label: "Paid today",
                value: input.amountPaid > 0 ? formatRupees(input.amountPaid) : "",
              },
          ...(owes
            ? [
                {
                  emphasis: true,
                  label: "Left to pay",
                  value: formatRupees(input.outstanding),
                },
                { label: "Pay by", value: input.dueBy ?? "" },
              ]
            : []),
        ]),
        ...(input.free
          ? [
              paragraph(
                `Your plan is free for ${input.free.months} ${input.free.months === 1 ? "month" : "months"}, until ${escapeHtml(input.free.until)}. There is nothing to pay for it until then. After that, recharge this hostel yourself from Billing on the website, or ${call}.`,
              ),
            ]
          : []),
        ...(input.setupFee
          ? [
              smallPrint(
                `You paid our team member a setup fee of ${formatRupees(input.setupFee)}. That is the only amount they may take. If you paid them more, or anything for the plan, please ${call}.`,
              ),
            ]
          : []),
        ...(owes && input.billingUrl
          ? [
              ctaButton(input.billingUrl, "Pay now"),
              smallPrint(
                `Your hostel stays online while you pay. ${textLink(input.listingUrl, "See your hostel")}`,
              ),
            ]
          : [
              paragraph(
                owes
                  ? "You can pay the rest from your dashboard. Your hostel stays online."
                  : input.free
                    ? "Nothing more to pay today."
                    : "Your plan is fully paid. Nothing more to pay.",
              ),
              ctaButton(input.listingUrl, "See your hostel"),
            ]),
      ].join("\n"),
      heading: "Your hostel is online",
      preheader: owes
        ? `${input.hostelName} is online. Please pay ${formatRupees(input.outstanding)}${input.dueBy ? ` by ${input.dueBy}` : ""}.`
        : input.free
          ? `${input.hostelName} is online, free until ${input.free.until}.`
          : `${input.hostelName} is online and your plan is fully paid.`,
    }),
  };
}
