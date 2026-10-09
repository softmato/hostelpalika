import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { auditFinanceAction } from "@/modules/finance/audit-finance";
import { creditOverpayment } from "@/modules/finance/credit-balance.service";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import { assertWholeRupees, sumAmounts } from "@/modules/finance/money";
import {
  notifyAdminsOfStaffSettlement,
  notifyPaymentReversed,
} from "@/modules/finance/finance-notify";
import { Role } from "@/lib/roles";
import { issueReceiptForEvent, voidReceipt } from "@/modules/finance/receipt.service";
import { qualifiesForOfferProgram } from "@/modules/offer-program/offer-program.rules";
import type { ReceiptRecord } from "@/modules/finance/receipt.service";
import { ReceiptModel } from "@hostel/db/models/Receipt";
import { InvoiceBalanceModel } from "@hostel/db/models/InvoiceBalance";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { PaymentEventModel } from "@hostel/db/models/PaymentEvent";

/**
 * The only module that writes money (ADR-2).
 *
 * Every balance in the product is `sum(settled events)` computed here. Nothing
 * else may create, settle or reverse a `PaymentEvent`, and nothing at all may
 * edit one — a correction is a new reversing event, never an amendment
 * (target §9.3).
 *
 * **No transactions** (ADR-4, D4). The repo has never used MongoDB
 * transactions, and requiring them would break `npm run dev` on a standalone
 * mongod. Instead every write is keyed by a deterministic `idempotencyKey` and
 * is safe to re-run, and multi-step sequences are ordered so a crash leaves a
 * *detectable* half-state that the nightly drift job (5.1) reports:
 *
 *     append event (unique-key claim) → recompute balance → issue receipt → notify
 *
 * A crash after the append leaves money recorded but a stale balance, which the
 * drift job finds. A crash before it leaves nothing, which is a clean retry.
 * That ordering is deliberate and must not be rearranged for convenience.
 */

export type EventDirection = "CREDIT" | "DEBIT";
export type EventStatus =
  | "PENDING"
  | "SETTLED"
  | "FAILED"
  | "EXPIRED"
  | "REJECTED"
  | "REVERSED";
export type EventConfirmation =
  | "UNCONFIRMED"
  | "MANUAL_REVIEW"
  | "STATEMENT_MATCH"
  | "GATEWAY_VERIFIED";

export type PaymentEventRecord = {
  _id: Types.ObjectId;
  amount: number;
  confirmation: EventConfirmation;
  confirmedAt?: Date | null;
  direction: EventDirection;
  hostelId: Types.ObjectId;
  idempotencyKey: string;
  invoiceId?: Types.ObjectId | null;
  providerTxnId?: string | null;
  rawPayload?: { referenceNote?: string | null; transactionCode?: string | null } | null;
  referenceCode?: string | null;
  residentId?: Types.ObjectId | null;
  reversedByEventId?: Types.ObjectId | null;
  settledAt?: Date | null;
  source?: string;
  status: EventStatus;
};

export type AppendEventInput = {
  amount: number;
  confirmation?: EventConfirmation;
  direction?: EventDirection;
  evidenceAssetId?: Types.ObjectId | string | null;
  evidenceHash?: string | null;
  hostelId: Types.ObjectId | string;
  idempotencyKey: string;
  invoiceId?: Types.ObjectId | string | null;
  occurredAt?: Date;
  provider?: string;
  providerTxnId?: string | null;
  rawPayload?: unknown;
  referenceCode?: string | null;
  residentId?: Types.ObjectId | string | null;
  /** Non-blocking notes for a human reviewer, e.g. `SIMILAR_EVIDENCE` (3.4). */
  reviewFlags?: string[];
  source: string;
  /** Set only by the statement importer — see the model comment. */
  statementImportId?: Types.ObjectId | string | null;
  status?: EventStatus;
};

export type AppendEventResult = {
  /** False when the key already existed — the call was a replay, not a write. */
  created: boolean;
  event: PaymentEventRecord;
};

/** Mongo's duplicate-key error. */
function isDuplicateKey(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { code?: number }).code === 11000,
  );
}

/** Which unique index a duplicate-key error tripped, for a useful message. */
function duplicateField(error: unknown): string {
  const message = (error as { message?: string }).message ?? "";

  if (message.includes("evidenceHash")) {
    return "evidenceHash";
  }

  if (message.includes("providerTxnId")) {
    return "providerTxnId";
  }

  return "idempotencyKey";
}

