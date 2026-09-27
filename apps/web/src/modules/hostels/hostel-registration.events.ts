import { hostelRegisteredByTeamEmail } from "@hostel/shared/email/templates/hostel/hostel-registered-by-team";
import { hostelSubmissionReceivedEmail } from "@hostel/shared/email/templates/hostel/submission-received";
import { hostelVerifiedEmail } from "@hostel/shared/email/templates/hostel/hostel-verified";
import { subscriptionInvoiceEmail } from "@hostel/shared/email/templates/billing/subscription-invoice";
import { planSuspensionNoticeEmail } from "@hostel/shared/email/templates/billing/plan-suspension-notice";
import { subscriptionReceiptEmail } from "@hostel/shared/email/templates/billing/subscription-receipt";
import { sendEmail, type EmailAttachment } from "@hostel/shared/email/sender";
import { emailDate, type EmailContent } from "@hostel/shared/email/templates/layout";

import {
  resolveInvoiceDocument,
  resolveReceiptDocument,
} from "@/modules/billing/documents/deliver";
import { getSiteConfigSection } from "@/modules/platform-config/site-config.service";

/**
 * Every email the registration lifecycle sends, in one file.
 *
 * ## Why this exists
 *
 * The side effects of "somebody submitted a hostel" were spread through the
 * service that wrote the rows: an email here, a platform notification there, a
 * status change somewhere else. With one desk that was survivable. With two —
 * a public owner and a field agent posting the same shape at different times,
 * one of which publishes immediately — it is not, because the only way to know
 * what an owner is actually told is to read both call paths and hold them in
 * your head at once.
 *
 * So each moment in the lifecycle is a function here, and both desks call the
 * same ones. What changes between them is *which* moments occur, never what a
 * given moment says.
 *
 * ## The moments
 *
 * | | public | team |
 * |---|---|---|
 * | `submitted` | "we'll verify, 1–2 business days" | — |
 * | `registeredByTeam` | — | "you're live", plus *Pay now* for any balance |
 * | `verified` | "pay now is on" | — (never queues) |
 * | `invoiceIssued` | on *Pay now*, with *Pay now* | when the agent passes the plan step, with *View billing* |
 * | `paymentSettled` | receipt | receipt, with the balance if any |
 *
 * Reminders about a payment that has not arrived are not moments in this
 * lifecycle — they are a daily sweep — and live in
 * `billing/plan-due-reminders.service.ts`.
 *
 * ## Nothing here may throw
 *
 * Delivery failure must never fail the business flow behind it — a hostel that
 * registered successfully has registered successfully whether or not Resend was
 * reachable. `sendEmail` already swallows its own errors and reports them in
 * the result; these wrappers add the logging so a silent non-delivery is at
 * least visible in the logs.
 */

