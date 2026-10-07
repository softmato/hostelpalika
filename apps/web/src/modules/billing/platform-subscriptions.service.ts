import "server-only";

import { Types } from "mongoose";

import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { SubscriptionInvoiceModel } from "@hostel/db/models/SubscriptionInvoice";
import {
  EXCLUDE_CHECKOUT_ATTEMPTS,
  SubscriptionPaymentModel,
} from "@hostel/db/models/SubscriptionPayment";

import { connectToDatabase } from "@/lib/db";
import { siteUrl } from "@/lib/site";

/**
 * Every plan invoice and every plan payment on the platform, in one ledger.
 *
 * ## Why this is not `/platform/payments`
 *
 * That screen is *residents paying hostels* — rent, aggregated across every
 * property, with proofs to approve. This is *hostels paying us*. The two are
 * one level apart in the same product and share not a single row: different
 * models, different merchant of record, different person chasing them. Reading
 * them on one screen would mean one of the two totals is answering a question
 * nobody asked, and the reader would have to know which.
 *
 * ## Built from our rows, always
 *
 * Nothing here calls Softmato. The list, the ordering, the totals and the
 * outstanding balances come from this database so that the platform's own view
 * of what it is owed cannot go dark because a third party did — which is
 * exactly the situation these screens were built during. The documents behind
 * each row are fetched only when somebody opens one.
 *
 * ## Both numbers on every row
 *
 * A row shows the number that is *printed* on the document a hostel holds —
 * Softmato's when they raised it, ours when we did — beside our own internal
 * reference. Support is asked about whichever one the caller is reading off
 * their copy, and showing one of the two guarantees they are holding the other.
 */

export type PlatformInvoiceRow = {
  amount: number;
  currency: string;
  cycle: string;
  /** Our authenticated download route. Always present — a document always exists. */
  documentUrl: string;
  dueAt: string | null;
  hostelId: string;
  hostelName: string;
  /** Our internal reference. `SUB-0001-4F2A`. */
  invoiceNumber: string;
  issuedAt: string | null;
  outstanding: number;
  paid: number;
  planName: string;
  /** What is printed on the page the hostel holds. */
  printedNumber: string;
  /** Who printed it. The platform's own honest view of the outage. */
  issuedBy: "softmato" | "platform";
  source: string;
  status: string;
};

export type PlatformPaymentRow = {
  amount: number;
  currency: string;
  documentUrl: string | null;
  hostelId: string;
  hostelName: string;
  invoiceNumber: string;
  method: string;
  paidAt: string | null;
  printedNumber: string | null;
  provider: string | null;
  receiptNumber: string | null;
  status: string;
};

export type PlatformSubscriptionLedger = {
  invoices: PlatformInvoiceRow[];
  payments: PlatformPaymentRow[];
  totals: {
    /** Hostels whose paid period has not yet run out. */
    activePlans: number;
    /** Raised, ever. */
    billed: number;
    /** Received, ever. Only `SETTLED` rows. */
    collected: number;
    /** Invoices we issued ourselves because Softmato could not be reached. */
    issuedByPlatform: number;
    /** Still owed on invoices that are neither paid nor void. */
    outstanding: number;
  };
};

type InvoiceLean = {
  _id: Types.ObjectId;
  amount: number;
  billedTo?: { hostelName?: string; name?: string };
  currency?: string;
  cycle: string;
  dueAt?: Date | null;
  hostelId: Types.ObjectId;
  invoiceNumber: string;
  issuedAt?: Date | null;
  lifetime?: boolean;
  localInvoiceNo?: string | null;
  planName: string;
  softmatoInvoiceNo?: string | null;
  source?: string;
  status: string;
};

type PaymentLean = {
  _id: Types.ObjectId;
  amount: number;
  currency?: string;
  hostelId: Types.ObjectId;
  invoiceId: Types.ObjectId;
  localTransactionNo?: string | null;
  method: string;
  receiptNumber?: string | null;
  settledAt?: Date | null;
  softmatoProvider?: string | null;
  softmatoTransactionNo?: string | null;
  status: string;
};

function documentUrl(kind: "invoice" | "receipt", number: string): string {
  return `${siteUrl()}/api/v1/platform/subscriptions/documents/${kind}/${encodeURIComponent(number)}`;
}