/**
 * Records an attempt to pay.
 *
 * **Idempotent by construction, not by a check.** The unique index on
 * `idempotencyKey` is what makes a retried webhook, a re-uploaded overlapping
 * statement and a double-tapped submit collapse to a no-op — this catches the
 * duplicate-key error and returns the event that already exists, so callers do
 * not need a read-then-write race of their own.
 *
 * A collision on `providerTxnId` or `evidenceHash` is *not* a replay: it is the
 * same money or the same screenshot being claimed twice, which is a fraud
 * control firing (target §8) and must reach the caller as an error.
 */
export async function appendEvent(input: AppendEventInput): Promise<AppendEventResult> {
  await connectToDatabase();

  assertWholeRupees(input.amount, "event amount");

  try {
    const event = (await PaymentEventModel.create({
      amount: input.amount,
      confirmation: input.confirmation ?? "UNCONFIRMED",
      direction: input.direction ?? "CREDIT",
      evidenceAssetId: input.evidenceAssetId ?? null,
      evidenceHash: input.evidenceHash ?? null,
      hostelId: input.hostelId,
      idempotencyKey: input.idempotencyKey,
      invoiceId: input.invoiceId ?? null,
      observedAt: new Date(),
      occurredAt: input.occurredAt ?? new Date(),
      provider: input.provider ?? "NONE",
      providerTxnId: input.providerTxnId ?? null,
      rawPayload: input.rawPayload ?? {},
      referenceCode: input.referenceCode ?? null,
      residentId: input.residentId ?? null,
      reviewFlags: input.reviewFlags ?? [],
      source: input.source,
      statementImportId: input.statementImportId ?? null,
      status: input.status ?? "PENDING",
    })) as unknown as PaymentEventRecord;

    return { created: true, event };
  } catch (error) {
    if (!isDuplicateKey(error)) {
      throw error;
    }

    const field = duplicateField(error);

    if (field === "providerTxnId") {
      throw new FinanceServiceError(
        "This transaction ID has already been recorded.",
        "TXN_ID_ALREADY_USED",
      );
    }

    if (field === "evidenceHash") {
      throw new FinanceServiceError(
        "This screenshot has already been submitted.",
        "EVIDENCE_ALREADY_USED",
      );
    }

    // Same idempotency key: this exact write already happened. Return it.
    const existing = await PaymentEventModel.findOne({
      idempotencyKey: input.idempotencyKey,
    }).lean<PaymentEventRecord | null>();

    if (!existing) {
      throw error;
    }

    return { created: false, event: existing };
  }
}

/**
 * Moves a PENDING event to SETTLED, then recomputes the invoice balance.
 *
 * The claim is a `findOneAndUpdate` filtered on `status: "PENDING"`, which is
 * both the double-approval guard and what satisfies the immutability rule: the
 * filter cannot match an already-settled event, so no settled row can be
 * rewritten by this path. A losing writer matches nothing and is told the event
 * was already reviewed rather than silently double-crediting.
 */