function appBase() {
  return process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

/** The owner's progress page. The same URL at every stage — it is one page. */
export function registrationStatusUrl() {
  return `${appBase()}/register-hostel/form`;
}

export function hostelListingUrl(slug: string) {
  return `${appBase()}/hostels/${slug}`;
}

/**
 * The hostel's plan billing page — where a live hostel pays what it owes.
 *
 * The tenant path itself rather than `/hostel-admin/billing`, so the link lands
 * in one hop. An owner who is signed out is sent to log in and brought straight
 * back here (`proxy.ts` keeps the path in `next`).
 */
export function hostelBillingUrl(slug: string) {
  return `${appBase()}/${encodeURIComponent(slug)}/admin/billing`;
}

/** Dates in emails are read by people, not parsed — both calendars, see `emailDate`. */
export function formatEmailDate(value?: Date | string | null) {
  return emailDate(value);
}

async function deliver(
  action: string,
  to: string,
  message: EmailContent,
  attachments?: EmailAttachment[],
) {
  if (!to) {
    return;
  }

  const result = await sendEmail({
    ...(attachments?.length ? { attachments } : {}),
    category: message.category,
    html: message.html,
    subject: message.subject,
    to,
  });

  if (!result.sent) {
    console.warn(
      JSON.stringify({ action: `${action}_email_failed`, level: "warn", reason: result.reason, to }),
    );
  }
}

/* ── Public: submitted, and now waiting ────────────────────────────────── */

/**
 * "We have your details; we will verify them."
 *
 * Only the public desk sends this. A team registration is already published by
 * the time anything is sent, so telling that owner to expect a review would be
 * describing a queue they are not in.
 */
export async function onRegistrationSubmitted(input: {
  hostelName: string;
  ownerEmail?: string;
  ownerName?: string;
}) {
  if (!input.ownerEmail) {
    return;
  }

  await deliver(
    "hostel_submission_received",
    input.ownerEmail,
    hostelSubmissionReceivedEmail({
      hostelName: input.hostelName,
      ownerName: input.ownerName,
    }),
  );
}

/* ── Team: registered and live in one step ─────────────────────────────── */

export async function onRegisteredByTeam(input: {
  agentName?: string;
  amountPaid: number;
  dueBy?: Date | null;
  free?: { freeMonths: number; freeUntil: Date } | null;
  setupFee?: number | null;
  hostelName: string;
  hostelSlug: string;
  outstanding: number;
  ownerEmail?: string;
  ownerName?: string;
  planName: string;
}) {
  if (!input.ownerEmail) {
    return;
  }

  await deliver(
    "hostel_registered_by_team",
    input.ownerEmail,
    hostelRegisteredByTeamEmail({
      agentName: input.agentName,
      amountPaid: input.amountPaid,
      billingUrl: hostelBillingUrl(input.hostelSlug),
      dueBy: formatEmailDate(input.dueBy),
      free: input.free
        ? { months: input.free.freeMonths, until: formatEmailDate(input.free.freeUntil) ?? "" }
        : null,
      hostelName: input.hostelName,
      listingUrl: hostelListingUrl(input.hostelSlug),
      outstanding: input.outstanding,
      ownerName: input.ownerName,
      planName: input.planName,
      setupFee: input.setupFee ?? null,
      supportPhone: (await getSiteConfigSection("identity")).supportPhone,
    }),
  );
}

/* ── Public: verification landed ───────────────────────────────────────── */

/**
 * "Your details are verified" — the email that turns *Pay now* on.
 *
 * Takes the plan they may have chosen during the wait, so the message can name
 * the single remaining step rather than sending them back to a chooser they
 * already used.
 */
export async function onHostelVerified(input: {
  /** A temporary password for an owner who had no way to sign in. */
  credentials?: { email: string; temporaryPassword: string } | null;
  /** Went live on free months at verification. */
  free?: { months: number; until: Date } | null;
  hostelName: string;
  ownerEmail?: string;
  ownerName?: string;
  /** A public registration that has not paid: the portal waits for the payment. */
  portalOpensOnPayment?: boolean;
  selectedPlanName?: string | null;
}) {
  if (!input.ownerEmail) {
    return;
  }

  await deliver(
    "hostel_verified",
    input.ownerEmail,
    hostelVerifiedEmail({
      credentials: input.credentials,
      free: input.free
        ? {
            months: input.free.months,
            supportPhone: (await getSiteConfigSection("identity")).supportPhone,
            until: emailDate(input.free.until) ?? "",
          }
        : null,
      hostelName: input.hostelName,
      ownerName: input.ownerName,
      portalOpensOnPayment: input.portalOpensOnPayment,
      selectedPlanName: input.selectedPlanName,
      statusUrl: registrationStatusUrl(),
    }),
  );
}

/* ── Platform: plan suspension started ─────────────────────────────────── */

/**
 * "Pay by this date, or the portal stops" — sent when a platform admin starts a
 * suspension from Listings, with the unpaid invoice attached.
 *
 * Unlike the other moments it reports what happened instead of only logging
 * it: the admin who pressed Suspend is looking at the result, and "the owner
 * was not emailed" is something they then have to do by phone.
 */
export async function onPlanSuspensionStarted(input: {
  amount: number;
  /** False when the invoice was raised a moment ago and its own email carried it. */
  attachInvoice: boolean;
  graceEndsAt: Date;
  hostelName: string;
  hostelSlug: string | null;
  invoiceNumber: string;
  ownerEmail: string;
  ownerName?: string;
  planName: string;
}): Promise<{ reason?: string; sent: boolean; to: string }> {
  if (!input.ownerEmail) {
    return { reason: "No owner email on file", sent: false, to: "" };
  }

  const attachments = input.attachInvoice
    ? await attach("invoice", input.invoiceNumber)
    : [];
  const message = planSuspensionNoticeEmail({
    amount: input.amount,
    hostelName: input.hostelName,
    invoiceAttached: attachments.length > 0,
    invoiceNumber: input.invoiceNumber,
    ownerName: input.ownerName,
    payBy: formatEmailDate(input.graceEndsAt) ?? "",
    payUrl: input.hostelSlug ? hostelBillingUrl(input.hostelSlug) : registrationStatusUrl(),
    planName: input.planName,
  });

  const result = await sendEmail({
    ...(attachments.length ? { attachments } : {}),
    category: message.category,
    html: message.html,
    subject: message.subject,
    to: input.ownerEmail,
  });

  if (!result.sent) {
    console.warn(
      JSON.stringify({
        action: "plan_suspension_notice_email_failed",
        level: "warn",
        reason: result.reason,
        to: input.ownerEmail,
      }),
    );
  }

  return {
    reason: result.sent ? undefined : String(result.reason ?? "unknown error"),
    sent: result.sent,
    to: input.ownerEmail,
  };
}

/* ── Both: invoice raised ──────────────────────────────────────────────── */

/**
 * The document itself, fetched so it can ride on the email.
 *
 * A billing email carries its paperwork. The alternative — a link back into the
 * portal — asks somebody to log in to see a document that was already addressed
 * to them, and it fails outright for the reader who forwards the mail to their
 * accountant, which is what actually happens to an invoice. The attachment is
 * the deliverable; the link beside it is a convenience.
 *
 * **Never throws, and never blocks the send.** A document that could not be
 * produced yields an email with the figures and the reference in it, which is
 * the message the template was written to carry on its own. Failing the email —
 * or worse, the invoice behind it — because a renderer had a bad day would turn
 * a cosmetic problem into a hostel that was never told it owes us money.
 */
export async function attach(
  kind: "invoice" | "receipt",
  number: string,
): Promise<EmailAttachment[]> {
  try {
    const document =
      kind === "invoice"
        ? await resolveInvoiceDocument(number, null)
        : await resolveReceiptDocument(number, null);

    if (!document) {
      return [];
    }

    return [{ content: document.bytes, filename: document.filename }];
  } catch (error) {
    console.warn(
      JSON.stringify({
        action: `subscription_${kind}_attachment_failed`,
        level: "warn",
        message: error instanceof Error ? error.message : "unknown",
        number,
      }),
    );

    return [];
  }
}

export async function onInvoiceIssued(input: {
  amount: number;
  cycleLabel: string;
  documentUrl?: string | null;
  dueAt?: Date | null;
  /** Published already — a renewal on a live hostel. */
  hostelLive: boolean;
  hostelName: string;
  hostelSlug?: string | null;
  invoiceNumber: string;
  ownerEmail?: string;
  ownerName?: string;
  planName: string;
  source: "PUBLIC" | "TEAM";
}) {
  if (!input.ownerEmail) {
    return;
  }

  const attachments = await attach("invoice", input.invoiceNumber);

  /*
   * Where the invoice is paid, and whether to ask for it.
   *
   * - A team registration's hostel has its own billing page from the moment it
   *   is filed, and the agent is collecting in person as this arrives — so it
   *   offers the page and does not ask for the money a second way.
   * - A live hostel renewing pays from its billing page.
   * - A self-registered hostel that is not published yet pays from its
   *   progress page, and paying is what publishes it.
   */
  const team = input.source === "TEAM";
  const billingUrl =
    input.hostelSlug && (team || input.hostelLive)
      ? hostelBillingUrl(input.hostelSlug)
      : null;

  await deliver(
    "subscription_invoice_issued",
    input.ownerEmail,
    subscriptionInvoiceEmail({
      action: {
        label: team ? "View billing" : "Pay now",
        url: billingUrl ?? registrationStatusUrl(),
      },
      amount: input.amount,
      attached: attachments.length > 0,
      cycleLabel: input.cycleLabel,
      documentUrl: input.documentUrl,
      dueAt: formatEmailDate(input.dueAt),
      goesLiveOnPayment: !team && !input.hostelLive,
      hostelName: input.hostelName,
      invoiceNumber: input.invoiceNumber,
      ownerName: input.ownerName,
      planName: input.planName,
    }),
    attachments,
  );
}

/* ── Both: money landed ────────────────────────────────────────────────── */

export async function onPaymentSettled(input: {
  amount: number;
  dueBy?: Date | null;
  hostelName: string;
  invoiceNumber: string;
  method: string;
  outstanding: number;
  ownerEmail?: string;
  planName: string;
  /** Softmato's transaction number when the payment went through them. */
  receiptNumber: string | null;
  /** Our own number for this payment. */
  receiptRef: string;
}) {
  /*
   * One payment, one email. Money that went through Softmato is receipted by
   * Softmato — their mail, their PDF, to the same address — so saying it again
   * here is the second email. Only money Softmato never saw is receipted here.
   */
  if (!input.ownerEmail || input.receiptNumber) {
    return;
  }

  const attachments = [
    ...(await attach("receipt", input.receiptRef)),
    ...(await attach("invoice", input.invoiceNumber)),
  ];

  await deliver(
    "subscription_receipt",
    input.ownerEmail,
    subscriptionReceiptEmail({
      amount: input.amount,
      attached: attachments.length > 0,
      dueBy: formatEmailDate(input.dueBy),
      hostelName: input.hostelName,
      invoiceNumber: input.invoiceNumber,
      method: input.method,
      outstanding: input.outstanding,
      planName: input.planName,
    }),
    attachments,
  );
}
