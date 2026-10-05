import type { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { monthLabel } from "@/lib/format-month";
import { bsPeriodBounds, hostelPeriodOf, isBsPeriod } from "@/lib/hostel-day";
import { auditFinanceAction } from "@/modules/finance/audit-finance";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import { listResidentInvoices } from "@/modules/finance/ledger-read.service";
import { renderReceiptPdf, renderStatementPdf } from "@/modules/finance/receipt-pdf";
import {
  maskedName,
  newCertificationCode,
  normalizeCertificationCode,
} from "@/modules/offer-program/offer-program.rules";
import { HostelModel } from "@hostel/db/models/Hostel";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { PaymentEventModel } from "@hostel/db/models/PaymentEvent";
import { ResidentModel } from "@hostel/db/models/Resident";
import { ReceiptCounterModel } from "@hostel/db/models/ReceiptCounter";
import { ReceiptModel } from "@hostel/db/models/Receipt";

/**
 * Receipts (target §4.4, plan item 2.6).
 *
 * Two things change from the current implementation, and both are correctness
 * rather than polish.
 *
 * **Numbering is atomic.** The old allocator was
 * `findOne({receiptNumber: /^prefix/}).sort({receiptNumber: -1})` — a race
 * dressed as a query. It works only because the sequence is zero-padded to five
 * digits, so it breaks at 100,000 receipts in a month, and two concurrent
 * approvals read the same "last" number and then fight over the unique index
 * with a five-attempt retry loop (current §5.5). One `findOneAndUpdate($inc)` is
 * atomic in MongoDB: distinct numbers, no retry, no loop, no ceiling.
 *
 * **Numbering is per hostel.** A global sequence interleaves one hostel's
 * receipts with another's, and the gaps leak the platform's monthly volume to
 * anyone who looks at their own numbers. The hostel's reference prefix goes into
 * the number so two hostels' sequences cannot collide on the unique index.
 */

export type ReceiptRecord = {
  _id: Types.ObjectId;
  amount: number;
  certificationCode?: string | null;
  eventId?: Types.ObjectId | null;
  hostelId: Types.ObjectId;
  invoiceId?: Types.ObjectId | null;
  issuedAt: Date;
  receiptNumber: string;
  residentId: Types.ObjectId;
  voidedAt?: Date | null;
};

/**
 * The next receipt number for a hostel and period, e.g. `RCP-EDU-2026-08-00001`.
 *
 * Padded to five digits for readability only — the sequence is a number and
 * keeps counting past 99,999, which is where the string-sorted version silently
 * started reusing numbers.
 */
export async function nextReceiptNumber(
  hostelId: Types.ObjectId | string,
  period: string,
  hostelPrefix?: string | null,
): Promise<string> {
  const counter = await ReceiptCounterModel.findOneAndUpdate(
    { hostelId, kind: "RECEIPT", period },
    { $inc: { sequence: 1 } },
    { new: true, setDefaultsOnInsert: true, upsert: true },
  ).lean<{ sequence: number } | null>();

  const sequence = counter?.sequence ?? 1;
  const segments = ["RCP", hostelPrefix, period, String(sequence).padStart(5, "0")];

  return segments.filter(Boolean).join("-");
}

/**
 * "YYYY-MM" from a date, in the hostel's own day, so a receipt's period does not
 * depend on where it was issued.
 *
 * That was the intent when this read UTC, and UTC did not deliver it. Nepal is
 * UTC+05:45, so a receipt issued after 18:15 on the last day of a month was
 * numbered into the month that had already ended — `RCP-…-2026-08-00001` handed
 * to somebody on 1 September. The offset lives in `lib/hostel-day.ts`.
 */
export function periodOfDate(date: Date): string {
  return hostelPeriodOf(date);
}

/**
 * The dates a monthly invoice's period covers — first day to last day.
 *
 * Derived rather than stored because `Invoice` holds `period` and nothing else:
 * there is no `periodStart`/`periodEnd` on the model, and adding a pair of
 * denormalised dates that must agree with the string forever is a worse trade
 * than computing them where they are printed.
 *
 * ## The two numbers were read in the wrong calendar
 *
 * This split the key on the hyphen and handed the halves to `Date.UTC`. After
 * the cutover the key is Bikram Sambat, so `2083-05` — Bhadra 2083, 17 August to
 * 16 September 2026 — was printed on a resident's receipt as **1 to 31 May
 * 2083**: a span in the wrong calendar, the wrong month within it, and fifty-
 * seven years away, on the one document a resident hands to a landlord or an
 * employer. `bsPeriodBounds` is the table that knows a BS month is 29 to 32 days
 * and which of those this one is.
 *
 * `lastDay`, not `end`. This is a **calendar day** printed as "Covers until", and
 * `end` is the month's last millisecond in UTC — 05:44 the next morning in
 * Kathmandu, which every Nepali reader would name as the first of the following
 * month. `end` belongs to `$lte` range queries and nowhere near a printed date.
 *
 * Returns null for anything that is not a month this can bound. A one-off — an
 * admission fee, a deposit — carries no period at all, and a receipt for one is
 * honest by omitting the line rather than by inventing a month it did not buy.
 * A pre-cutover Gregorian key keeps the Gregorian span it has always meant: those
 * receipts were correct when they were issued and must not be re-dated now.
 */
export function periodCoverage(
  period: string | null | undefined,
): { from: Date; to: Date } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(period ?? "");

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);

  if (month < 1 || month > 12) {
    return null;
  }

  if (isBsPeriod(period)) {
    try {
      const { lastDay, start } = bsPeriodBounds(period!);

      return { from: start, to: lastDay };
    } catch {
      // Past the conversion table. Printing nothing beats printing a guess.
      return null;
    }
  }

  return {
    from: new Date(Date.UTC(year, month - 1, 1)),
    to: new Date(Date.UTC(year, month, 0)),
  };
}