export async function getPlatformSubscriptionLedger(options: {
  limit?: number;
} = {}): Promise<PlatformSubscriptionLedger> {
  await connectToDatabase();

  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);

  const [invoices, payments] = await Promise.all([
    SubscriptionInvoiceModel.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean<InvoiceLean[]>(),
    SubscriptionPaymentModel.find(EXCLUDE_CHECKOUT_ATTEMPTS)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean<PaymentLean[]>(),
  ]);

  /*
   * Paid-per-invoice in one aggregate over the *whole* collection rather than
   * one query per row. It deliberately ignores the page limit above: a balance
   * computed from only the payments that happened to be on this page would
   * show an invoice as unpaid because its settlement was the 201st row.
   */
  const settled = await SubscriptionPaymentModel.aggregate<{
    _id: Types.ObjectId;
    total: number;
  }>([
    { $match: { status: "SETTLED" } },
    { $group: { _id: "$invoiceId", total: { $sum: "$amount" } } },
  ]);

  const paidByInvoice = new Map(
    settled.map((row) => [String(row._id), row.total]),
  );

  const invoiceById = new Map(invoices.map((row) => [String(row._id), row]));

  const [billedAgg, collectedAgg, outstandingAgg, activePlans] =
    await Promise.all([
      SubscriptionInvoiceModel.aggregate<{ total: number }>([
        { $match: { status: { $ne: "VOID" } } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      SubscriptionPaymentModel.aggregate<{ total: number }>([
        { $match: { status: "SETTLED" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      /*
       * Outstanding is **per invoice**, not billed-minus-collected.
       *
       * The subtraction looks equivalent and is not: money collected against
       * invoices that are already `PAID` would be netted off the balance of the
       * ones that are still open, and a platform that had sold a lot last year
       * would read as owed nothing this year. So each unsettled invoice is
       * joined to its own settled payments and the shortfall summed.
       */
      SubscriptionInvoiceModel.aggregate<{ total: number }>([
        { $match: { status: { $in: ["OPEN", "PARTIAL"] } } },
        {
          $lookup: {
            as: "settled",
            foreignField: "invoiceId",
            from: SubscriptionPaymentModel.collection.name,
            localField: "_id",
            pipeline: [{ $match: { status: "SETTLED" } }],
          },
        },
        {
          $project: {
            shortfall: {
              $max: [
                0,
                { $subtract: ["$amount", { $sum: "$settled.amount" }] },
              ],
            },
          },
        },
        { $group: { _id: null, total: { $sum: "$shortfall" } } },
      ]),
      HostelSubscriptionModel.countDocuments({
        currentPeriodEnd: { $gt: new Date() },
        status: { $in: ["ACTIVE", "PAST_DUE"] },
      }),
    ]);

  const collected = collectedAgg[0]?.total ?? 0;
  const issuedByPlatform = await SubscriptionInvoiceModel.countDocuments({
    localInvoiceNo: { $type: "string" },
    softmatoInvoiceNo: null,
  });

  return {
    invoices: invoices.map((invoice) => {
      const paid = paidByInvoice.get(String(invoice._id)) ?? 0;
      const printedNumber =
        invoice.softmatoInvoiceNo ??
        invoice.localInvoiceNo ??
        invoice.invoiceNumber;

      return {
        amount: invoice.amount,
        currency: invoice.currency ?? "NPR",
        cycle: invoice.cycle,
        documentUrl: documentUrl("invoice", invoice.invoiceNumber),
        dueAt: invoice.dueAt?.toISOString() ?? null,
        hostelId: invoice.hostelId.toString(),
        hostelName:
          invoice.billedTo?.hostelName || invoice.billedTo?.name || "—",
        invoiceNumber: invoice.invoiceNumber,
        issuedAt: invoice.issuedAt?.toISOString() ?? null,
        issuedBy: invoice.softmatoInvoiceNo ? "softmato" : "platform",
        outstanding:
          invoice.status === "VOID" ? 0 : Math.max(0, invoice.amount - paid),
        paid,
        // The lifetime deal reads as such in the platform's own list.
        planName: invoice.lifetime ? `${invoice.planName} · Lifetime` : invoice.planName,
        printedNumber,
        source: invoice.source ?? "PUBLIC",
        status: invoice.status,
      };
    }),
    payments: payments.map((payment) => {
      const invoice = invoiceById.get(String(payment.invoiceId));
      const printedNumber =
        payment.softmatoTransactionNo ?? payment.localTransactionNo ?? null;

      return {
        amount: payment.amount,
        currency: payment.currency ?? "NPR",
        /*
         * Only a settled payment has a document. A pending or failed row is a
         * promise that has not been kept, and offering a download for it would
         * hand a superadmin a 404 — or, worse, imply a receipt exists for money
         * that never arrived.
         */
        documentUrl:
          payment.status === "SETTLED" && (printedNumber ?? payment.receiptNumber)
            ? documentUrl(
                "receipt",
                (printedNumber ?? payment.receiptNumber) as string,
              )
            : null,
        hostelId: payment.hostelId.toString(),
        hostelName:
          invoice?.billedTo?.hostelName || invoice?.billedTo?.name || "—",
        invoiceNumber: invoice?.invoiceNumber ?? "—",
        method: payment.method,
        paidAt: payment.settledAt?.toISOString() ?? null,
        printedNumber,
        provider: payment.softmatoProvider ?? null,
        receiptNumber: payment.receiptNumber ?? null,
        status: payment.status,
      };
    }),
    totals: {
      activePlans,
      billed: billedAgg[0]?.total ?? 0,
      collected,
      issuedByPlatform,
      outstanding: outstandingAgg[0]?.total ?? 0,
    },
  };
}
