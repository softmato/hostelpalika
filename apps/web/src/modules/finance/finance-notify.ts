import type { Types } from "mongoose";

import {
  appUrl,
  getHostelName,
  resolveHostelAdminContacts,
  resolveResidentContact,
  sendNotificationEmail,
} from "@/modules/residents/resident-notify";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { getOperationsConfig } from "@/modules/platform-config/operations-config";
import { renderReceiptById } from "@/modules/finance/receipt.service";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { PaymentEventModel } from "@hostel/db/models/PaymentEvent";
import { ReceiptModel } from "@hostel/db/models/Receipt";
import { ResidentModel } from "@hostel/db/models/Resident";
import type { EmailAttachment } from "@hostel/shared/email/sender";
import {
  type PaymentLine,
  paymentSummaryEmail,
} from "@hostel/shared/email/templates/hostel/staff-alerts";
import { gatewayUnhealthyEmail } from "@hostel/shared/email/templates/payment/gateway-unhealthy";
import { paymentRejectedEmail } from "@hostel/shared/email/templates/payment/payment-rejected";
import { paymentReversedEmail } from "@hostel/shared/email/templates/payment/payment-reversed";
import { paymentVerifiedEmail } from "@hostel/shared/email/templates/payment/payment-verified";

/**
 * Tell the hostel's admins a claim is waiting (target §11.4, plan item 2.8).
 *
 * **Never throws.** The claim is already recorded by the time this runs, and a
 * failed notification must not fail the resident's submission — they did their
 * part, and the queue is still correct without the email.
 */
export async function notifyAdminsOfClaim(input: {
  amount: number;
  eventId: string;
  /** The invoice's own matching code — not anything the resident typed. */
  invoiceReference?: string | null;
  method: string;
  period: string | null;
  referenceNote: string | null;
  resident: { firstName?: string; hostelId: Types.ObjectId; lastName?: string };
  /** What the resident typed into the transaction-id field. Unverified. */
  transactionCode?: string | null;
}): Promise<void> {
  try {
    // Bell and push only. The email is the morning digest
    // (`sendAdminPaymentDigest`) — one per claim was dozens a day at month start.
    const admins = await resolveHostelAdminContacts(input.resident.hostelId);

    const residentName =
      `${input.resident.firstName ?? ""} ${input.resident.lastName ?? ""}`.trim();

    await Promise.all(
      admins.map(async (admin) => {
        if (admin.userId) {
          await createInAppNotification({
            // Approving is a one-click decision, so it happens in the bell.
            // Rejecting needs a written reason, so that one only deep-links.
            actions: [
              {
                endpoint: `/api/v1/hostel-admin/finance/events/${input.eventId}/approve`,
                key: "approve",
                label: "Verify payment",
                method: "POST",
              },
            ],
            // Clicking the row opens the review queue; the button decides in place.
            actionUrl: "/hostel-admin/payments",
            body: `${residentName} submitted proof of NPR ${input.amount.toLocaleString("en-US")}${
              input.period ? ` for ${input.period}` : ""
            }.`,
            category: "PAYMENT",
            data: { eventId: input.eventId },
            hostelId: input.resident.hostelId.toString(),
            title: "Payment proof submitted",
            userId: admin.userId.toString(),
          });
        }
      }),
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        action: "payment_claim_notification_failed",
        eventId: input.eventId,
        level: "warn",
        message: error instanceof Error ? error.message : "Unknown notification error",
      }),
    );
  }
}

/**
 * Tell the **resident** we have their proof (target §11.2).
 *
 * The counterpart to {@link notifyAdminsOfClaim}, and it did not exist: a claim
 * mailed the hostel and left the person who submitted it with a spinner and no
 * confirmation of any kind. A resident whose transfer has already left their bank
 * and who then hears nothing for two days assumes the upload failed and either
 * pays twice or calls — and the second claim is refused as a duplicate, which
 * reads to them as the system losing their money.
 *
 * **Never throws.** The claim is recorded before this runs. A mail server having
 * a bad day must not turn a successful submission into an error the resident
 * sees, because the retry they would then make is the duplicate above.
 */