export type IssueReceiptInput = {
  amount: number;
  /** Resident Offer Program: see `qualifiesForOfferProgram`. */
  certify?: boolean;
  eventId: Types.ObjectId | string;
  hostelId: Types.ObjectId | string;
  invoiceId?: Types.ObjectId | string | null;
  issuedAt?: Date;
  residentId: Types.ObjectId | string;
};

/**
 * Issues the receipt for a settled event.
 *
 * **Idempotent on `eventId`.** The unique partial index is what guarantees one
 * receipt per event; this catches the duplicate-key error and returns the
 * receipt that already exists, so a retried settlement — or the crash-and-resume
 * path that ADR-4 deliberately leaves possible — cannot produce two documents
 * claiming the same money.
 *
 * Called after the balance is recomputed and before the resident is notified,
 * which is the ordering `payment-event.service` documents and must keep.
 */
export async function issueReceiptForEvent(
  input: IssueReceiptInput,
  principal?: ApiPrincipal,
): Promise<ReceiptRecord> {
  await connectToDatabase();

  const issuedAt = input.issuedAt ?? new Date();

  const existing = await ReceiptModel.findOne({
    eventId: input.eventId,
  }).lean<ReceiptRecord | null>();

  if (existing) {
    return existing;
  }

  const hostel = await HostelModel.findOne({ _id: input.hostelId })
    .select("referencePrefix")
    .lean<{ referencePrefix?: string } | null>();

  try {
    return (await ReceiptModel.create({
      amount: input.amount,
      ...(input.certify
        ? { certificationCode: newCertificationCode(), certifiedAt: issuedAt }
        : {}),
      eventId: input.eventId,
      hostelId: input.hostelId,
      invoiceId: input.invoiceId ?? null,
      issuedAt,
      issuedBy: principal?.userId ?? null,
      receiptNumber: await nextReceiptNumber(
        input.hostelId,
        periodOfDate(issuedAt),
        hostel?.referencePrefix,
      ),
      residentId: input.residentId,
    })) as unknown as ReceiptRecord;
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) {
      throw error;
    }

    // Two settlements of the same event raced. The index refused the second;
    // return the one that won rather than surfacing a conflict the caller
    // cannot act on.
    const winner = await ReceiptModel.findOne({
      eventId: input.eventId,
    }).lean<ReceiptRecord | null>();

    if (!winner) {
      throw error;
    }

    return winner;
  }
}

/**
 * A receipt rendered as PDF bytes, for whoever is allowed to see it.
 *
 * `scope` is the authorization, and it is a parameter rather than a lookup so
 * the two callers cannot accidentally share one: a resident may read only their
 * own receipt, a staff member only their hostel's. A receipt that does not match
 * is reported as missing rather than forbidden — out-of-scope and non-existent
 * must be indistinguishable from outside the tenant (RULES.md §3).
 */