export async function settleEvent(
  eventId: Types.ObjectId | string,
  options: {
    confirmation: EventConfirmation;
    principal?: ApiPrincipal;
    settledAt?: Date;
  },
): Promise<{
  balance: InvoiceBalanceResult | null;
  event: PaymentEventRecord;
  receipt: ReceiptRecord | null;
}> {
  await connectToDatabase();

  const settledAt = options.settledAt ?? new Date();
  const event = await PaymentEventModel.findOneAndUpdate(
    { _id: eventId, status: "PENDING" },
    {
      $set: {
        confirmation: options.confirmation,
        reviewedAt: settledAt,
        reviewedBy: options.principal?.userId,
        settledAt,
        status: "SETTLED",
      },
    },
    { new: true },
  ).lean<PaymentEventRecord | null>();

  if (!event) {
    throw new FinanceServiceError(
      "This payment event is no longer pending.",
      "SETTLED_EVENT_IMMUTABLE",
    );
  }

  const balance = event.invoiceId ? await recomputeInvoiceBalance(event.invoiceId) : null;

  // Target §9.4: an event that exceeds what the invoice owes settles **in full**
  // and the excess becomes credit. Never destroy money — the alternative this
  // replaces clamped the excess away, so 15,000 against a 12,000 invoice was
  // indistinguishable from a 12,000 payment.
  if (
    balance &&
    event.direction === "CREDIT" &&
    event.residentId &&
    event.invoiceId &&
    balance.settledAmount > balance.totalAmount
  ) {
    await creditOverpayment({
      eventId: event._id,
      excess: balance.settledAmount - balance.totalAmount,
      hostelId: event.hostelId,
      invoiceId: event.invoiceId,
      occurredAt: settledAt,
      residentId: event.residentId,
    });
  }

  // Third in the documented order: append → recompute → **issue receipt** →
  // notify. Idempotent on the event, so the crash-and-resume path this design
  // deliberately allows cannot mint a second receipt for the same money.
  // Only a CREDIT earns one — a reversal's DEBIT voids a receipt, it does not
  // issue one (target §9.3).
  const receipt =
    event.direction === "CREDIT" && event.residentId
      ? await issueReceiptForEvent(
          {
            amount: event.amount,
            eventId: event._id,
            hostelId: event.hostelId,
            invoiceId: event.invoiceId ?? null,
            issuedAt: settledAt,
            residentId: event.residentId,
            // Reference quoted and independently verified → a certified receipt
            // in the Resident Offer Program. Decided once, here, for every path.
            certify: qualifiesForOfferProgram(event),
          },
          options.principal,
        )
      : null;

  if (options.principal) {
    await auditFinanceAction(options.principal, {
      action: "PAYMENT_EVENT_SETTLED",
      amountAfter: balance?.settledAmount ?? event.amount,
      amountBefore: (balance?.settledAmount ?? event.amount) - event.amount,
      entityId: event._id,
      entityType: "PaymentEvent",
      eventId: event._id.toString(),
      hostelId: event.hostelId,
      invoiceId: event.invoiceId?.toString(),
      source: "EVENT_SETTLEMENT",
    });
  }

  // A warden taking a resident's money — cash at the desk or approving their
  // proof — reaches the owner's phone. Every such path settles through here.
  if (
    options.principal?.role === Role.WARDEN &&
    event.direction === "CREDIT" &&
    event.residentId
  ) {
    await notifyAdminsOfStaffSettlement({
      amount: event.amount,
      eventId: event._id.toString(),
      hostelId: event.hostelId,
      residentId: event.residentId,
      staffUserId: options.principal.userId,
    });
  }

  return { balance, event, receipt };
}

/**
 * A human's settlement, confirmed later by the hostel's own statement (item E.5).
 *
 * **This is provisional credit, and the sequencing is the whole point.** A warden
 * approves a claim on the strength of a screenshot; the invoice reads paid and
 * dunning stops that instant, because holding the resident hostage to statement
 * lag would punish the honest majority for a control aimed at the rare forgery.
 * What the approval does *not* do is end the matter — the settlement stays
 * `MANUAL_REVIEW`, stays in the matching universe (item E.6), and is promoted
 * here when a credit for it actually turns up. Nothing about the money changes:
 * the same amount, the same invoice, the same receipt. Only how strongly it is
 * believed, which is precisely what `confirmation` records.
 *
 * The filter pins `SETTLED` *and* `MANUAL_REVIEW`, which is what the model's
 * immutability guard requires and also makes the call idempotent: a second
 * statement carrying the same credit matches nothing and reports `false`.
 */
export async function confirmSettlementByStatement(
  eventId: Types.ObjectId | string,
  options: {
    confirmedAt?: Date;
    principal?: ApiPrincipal;
    statementImportId?: Types.ObjectId | string | null;
  } = {},
): Promise<{ event: PaymentEventRecord | null; promoted: boolean }> {
  await connectToDatabase();

  const confirmedAt = options.confirmedAt ?? new Date();

  const event = await PaymentEventModel.findOneAndUpdate(
    { _id: eventId, confirmation: "MANUAL_REVIEW", status: "SETTLED" },
    {
      $set: {
        confirmation: "STATEMENT_MATCH",
        confirmedAt,
        // Which upload proved it. Null on the claim until now, so this is a new
        // fact rather than an overwrite, and it is what lets the reconciliation
        // screen link a confirmed claim back to the file that confirmed it.
        ...(options.statementImportId
          ? { statementImportId: options.statementImportId }
          : {}),
      },
    },
    { new: true },
  ).lean<PaymentEventRecord | null>();

  if (!event) {
    return { event: null, promoted: false };
  }

  if (options.principal) {
    await auditFinanceAction(options.principal, {
      action: "PAYMENT_EVENT_CONFIRMED",
      // No balance moves: the money was already counted when it settled. Both
      // sides are the event's own amount so the envelope still says what was
      // confirmed.
      amountAfter: event.amount,
      amountBefore: event.amount,
      entityId: event._id,
      entityType: "PaymentEvent",
      eventId: event._id.toString(),
      hostelId: event.hostelId,
      invoiceId: event.invoiceId?.toString(),
      source: "STATEMENT_IMPORT",
    });
  }

  return { event, promoted: true };
}