export async function notifyResidentOfClaim(input: {
  amount: number;
  hostelId: Types.ObjectId | string;
  invoiceId: string | null;
  period: string | null;
  /** False when the share sheet already showed the notice on the phone. */
  push?: boolean;
  /** The invoice's own code — not the transaction id the resident typed. */
  referenceCode: string | null;
  residentId: Types.ObjectId | string;
}): Promise<void> {
  try {
    const resident = await ResidentModel.findOne({
      _id: input.residentId,
      isDeleted: false,
    }).lean<{ userId?: Types.ObjectId } | null>();

    if (!resident) {
      return;
    }

    // Bell only. The resident is signed in when they upload, so the row lands on
    // the screen they are looking at; an email saying the same thing, followed
    // by the "verified" email, was two messages for one payment.
    if (resident.userId) {
      await createInAppNotification({
        // The row is informational — `kind: "NORMAL"` keeps it out of the
        // "Needs action" queue — but it still opens the ledger it is about.
        actionUrl: "/resident/payments",
        // "Sent for checking", never "received" on its own: the resident's
        // question is whether the money counted yet, and it has not.
        body: `Your proof of NPR ${input.amount.toLocaleString("en-US")}${
          input.period ? ` for ${input.period}` : ""
        } was sent to your hostel to check. Nothing is credited until they verify it.`,
        category: "PAYMENT",
        data: { invoiceId: input.invoiceId ?? undefined },
        hostelId: input.hostelId.toString(),
        kind: "NORMAL",
        push: input.push ?? true,
        title: "Payment proof sent",
        userId: resident.userId.toString(),
      });
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        action: "payment_proof_received_notification_failed",
        level: "warn",
        message: error instanceof Error ? error.message : "Unknown notification error",
        residentId: input.residentId.toString(),
      }),
    );
  }
}

/**
 * Tell the hostel's admins their online checkout is not working (item 6.7).
 *
 * **Outside the `sendPaymentEmails` switch, in-app.** A hostel that turned
 * payment emails off would otherwise be the hostel least likely to find out its
 * payment button has been broken for a week, which inverts the point of the
 * setting: it exists to reduce routine receipts, not to suppress the one message
 * that says money is not arriving.
 *
 * No action button. There is nothing to click that fixes a merchant credential
 * at the bank — the useful thing is the sentence, and a link to the screen where
 * the details live.
 *
 * **Never throws.** It is called from a scheduled job that has other hostels to
 * get to.
 */
export async function notifyGatewayUnhealthy(input: {
  detail: string;
  hostelId: Types.ObjectId | string;
  provider: string;
  status: string;
}): Promise<void> {
  try {
    const [hostelName, admins] = await Promise.all([
      getHostelName(input.hostelId),
      resolveHostelAdminContacts(input.hostelId),
    ]);
    const providerName =
      input.provider.charAt(0) + input.provider.slice(1).toLowerCase();
    const title =
      input.status === "FAILING"
        ? `${providerName} payments are not going through`
        : `${providerName} payments are having trouble`;

    const email = gatewayUnhealthyEmail({
      detail: input.detail,
      hostelName,
      providerName,
      setupUrl: appUrl("/hostel-admin/payment-gateways"),
      title,
    });

    await Promise.all(
      admins.map(async (admin) => {
        if (admin.userId) {
          await createInAppNotification({
            body: input.detail,
            category: "PAYMENT",
            data: { provider: input.provider, status: input.status },
            hostelId: input.hostelId.toString(),
            title,
            userId: admin.userId.toString(),
          });
        }

        await sendNotificationEmail({
          action: "gateway_unhealthy",
          html: email.html,
          subject: email.subject,
          to: admin.email,
        });
      }),
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        action: "gateway_health_notification_failed",
        level: "warn",
        message: error instanceof Error ? error.message : "Unknown notification error",
        provider: input.provider,
      }),
    );
  }
}

/**
 * Tell the resident what happened to their claim (target §11.4).
 *
 * Also the "verified" email for an eSewa/Khalti checkout, where the provider
 * verified the payment instead of a warden — one email for one fact.
 *
 * Same shape as the reversal notice below and for the same reason: the in-app
 * message is outside the email switch. A hostel with email off used to verify a
 * payment and tell the resident nothing at all (item 0.6).
 */
