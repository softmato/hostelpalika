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

export interface BillingInvoiceRow {
  amount: number;
  currency: string;
  /**
   * Our own authenticated download route.
   *
   * No longer nullable. It used to be, because a document existed only once
   * Softmato had raised one — an invoice recorded here with no paper anywhere
   * was a real state, and a download button for it would have produced nothing.
   * That is no longer true: when they cannot be reached we issue the document
   * ourselves, so every invoice has one, and the route resolves whichever
   * exists.
   */
  documentUrl: string;
  dueAt: string | null;
  invoiceNumber: string;
  issuedAt: string | null;
  outstanding: number;
  paid: number;
  planName: string;
  cycleLabel: string;
  /** What is printed on the page the owner holds, whoever issued it. */
  printedNumber: string;
  /** `INV-2083/84-000010`, once raised. */
  softmatoInvoiceNo: string | null;
  /** Who produced the document. Shown plainly rather than hidden. */
  issuedBy: "softmato" | "platform";
  status: string;
}

export interface BillingPaymentRow {
  amount: number;
  documentUrl: string | null;
  /** `CASH` rows are our own record and carry no Softmato document. */
  method: string;
  paidAt: string | null;
  /** `eSewa`, `Khalti` — absent on cash. */
  provider: string | null;
  providerRef: string | null;
  /** What is printed on the receipt the owner holds, whoever issued it. */
  printedNumber: string | null;
  receiptNumber: string | null;
  softmatoTransactionNo: string | null;
  status: string;
}

/**
 * The plan itself — what is running, and how long is left on it.
 *
 * `daysRemaining` is computed here rather than on each client for the reason
 * every derived figure in this codebase is: the website and the app would
 * otherwise each own a copy of "how many days is that", and the two would round
 * a part-day differently on the one screen where an owner is deciding whether
 * to renew today or tomorrow.
 *
 * ## Counted in Nepal days, so it moves once, at midnight
 *
 * Every figure here is a count of **calendar days in Kathmandu**, never of
 * elapsed milliseconds. The first cut floored milliseconds, so a count moved at
 * whatever minute the period happened to end — "3 days left" at breakfast,
 * "2" by lunch, on the same day. Counted between days, it changes at midnight
 * in Nepal and nowhere else, and a client that re-asks when the day turns is
 * right all day.
 *
 * `daysRemaining` counts **today in**: 31 on the first day of a 31-day month,
 * 1 on its last, 0 once it has run out — a real state, not an error.
 * `daysToDue` counts **to** the day: 3 on Bhadra 26 for a due on Bhadra 29, and
 * 0 on Bhadra 29 itself, which the screens word as the last day to pay.
 */
export interface BillingPlan {
  /**
   * When the stretch now running began. For a team-filed hostel that is the
   * day it was filed — it is live before it has paid — and for a public one
   * the day it paid.
   */
  activatedAt: string | null;
  /** Still owed on the invoice being paid. `0` when nothing is open. */
  amountDue: number;
  /** Settled so far against that same invoice. */
  amountPaid: number;
  /** `monthly` / `halfYearly` / `annual` — what "Pay for this plan" renews at. */
  cycle: string | null;
  cycleLabel: string | null;
  cycleMonths: number | null;
  /**
   * The last instant the plan covers — the end of a Nepal day. Null until the
   * plan starts, which is not the same as until it is paid: a team hostel's
   * runs while its balance is still owed.
   */
  currentPeriodEnd: string | null;
  /** Days left on the plan, today included. Null when no period is running, and on a lifetime plan. */
  daysRemaining: number | null;
  /** Days until the day in `dueBy`; 0 on that day. */
  daysToDue: number | null;
  /**
   * The deadline on a shortfall. The subscription's own when a team
   * registration carries one, otherwise the open invoice's — both are counted
   * from the day the invoice was raised and neither moves on a part payment.
   */
  dueBy: string | null;
  /** When the window to pay opened: the open invoice's issue. */
  dueFrom: string | null;
  /**
   * How many days the running stretch spans, both ends included — what
   * `daysRemaining` is a share of. Sent rather than left for the client to
   * derive so the bar and the count under it move on the same midnight.
   */
  periodDays: number | null;
  /**
   * Paid for life (the lifetime deal). `currentPeriodEnd`, `daysRemaining` and
   * `periodDays` are null on it: a screen says "Lifetime", never a date.
   */
  lifetime: boolean;
  /** The catalogue id — what a client ranks the plan's mark by. */
  planId: string | null;
  planName: string | null;
  price: number | null;
  status: string;
}

export interface BillingHistory {
  /** The integration guide Softmato hosts. Null when unconfigured. */
  docsUrl: string | null;
  invoices: BillingInvoiceRow[];
  payments: BillingPaymentRow[];
  /** Null for a hostel that predates plan billing and has no subscription. */
  plan: BillingPlan | null;
}

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