/**
 * Reverses a settled event by writing its mirror (target §9.3).
 *
 * Fixes current §7.5: a wrongly approved proof currently cannot be undone except
 * through the raw PATCH, which forces staff into the least auditable path in the
 * system. Here the original is left exactly as it was — the DEBIT is a new row,
 * and `reversedByEventId` on the original is the one write the immutability
 * guard permits, because it touches no financial field.
 *
 * Idempotent on `reversal:{originalEventId}`, so a double-click reverses once.
 */
export async function reverseEvent(
  eventId: Types.ObjectId | string,
  options: { principal: ApiPrincipal; reason: string },
): Promise<{ balance: InvoiceBalanceResult | null; reversal: PaymentEventRecord }> {
  await connectToDatabase();

  if (!options.reason || options.reason.trim().length < 3) {
    throw new FinanceServiceError(
      "A reversal needs a reason.",
      "REVERSAL_REASON_REQUIRED",
    );
  }

  const original = await PaymentEventModel.findOne({
    _id: eventId,
  }).lean<PaymentEventRecord | null>();

  if (!original) {
    throw new FinanceServiceError("Payment event was not found.", "EVENT_NOT_FOUND");
  }

  if (original.status !== "SETTLED") {
    throw new FinanceServiceError(
      "Only a settled payment can be reversed.",
      "SETTLED_EVENT_IMMUTABLE",
    );
  }

  const { event: reversal } = await appendEvent({
    amount: original.amount,
    confirmation: "MANUAL_REVIEW",
    direction: original.direction === "CREDIT" ? "DEBIT" : "CREDIT",
    hostelId: original.hostelId,
    idempotencyKey: `reversal:${original._id.toString()}`,
    invoiceId: original.invoiceId ?? null,
    rawPayload: { reason: options.reason, reverses: original._id.toString() },
    residentId: original.residentId ?? null,
    source: "ADJUSTMENT",
    status: "SETTLED",
  });

  // Two pointers, written after the reversal exists so a crash between them
  // leaves a detectable half-state rather than a dangling reference.
  await PaymentEventModel.updateOne(
    { _id: reversal._id },
    { $set: { reversesEventId: original._id, settledAt: new Date() } },
  );
  // `reversedByEventId` is the ONLY write to the original, exactly as target
  // §9.3 specifies. It must keep `status: "SETTLED"`.
  //
  // Setting it to `REVERSED` here looks tidier and silently breaks invariant 1.
  // The balance is `sum({status: "SETTLED"})`, so demoting the original drops
  // the CREDIT out of the sum *while* the new DEBIT also subtracts — reversing
  // 12,000 lands the balance at −12,000 rather than 0, and `outstanding`
  // reports 24,000 on a 12,000 invoice, which is what the resident is then
  // emailed. The drift job cannot catch it either: it derives the stored and
  // the computed figure from this same filter, so both are wrong and agree.
  //
  // A reversed event is identified by `reversedByEventId != null`, never by its
  // status. The DEBIT is what cancels the money.
  await PaymentEventModel.updateOne(
    { _id: original._id },
    { $set: { reversedByEventId: reversal._id } },
  );

  const balance = original.invoiceId
    ? await recomputeInvoiceBalance(original.invoiceId)
    : null;

  // The receipt for the reversed money must not keep standing — it is the
  // document a resident would show as proof of a payment that no longer counts.
  // Voided, never deleted, and no replacement is issued: the money went back.
  const receipt = await ReceiptModel.findOne({
    eventId: original._id,
  }).lean<{ _id: Types.ObjectId; voidedAt?: Date | null } | null>();

  if (receipt && !receipt.voidedAt) {
    await voidReceipt(receipt._id, {
      principal: options.principal,
      reason: options.reason,
    });
  }

  // Target §9.3 is right that a silently reversed payment is a support
  // disaster. Notified after the ledger is consistent, so the resident is never
  // told about a state the screens do not yet show.
  if (original.residentId) {
    const invoice = original.invoiceId
      ? await InvoiceModel.findOne({ _id: original.invoiceId })
          .select("period")
          .lean<{ period?: string } | null>()
      : null;

    await notifyPaymentReversed({
      amount: original.amount,
      hostelId: original.hostelId,
      invoiceId: original.invoiceId?.toString() ?? null,
      outstandingAmount: balance?.outstanding ?? 0,
      period: invoice?.period ?? null,
      reason: options.reason,
      residentId: original.residentId,
    });
  }

  await auditFinanceAction(options.principal, {
    action: "PAYMENT_EVENT_REVERSED",
    amountAfter: balance?.settledAmount ?? 0,
    amountBefore: (balance?.settledAmount ?? 0) + original.amount,
    entityId: original._id,
    entityType: "PaymentEvent",
    eventId: original._id.toString(),
    hostelId: original.hostelId,
    invoiceId: original.invoiceId?.toString(),
    reason: options.reason,
    source: "EVENT_REVERSAL",
  });

  return { balance, reversal };
}