export async function renderReceiptById(
  receiptId: Types.ObjectId | string,
  scope: { hostelIds?: string[]; residentId?: Types.ObjectId | string },
): Promise<{ bytes: Uint8Array; receiptNumber: string }> {
  await connectToDatabase();

  const filter: Record<string, unknown> = { _id: receiptId };

  if (scope.residentId) {
    filter.residentId = scope.residentId;
  }

  if (scope.hostelIds) {
    filter.hostelId = { $in: scope.hostelIds };
  }

  const receipt = await ReceiptModel.findOne(filter).lean<
    | (ReceiptRecord & {
        voidReason?: string | null;
      })
    | null
  >();

  if (!receipt) {
    throw new FinanceServiceError("Receipt was not found.", "RECEIPT_NOT_FOUND");
  }

  const [hostel, resident, invoice, event] = await Promise.all([
    HostelModel.findOne({ _id: receipt.hostelId })
      .select("name")
      .lean<{ name?: string } | null>(),
    ResidentModel.findOne({ _id: receipt.residentId })
      .select("firstName fullName lastName")
      .lean<{ firstName?: string; fullName?: string; lastName?: string } | null>(),
    receipt.invoiceId
      ? InvoiceModel.findOne({ _id: receipt.invoiceId })
          .select("lines period referenceCode")
          .lean<{
            lines?: { amount: number; description: string }[];
            period?: string;
            referenceCode?: string;
          } | null>()
      : null,
    receipt.eventId
      ? PaymentEventModel.findOne({ _id: receipt.eventId })
          .select("source")
          .lean<{ source?: string } | null>()
      : null,
  ]);

  const coverage = periodCoverage(invoice?.period);

  const bytes = await renderReceiptPdf({
    amount: receipt.amount,
    certificationCode: receipt.certificationCode ?? null,
    coversFrom: coverage?.from ?? null,
    coversTo: coverage?.to ?? null,
    hostelName: hostel?.name ?? "Hostel",
    invoiceLines: invoice?.lines?.map(({ amount, description }) => ({ amount, description })),
    // Named, never raw. `2083-05` is a database key; the line on the document
    // has to say `Bhadra 2083 BS`, which is the month written on the hostel's
    // own receipt pad. `monthLabel` keeps a pre-cutover key in English.
    invoicePeriod: invoice?.period ? monthLabel(invoice.period) : null,
    issuedAt: receipt.issuedAt,
    method:
      event?.source === "OFFER_PROGRAM"
        ? "Paid by HostelPalika - Resident Offer Program"
        : null,
    receiptNumber: receipt.receiptNumber,
    referenceCode: invoice?.referenceCode ?? null,
    residentName:
      resident?.fullName ??
      [resident?.firstName, resident?.lastName].filter(Boolean).join(" ") ??
      "Resident",
    voidReason: receipt.voidReason ?? null,
    voidedAt: receipt.voidedAt ?? null,
  });

  return { bytes, receiptNumber: receipt.receiptNumber };
}

/**
 * The resident's own statement, as PDF bytes.
 *
 * Reads through the ledger facade rather than either model directly, so the
 * statement says the same thing before and after the cutover — the one document
 * a resident may hand to a landlord or a visa officer is the last place a
 * source-dependent answer would be acceptable.
 */
export async function renderStatementForResident(scope: {
  hostelId: Types.ObjectId | string;
  residentId: Types.ObjectId | string;
  residentName: string;
}): Promise<Uint8Array> {
  await connectToDatabase();

  const [hostel, invoices] = await Promise.all([
    HostelModel.findOne({ _id: scope.hostelId })
      .select("name")
      .lean<{ name?: string } | null>(),
    listResidentInvoices({ hostelId: scope.hostelId, residentId: scope.residentId }),
  ]);

  return renderStatementPdf({
    generatedAt: new Date(),
    hostelName: hostel?.name ?? "Hostel",
    residentName: scope.residentName,
    rows: invoices.map((invoice) => ({
      dueAmount: invoice.dueAmount,
      paidAmount: invoice.paidAmount,
      // A one-off — an admission fee, a fine — has no period, and the Period
      // column has to say something. Blank would read as a rendering fault on a
      // document a resident hands to a landlord or an employer.
      period: invoice.period ? monthLabel(invoice.period) : "One-off",
      status: invoice.status,
    })),
  });
}

/**
 * Voids a receipt and issues its replacement (target §4.4).
 *
 * The correction path, because a receipt is immutable: the original keeps its
 * number and its amount and gains only the fact that it was voided, so a
 * resident holding the old document can be told exactly what happened to it. The
 * replacement gets a fresh number — reusing the voided one would make two
 * different documents answer to the same identifier.
 *
 * A reversal calls this with no replacement: there is no new receipt when the
 * money went back.
 */
