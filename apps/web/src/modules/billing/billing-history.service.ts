import "server-only";

import { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { billingHostelId } from "@/modules/billing/billing-hostel";
import {
  documentDownloadUrl,
  fetchInvoiceDetail,
  softmatoDocsUrl,
} from "@/modules/billing/billing-gateway";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { SubscriptionInvoiceModel } from "@hostel/db/models/SubscriptionInvoice";
import {
  EXCLUDE_CHECKOUT_ATTEMPTS,
  SubscriptionPaymentModel,
} from "@hostel/db/models/SubscriptionPayment";
import { hostelDaysBetween } from "@hostel/shared/calendar/bs";
import { monthsLabel } from "@hostel/shared/plans/catalog";
import type { BillingInvoiceRow, BillingPaymentRow, BillingPlan, BillingHistory } from "@/lib/billing/billing.types";
export type { BillingInvoiceRow, BillingPaymentRow, BillingPlan, BillingHistory } from "@/lib/billing/billing.types";

/**
 * Everything a hostel's own billing screen shows: what was billed, what was
 * paid, and where each document lives.
 *
 * ## Built from our rows, enriched from theirs
 *
 * The list, the ordering and the balances come from this database, because
 * they have to work when Softmato is unreachable and because a hostel's
 * billing screen should not depend on a third party being up. What comes from
 * Softmato is the *contents* of one document, fetched only when the reader
 * opens it — the line items, both parties, the plan copy we sent, and the
 * totals as their ledger has them.
 *
 * That split is also why `presentation` is worth reading back rather than
 * re-deriving locally: it is the plan description exactly as it was printed on
 * the invoice, so this screen and that document say the same thing without a
 * second copy to keep in sync. A plan renamed or repriced next month does not
 * rewrite what an owner already bought.
 *
 * ## Two numbers per document, both shown
 *
 * Ours is the one our emails quote and the one support will be asked about.
 * Theirs is the one on the PDF, carrying the fiscal year and the ledger
 * sequence, and is what an accountant will want. Showing only one of them
 * guarantees the owner is holding the other.
 */





/** Nepal days from today to the day `end` falls on: 0 on that day and after. */
export function daysUntil(end: Date | null | undefined, now = new Date()) {
  if (!end) return null;

  return end.getTime() <= now.getTime() ? 0 : Math.max(0, hostelDaysBetween(now, end));
}

/** Nepal days left through the day `end` falls on, today included; 0 once past. */
export function daysLeftThrough(end: Date | null | undefined, now = new Date()) {
  if (!end) return null;

  return end.getTime() <= now.getTime() ? 0 : hostelDaysBetween(now, end) + 1;
}

/** Nepal days from `start`'s day through `end`'s, both included. */
export function daysSpanned(
  start: Date | null | undefined,
  end: Date | null | undefined,
) {
  if (!start || !end) return null;

  return Math.max(1, hostelDaysBetween(start, end) + 1);
}

const CYCLE_LABELS = {
  annual: "Annual",
  halfYearly: "6 months",
  monthly: "Monthly",
};

/** By the months actually bought — a 7-month invoice is "7 months", not its rate tier. */
function cycleLabel(cycle: string, months?: number | null) {
  return months
    ? monthsLabel({ cycleLabels: CYCLE_LABELS }, months)
    : (CYCLE_LABELS[cycle as keyof typeof CYCLE_LABELS] ?? cycle);
}

export async function getBillingHistory(
  hostelId: string,
): Promise<BillingHistory> {
  await connectToDatabase();

  // A branch is billed with its main hostel, so its history is that one's.
  const id = await billingHostelId(hostelId);

  const [subscription, invoices, payments] = await Promise.all([
    HostelSubscriptionModel.findOne({ hostelId: id }).lean<{
      activatedAt?: Date | null;
      cycle?: string | null;
      cycleMonths?: number | null;
      currentPeriodEnd?: Date | null;
      cycleTotal?: number | null;
      dueBy?: Date | null;
      lifetimeSince?: Date | null;
      planId?: string | null;
      planName?: string | null;
      status: string;
      trialEndsAt?: Date | null;
    } | null>(),
    SubscriptionInvoiceModel.find({ hostelId: id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean<
        Array<{
          _id: Types.ObjectId;
          amount: number;
          currency?: string;
          cycle: string;
          cycleMonths?: number | null;
          documentUrl?: string | null;
          dueAt?: Date | null;
          invoiceNumber: string;
          issuedAt?: Date | null;
          lifetime?: boolean;
          localInvoiceNo?: string | null;
          planId?: string | null;
          planName: string;
          softmatoInvoiceNo?: string | null;
          status: string;
        }>
      >(),
    SubscriptionPaymentModel.find({ hostelId: id, ...EXCLUDE_CHECKOUT_ATTEMPTS })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean<
        Array<{
          amount: number;
          gatewayReference?: string | null;
          method: string;
          receiptDocumentUrl?: string | null;
          localTransactionNo?: string | null;
          receiptNumber?: string | null;
          settledAt?: Date | null;
          softmatoProvider?: string | null;
          softmatoTransactionNo?: string | null;
          status: string;
        }>
      >(),
  ]);

  /*
   * Paid-per-invoice in one aggregate rather than a query per row. Only
   * `SETTLED` counts, for the same reason it does everywhere else: a pending
   * attempt is a promise being waited on, and letting one reduce a balance
   * would show an owner a debt they have not actually cleared.
   */
  const settled = await SubscriptionPaymentModel.aggregate<{
    _id: Types.ObjectId;
    total: number;
  }>([
    { $match: { hostelId: id, status: "SETTLED" } },
    { $group: { _id: "$invoiceId", total: { $sum: "$amount" } } },
  ]);

  const paidByInvoice = new Map(
    settled.map((row) => [String(row._id), row.total]),
  );

  /*
   * The invoice still being paid, and where it stands. What the owner reads as
   * "paid so far" and "left to pay" is this one invoice — never a sum across
   * the history, which would fold a settled year into this year's balance.
   */
  const open =
    invoices.find(
      (invoice) => invoice.status === "OPEN" || invoice.status === "PARTIAL",
    ) ?? null;
  const openPaid = open ? (paidByInvoice.get(String(open._id)) ?? 0) : 0;
  const openDue = open ? Math.max(0, open.amount - openPaid) : 0;
  const dueBy =
    subscription?.dueBy ?? (openDue > 0 ? (open?.dueAt ?? null) : null);
  // One clock for every count in the payload, so none of them can straddle a
  // midnight the others did not.
  const now = new Date();
  const lifetime = Boolean(subscription?.lifetimeSince);
  // The lifetime sentinel is a database convenience; nothing counts down to it.
  const periodEnd = lifetime ? null : (subscription?.currentPeriodEnd ?? null);

  return {
    docsUrl: softmatoDocsUrl(),
    invoices: invoices.map((invoice) => {
      const paid = paidByInvoice.get(String(invoice._id)) ?? 0;

      return {
        amount: invoice.amount,
        currency: invoice.currency ?? "NPR",
        cycleLabel: invoice.lifetime ? "Lifetime" : cycleLabel(invoice.cycle, invoice.cycleMonths),
        /*
         * Built rather than read from the row. `documentUrl` is written when an
         * invoice is raised, so the rows that predate the local renderer carry a
         * null — and every one of those now has a document that this route can
         * produce. Deriving it means the button appears for them too.
         */
        documentUrl: documentDownloadUrl("invoice", invoice.invoiceNumber),
        dueAt: invoice.dueAt?.toISOString() ?? null,
        invoiceNumber: invoice.invoiceNumber,
        issuedAt: invoice.issuedAt?.toISOString() ?? null,
        issuedBy: invoice.softmatoInvoiceNo ? "softmato" : "platform",
        outstanding:
          invoice.status === "VOID" ? 0 : Math.max(0, invoice.amount - paid),
        paid,
        planId: invoice.planId ?? null,
        planName: invoice.planName,
        printedNumber:
          invoice.softmatoInvoiceNo ??
          invoice.localInvoiceNo ??
          invoice.invoiceNumber,
        softmatoInvoiceNo: invoice.softmatoInvoiceNo ?? null,
        status: invoice.status,
      };
    }),
    payments: payments.map((payment) => {
      const printed =
        payment.softmatoTransactionNo ??
        payment.localTransactionNo ??
        payment.receiptNumber ??
        null;

      return {
        amount: payment.amount,
        /*
         * Only a settled payment has a receipt. A pending or failed row is a
         * promise that has not been kept, and a download button on one would
         * offer a document asserting money arrived when it has not.
         */
        documentUrl:
          payment.status === "SETTLED" && printed
            ? documentDownloadUrl("receipt", printed)
            : null,
        method: payment.method,
        paidAt: payment.settledAt?.toISOString() ?? null,
        printedNumber: printed,
        provider: payment.softmatoProvider ?? null,
        providerRef: payment.gatewayReference ?? null,
        receiptNumber: payment.receiptNumber ?? null,
        softmatoTransactionNo: payment.softmatoTransactionNo ?? null,
        status: payment.status,
      };
    }),
    plan: subscription
      ? {
          activatedAt: subscription.activatedAt?.toISOString() ?? null,
          amountDue: openDue,
          amountPaid: openPaid,
          cycle: subscription.cycle ?? null,
          cycleMonths: subscription.cycleMonths ?? null,
          cycleLabel: lifetime
            ? "Lifetime"
            : subscription.cycle
              ? cycleLabel(subscription.cycle, subscription.cycleMonths)
              : null,
          currentPeriodEnd: periodEnd?.toISOString() ?? null,
          daysRemaining: daysLeftThrough(periodEnd, now),
          daysToDue: daysUntil(dueBy, now),
          dueBy: dueBy?.toISOString() ?? null,
          dueFrom: dueBy ? (open?.issuedAt?.toISOString() ?? null) : null,
          lifetime,
          periodDays: daysSpanned(subscription.activatedAt, periodEnd),
          planId: subscription.planId ?? null,
          planName: subscription.planName ?? null,
          price: subscription.cycleTotal ?? null,
          status: subscription.status,
          trialEndsAt:
            subscription.trialEndsAt && !subscription.planId ? subscription.trialEndsAt.toISOString() : null,
        }
      : null,
  };
}

/**
 * One invoice in full, as Softmato has it.
 *
 * Scoped by hostel before a single field crosses the wire: the caller passes
 * the hostel they are authorised for, and an invoice belonging to another one
 * is answered `null` rather than fetched. Softmato would refuse an invoice
 * belonging to another *application*, but every hostel on this platform shares
 * one credential — so tenancy is ours to enforce, and this is where.
 */
export async function getInvoiceDetailForHostel(
  hostelId: string,
  invoiceNumber: string,
) {
  await connectToDatabase();

  const invoice = await SubscriptionInvoiceModel.findOne({
    hostelId: new Types.ObjectId(hostelId),
    invoiceNumber,
  }).lean<{ softmatoInvoiceNo?: string | null } | null>();

  if (!invoice?.softmatoInvoiceNo) return null;

  return fetchInvoiceDetail(invoice.softmatoInvoiceNo);
}