export type InvoiceBalanceResult = {
  invoiceId: Types.ObjectId | string;
  outstanding: number;
  settledAmount: number;
  status: string;
  totalAmount: number;
};

/**
 * Rebuilds the balance projection from the events.
 *
 * The events are the truth; `InvoiceBalance` is a cache and is written here from
 * scratch each time rather than incremented — an increment can drift, a
 * recomputation cannot. The reconciliation job runs exactly this and compares
 * (target §10.1); disagreement is reported, never silently corrected, because a
 * drift means something wrote where it should not have.
 */
export async function recomputeInvoiceBalance(
  invoiceId: Types.ObjectId | string,
): Promise<InvoiceBalanceResult> {
  await connectToDatabase();

  const events = await PaymentEventModel.find({
    invoiceId,
    status: "SETTLED",
  }).lean<{ _id: Types.ObjectId; amount: number; direction: EventDirection }[]>();

  const settledAmount = sumAmounts(
    events.map((event) => (event.direction === "DEBIT" ? -event.amount : event.amount)),
    "settled event amount",
  );

  const invoice = await InvoiceModel.findOne({ _id: invoiceId }).lean<{
    _id: Types.ObjectId;
    dueDate?: Date;
    hostelId: Types.ObjectId;
    residentId?: Types.ObjectId;
    status: string;
    totalAmount: number;
  } | null>();

  if (!invoice) {
    throw new FinanceServiceError("Invoice was not found.", "INVOICE_NOT_FOUND");
  }

  const lastEvent = events[events.length - 1];

  await InvoiceBalanceModel.findOneAndUpdate(
    { invoiceId },
    {
      $inc: { version: 1 },
      $set: {
        hostelId: invoice.hostelId,
        lastComputedAt: new Date(),
        lastEventId: lastEvent?._id ?? null,
        residentId: invoice.residentId,
        settledAmount,
      },
    },
    { new: true, upsert: true },
  );

  const status = deriveInvoiceStatus({
    currentStatus: invoice.status,
    dueDate: invoice.dueDate,
    settledAmount,
    totalAmount: invoice.totalAmount,
  });

  if (status !== invoice.status) {
    await InvoiceModel.updateOne({ _id: invoiceId }, { $set: { status } });
  }

  return {
    invoiceId,
    outstanding: Math.max(invoice.totalAmount - settledAmount, 0),
    settledAmount,
    status,
    totalAmount: invoice.totalAmount,
  };
}

/**
 * The invoice's status, derived from its settled total (P3).
 *
 * Never typed by a human. The two statuses that *are* decisions rather than
 * balances — `VOID` and `WRITTEN_OFF` — are returned untouched, because a
 * recomputation must not resurrect an invoice somebody deliberately cancelled.
 *
 * Precedence is PAID → OVERDUE → PARTIAL → OPEN. Overdue outranks partial
 * deliberately: a half-paid invoice that is past its due date is *actionable*,
 * and calling it PARTIAL would hide it from the one list an owner chases.
 */
export function deriveInvoiceStatus(input: {
  currentStatus?: string;
  dueDate?: Date | null;
  now?: Date;
  settledAmount: number;
  totalAmount: number;
}): string {
  if (input.currentStatus === "VOID" || input.currentStatus === "WRITTEN_OFF") {
    return input.currentStatus;
  }

  if (input.settledAmount >= input.totalAmount) {
    return "PAID";
  }

  const now = input.now ?? new Date();
  const overdue = Boolean(input.dueDate && input.dueDate < now);

  if (overdue) {
    return "OVERDUE";
  }

  return input.settledAmount > 0 ? "PARTIAL" : "OPEN";
}