export async function notifyClaimReviewed(input: {
  hostelId: Types.ObjectId | string;
  invoiceId: string | null;
  outcome:
    | {
        kind: "verified";
        /** Set when the receipt went into the Resident Offer Program. */
        certificationCode?: string | null;
        /** How the money arrived, for the owner's confirmation. */
        method?: string;
        /**
         * The receipt document, so it can be rendered and attached. Separate
         * from `receiptNumber` because the number is what both emails *say* and
         * the id is what the PDF is built from — a receipt can exist with one
         * and not usefully with the other.
         */
        receiptId?: Types.ObjectId | string | null;
        receiptNumber: string | null;
        remainingAmount: number;
        verifiedAmount: number;
      }
    | { kind: "rejected"; rejectionReason: string };
  period: string | null;
  residentId: Types.ObjectId | string;
}): Promise<void> {
  const resident = await ResidentModel.findOne({
    _id: input.residentId,
    isDeleted: false,
  }).lean<{
    _id: Types.ObjectId;
    email?: string;
    firstName: string;
    lastName: string;
    userId?: Types.ObjectId;
  } | null>();

  if (!resident) {
    return;
  }

  const [config, hostelName, contact] = await Promise.all([
    getOperationsConfig(),
    getHostelName(input.hostelId),
    resolveResidentContact(resident),
  ]);

  const period = input.period ?? "your account";

  if (resident.userId) {
    await createInAppNotification({
      actionUrl: "/resident/payments",
      body:
        input.outcome.kind === "verified"
          ? `Your payment for ${period} is verified.${
              input.outcome.certificationCode
                ? " Your receipt was added to the Resident Offer Program."
                : input.outcome.receiptNumber
                  ? ` Receipt ${input.outcome.receiptNumber}.`
                  : ""
            }`
          : `Your payment proof for ${period} was not accepted: ${input.outcome.rejectionReason}`,
      category: "PAYMENT",
      data: { invoiceId: input.invoiceId ?? undefined },
      hostelId: input.hostelId.toString(),
      kind: "NORMAL",
      title:
        input.outcome.kind === "verified" ? "Payment verified" : "Payment proof rejected",
      userId: resident.userId.toString(),
    });
  }

  if (!contact || !config.sendPaymentEmails) {
    return;
  }

  const email =
    input.outcome.kind === "verified"
      ? paymentVerifiedEmail({
          amount: input.outcome.verifiedAmount,
          certificationCode: input.outcome.certificationCode ?? null,
          hostelName,
          month: input.period ?? "",
          offerProgramUrl: appUrl("/resident/offer-program"),
          paymentsUrl: appUrl("/resident/payments"),
          receiptNumber: input.outcome.receiptNumber ?? "",
          remainingAmount: input.outcome.remainingAmount,
          residentName: contact.name ?? resident.firstName,
        })
      : paymentRejectedEmail({
          hostelName,
          month: input.period ?? "",
          paymentsUrl: appUrl("/resident/payments"),
          rejectionReason: input.outcome.rejectionReason,
          residentName: contact.name ?? resident.firstName,
        });

  // The receipt travels with the mail (target §4.4). A resident who needs proof
  // of rent for a visa, a loan or a landlord otherwise has to log in, find the
  // row and download it — and the one moment they are certainly reading is this
  // email. A render that fails costs the attachment, never the notification.
  const attachments =
    input.outcome.kind === "verified" && input.outcome.receiptId
      ? await receiptAttachment(input.outcome.receiptId)
      : [];

  await sendNotificationEmail({
    action: `payment_${input.outcome.kind}`,
    attachments,
    html: email.html,
    subject: email.subject,
    to: contact.email,
  });
}

/** The receipt PDF, or nothing at all if it cannot be rendered. */
async function receiptAttachment(
  receiptId: Types.ObjectId | string,
): Promise<EmailAttachment[]> {
  try {
    const { bytes, receiptNumber } = await renderReceiptById(receiptId, {});

    return [{ content: bytes, filename: `${receiptNumber}.pdf` }];
  } catch (error) {
    console.warn(
      JSON.stringify({
        action: "payment_receipt_attachment_failed",
        level: "warn",
        message: error instanceof Error ? error.message : "Unknown receipt error",
        receiptId: receiptId.toString(),
      }),
    );

    return [];
  }
}

/**
 * The morning payments email to each hostel's admins: proofs still waiting to
 * be verified, and money that cleared in the last day.
 *
 * It replaces an email per claim and an email per cleared payment, which at the
 * start of a month was dozens a day to the same owner. The bell and push still
 * fire per claim as it arrives; this is the inbox's one summary. A hostel with
 * nothing in either line gets nothing.
 *
 * Runs on the `payment-reminders` cron (07:45 Nepal). **Never throws.**
 */