export async function voidReceipt(
  receiptId: Types.ObjectId | string,
  options: {
    principal: ApiPrincipal;
    reason: string;
    reissue?: { amount: number };
  },
): Promise<{ receipt: ReceiptRecord; replacement: ReceiptRecord | null }> {
  await connectToDatabase();

  if (!options.reason || options.reason.trim().length < 3) {
    throw new FinanceServiceError(
      "Voiding a receipt needs a reason.",
      "AMOUNT_OUT_OF_BOUNDS",
    );
  }

  const receipt = await ReceiptModel.findOne({
    _id: receiptId,
  }).lean<ReceiptRecord | null>();

  if (!receipt) {
    throw new FinanceServiceError("Receipt was not found.", "FEE_SCHEDULE_MISSING");
  }

  if (receipt.voidedAt) {
    throw new FinanceServiceError(
      "This receipt has already been voided.",
      "RECEIPT_ALREADY_VOID",
    );
  }

  let replacement: ReceiptRecord | null = null;

  if (options.reissue) {
    const hostel = await HostelModel.findOne({ _id: receipt.hostelId })
      .select("referencePrefix")
      .lean<{ referencePrefix?: string } | null>();
    const issuedAt = new Date();

    replacement = (await ReceiptModel.create({
      amount: options.reissue.amount,
      // A correction of a certified receipt stays certified — under a code of
      // its own, because the code names one document and the old one is void.
      ...(receipt.certificationCode
        ? { certificationCode: newCertificationCode(), certifiedAt: issuedAt }
        : {}),
      // Deliberately not `eventId`: the unique index permits one receipt per
      // event, and the voided one already holds it. A replacement is a document
      // about the same money, not a second claim to it.
      hostelId: receipt.hostelId,
      invoiceId: receipt.invoiceId ?? null,
      issuedAt,
      issuedBy: options.principal.userId,
      receiptNumber: await nextReceiptNumber(
        receipt.hostelId,
        periodOfDate(issuedAt),
        hostel?.referencePrefix,
      ),
      residentId: receipt.residentId,
    })) as unknown as ReceiptRecord;
  }

  await ReceiptModel.updateOne(
    { _id: receipt._id },
    {
      $set: {
        replacedByReceiptId: replacement?._id ?? null,
        voidReason: options.reason,
        voidedAt: new Date(),
        voidedBy: options.principal.userId,
      },
    },
  );

  await auditFinanceAction(options.principal, {
    action: "RECEIPT_VOIDED",
    amountAfter: replacement?.amount ?? 0,
    amountBefore: receipt.amount,
    entityId: receipt._id,
    entityType: "Receipt",
    hostelId: receipt.hostelId,
    invoiceId: receipt.invoiceId?.toString(),
    reason: options.reason,
    source: "RECEIPT_VOID",
  });

  return { receipt, replacement };
}

export type ReceiptVerification =
  | { found: false }
  | {
      amount: number;
      certificationCode: string;
      found: true;
      hostelName: string;
      issuedAt: string;
      period: string | null;
      receiptNumber: string;
      /** First name and last initial — enough to match a printout, no more. */
      residentName: string;
      voidedAt: string | null;
    };

/**
 * The public side of a certified receipt: anyone holding one — a landlord, a
 * parent, a bank — types its code and sees what we recorded. A forged receipt
 * either has no code that exists, or borrows a real one and shows somebody
 * else's amount and name.
 */
export async function verifyReceiptByCode(input: string): Promise<ReceiptVerification> {
  const code = normalizeCertificationCode(input);

  if (!code) {
    return { found: false };
  }

  await connectToDatabase();

  const receipt = await ReceiptModel.findOne({ certificationCode: code }).lean<
    (ReceiptRecord & { certificationCode: string }) | null
  >();

  if (!receipt) {
    return { found: false };
  }

  const [hostel, resident, invoice] = await Promise.all([
    HostelModel.findOne({ _id: receipt.hostelId })
      .select("name")
      .lean<{ name?: string } | null>(),
    ResidentModel.findOne({ _id: receipt.residentId })
      .select("firstName fullName lastName")
      .lean<{ firstName?: string; fullName?: string; lastName?: string } | null>(),
    receipt.invoiceId
      ? InvoiceModel.findOne({ _id: receipt.invoiceId })
          .select("period")
          .lean<{ period?: string } | null>()
      : null,
  ]);

  return {
    amount: receipt.amount,
    certificationCode: receipt.certificationCode,
    found: true,
    hostelName: hostel?.name ?? "Hostel",
    issuedAt: receipt.issuedAt.toISOString(),
    period: invoice?.period ? monthLabel(invoice.period) : null,
    receiptNumber: receipt.receiptNumber,
    residentName: maskedName(
      resident?.fullName ||
        [resident?.firstName, resident?.lastName].filter(Boolean).join(" ") ||
        "Resident",
    ),
    voidedAt: receipt.voidedAt?.toISOString() ?? null,
  };
}