export async function sendAdminPaymentDigest(now = new Date()) {
  let hostels = 0;

  try {
    const config = await getOperationsConfig();

    if (!config.sendPaymentEmails) {
      return { hostels };
    }

    type Row = {
      amount: number;
      hostelId: Types.ObjectId;
      invoiceId?: Types.ObjectId | null;
      month?: string | null;
      residentId?: Types.ObjectId | null;
    };
    const since = new Date(now.getTime() - 86_400_000);
    // ponytail: platform-wide reads; add `{ source, status }` / `{ issuedAt }` indexes if these grow.
    const [waiting, received] = await Promise.all([
      PaymentEventModel.find({ source: "RESIDENT_CLAIM", status: "PENDING" })
        .select("amount hostelId invoiceId residentId")
        .lean<Row[]>(),
      ReceiptModel.find({ issuedAt: { $gte: since, $lt: now }, voidedAt: null })
        .select("amount hostelId month residentId")
        .lean<Row[]>(),
    ]);

    if (waiting.length + received.length === 0) {
      return { hostels };
    }

    const [residents, invoices] = await Promise.all([
      ResidentModel.find({
        _id: { $in: [...waiting, ...received].map((row) => row.residentId).filter(Boolean) },
      })
        .select("firstName lastName")
        .lean<{ _id: Types.ObjectId; firstName?: string; lastName?: string }[]>(),
      InvoiceModel.find({ _id: { $in: waiting.map((row) => row.invoiceId).filter(Boolean) } })
        .select("period")
        .lean<{ _id: Types.ObjectId; period?: string | null }[]>(),
    ]);
    const names = new Map(
      residents.map((resident) => [
        resident._id.toString(),
        `${resident.firstName ?? ""} ${resident.lastName ?? ""}`.trim(),
      ]),
    );
    const periods = new Map(invoices.map((invoice) => [invoice._id.toString(), invoice.period]));
    const byHostel = new Map<string, { received: PaymentLine[]; waiting: PaymentLine[] }>();
    const lists = (hostelId: Types.ObjectId) => {
      const key = hostelId.toString();

      if (!byHostel.has(key)) {
        byHostel.set(key, { received: [], waiting: [] });
      }

      return byHostel.get(key)!;
    };
    const line = (row: Row, month?: string | null): PaymentLine => ({
      amount: row.amount,
      month,
      name: names.get(String(row.residentId)) || "Resident",
    });

    for (const row of waiting) {
      lists(row.hostelId).waiting.push(line(row, periods.get(String(row.invoiceId))));
    }

    for (const row of received) {
      lists(row.hostelId).received.push(line(row, row.month));
    }

    await Promise.all(
      [...byHostel].map(async ([hostelId, tally]) => {
        const [hostelName, admins] = await Promise.all([
          getHostelName(hostelId),
          resolveHostelAdminContacts(hostelId),
        ]);
        const email = paymentSummaryEmail({
          ...tally,
          hostelName,
          paymentsUrl: appUrl("/hostel-admin/payments"),
        });

        await Promise.all(
          admins.map((admin) =>
            sendNotificationEmail({
              action: "payment_digest",
              html: email.html,
              subject: email.subject,
              to: admin.email,
              topic: "PAYMENT_SUMMARY",
            }),
          ),
        );
        hostels += 1;
      }),
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        action: "payment_digest_failed",
        level: "warn",
        message: error instanceof Error ? error.message : "Unknown notification error",
      }),
    );
  }

  return { hostels };
}

/**
 * Telling a resident their money stopped counting (target §9.3, plan item 2.7).
 *
 * A reversal that nobody is told about is discovered from a dunning notice, and
 * the hostel discovers it from an angry phone call. It is the single most
 * important notification in the finance module and the current system does not
 * send it at all, because reversals happen through the unrestricted `PATCH`.
 *
 * **The in-app notification always fires.** `sendPaymentEmails` is an *email*
 * switch (§5.5, target §12) — the bug item 0.6 fixed was exactly this early
 * return taking the in-app message down with it, so a hostel with email off
 * changed a resident's balance and told them nothing.
 */
export async function notifyPaymentReversed(input: {
  amount: number;
  hostelId: Types.ObjectId | string;
  invoiceId?: string | null;
  outstandingAmount: number;
  period?: string | null;
  reason: string;
  residentId: Types.ObjectId | string;
}): Promise<void> {
  const resident = await ResidentModel.findOne({
    _id: input.residentId,
    isDeleted: false,
  }).lean<{
    _id: Types.ObjectId;
    email?: string;
    firstName: string;
    hostelId: Types.ObjectId;
    lastName: string;
    userId?: Types.ObjectId;
  } | null>();

  if (!resident) {
    return;
  }

  const [config, hostelName, contact] = await Promise.all([
    getOperationsConfig(),
    getHostelName(input.hostelId),
    resolveResidentContact(resident),
  ]);

  if (resident.userId) {
    await createInAppNotification({
      actionUrl: "/resident/payments",
      body: `A payment of NPR ${input.amount.toLocaleString("en-US")} was reversed: ${input.reason}`,
      category: "PAYMENT",
      data: { invoiceId: input.invoiceId ?? undefined },
      hostelId: input.hostelId.toString(),
      kind: "NORMAL",
      title: "Payment reversed",
      userId: resident.userId.toString(),
    });
  }

  if (contact && config.sendPaymentEmails) {
    const email = paymentReversedEmail({
      amount: input.amount,
      hostelName,
      outstandingAmount: input.outstandingAmount,
      paymentsUrl: appUrl("/resident/payments"),
      period: input.period ?? null,
      reason: input.reason,
      residentName: contact.name ?? resident.firstName ?? "there",
    });

    await sendNotificationEmail({
      action: "payment_reversed",
      html: email.html,
      subject: email.subject,
      to: contact.email,
    });
  }
}
