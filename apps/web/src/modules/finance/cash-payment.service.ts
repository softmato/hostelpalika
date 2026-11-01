import type { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import { assertWholeRupees } from "@/modules/finance/money";
import { appendEvent, settleEvent } from "@/modules/finance/payment-event.service";
import type { InvoiceBalanceResult } from "@/modules/finance/payment-event.service";
import type { ReceiptRecord } from "@/modules/finance/receipt.service";
import { HostelPaymentProfileModel } from "@hostel/db/models/HostelPaymentProfile";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { PaymentEventModel } from "@hostel/db/models/PaymentEvent";

/**
 * Cash, recorded properly (target §9.1, plan item 2.7).
 *
 * Cash is the one payment method with no external record — no gateway, no
 * statement line, no screenshot. Everything that makes it trustworthy has to be
 * built here, and the current system builds none of it: cash arrives through the
 * unrestricted `PATCH`, where an admin types a `paidAmount` and the record says
 * only that it changed.
 *
 * Three things make a cash entry answerable:
 *
 * 1. **A named collector.** `collectedBy` is who physically took the money,
 *    which is frequently not the person at the keyboard. Recording only the
 *    latter names the wrong human when the count is short.
 * 2. **A required `cashReceiptNumber`.** The hostel's paper book is the other
 *    half of the record, and it is what an audit reconciles against. It also
 *    forms the idempotency key, so re-submitting the same slip is a no-op by
 *    construction rather than a second credit.
 * 3. **Maker-checker above a threshold.** Above the hostel's
 *    `cashApprovalThreshold` the entry lands `PENDING` and a *different* person
 *    has to settle it. One person who can both record and confirm large cash is
 *    the entire control failure this replaces.
 */

export const DEFAULT_CASH_APPROVAL_THRESHOLD = 20000;

export type RecordCashInput = {
  amount: number;
  /** The hostel's paper receipt number. Required, and part of the idempotency key. */
  cashReceiptNumber: string;
  /** Who physically took the money — not necessarily who is typing. */
  collectedBy: string;
  invoiceId: Types.ObjectId | string;
  method?: "CASH" | "ESEWA" | "KHALTI" | "BANK";
  note?: string;
  receivedAt?: Date;
};

export type RecordCashResult = {
  balance: InvoiceBalanceResult | null;
  eventId: string;
  /** True when maker-checker held it for a second approver. */
  pendingApproval: boolean;
  receipt: ReceiptRecord | null;
};

async function cashThresholdFor(hostelId: Types.ObjectId | string): Promise<number> {
  const profile = await HostelPaymentProfileModel.findOne({ hostelId })
    .select("cashApprovalThreshold")
    .lean<{ cashApprovalThreshold?: number } | null>();

  return profile?.cashApprovalThreshold ?? DEFAULT_CASH_APPROVAL_THRESHOLD;
}

export async function recordCashPayment(
  input: RecordCashInput,
  principal: ApiPrincipal,
): Promise<RecordCashResult> {
  await connectToDatabase();

  assertWholeRupees(input.amount, "cash amount");

  if (input.amount <= 0) {
    throw new FinanceServiceError(
      "A cash payment must be greater than zero.",
      "AMOUNT_OUT_OF_BOUNDS",
    );
  }

  if (!input.cashReceiptNumber?.trim()) {
    throw new FinanceServiceError(
      "A cash receipt number is required.",
      "AMOUNT_OUT_OF_BOUNDS",
    );
  }

  if (!input.collectedBy?.trim()) {
    throw new FinanceServiceError(
      "Record who collected the cash.",
      "AMOUNT_OUT_OF_BOUNDS",
    );
  }

  // Scoped to the caller's hostels: this looked up any hostel's invoice by id.
  const invoice = await InvoiceModel.findOne({
    _id: input.invoiceId,
    hostelId: { $in: principal.hostelIds },
  }).lean<{
    _id: Types.ObjectId;
    hostelId: Types.ObjectId;
    residentId: Types.ObjectId;
    status: string;
  } | null>();

  if (!invoice) {
    throw new FinanceServiceError("Invoice was not found.", "INVOICE_NOT_FOUND");
  }

  if (invoice.status === "VOID") {
    throw new FinanceServiceError(
      "This invoice was voided and cannot take a payment.",
      "AMOUNT_OUT_OF_BOUNDS",
    );
  }

  const threshold = await cashThresholdFor(invoice.hostelId);
  const needsSecondApprover = input.amount > threshold;

  const { created, event } = await appendEvent({
    amount: input.amount,
    confirmation: "MANUAL_REVIEW",
    hostelId: invoice.hostelId,
    // `cash:{hostelId}:{cashReceiptNumber}` (§5.2). The paper slip is the
    // natural key: entering it twice is the same money, not two payments.
    idempotencyKey: `cash:${invoice.hostelId.toString()}:${input.cashReceiptNumber.trim()}`,
    invoiceId: invoice._id,
    occurredAt: input.receivedAt ?? new Date(),
    provider: input.method ?? "CASH",
    rawPayload: {
      cashReceiptNumber: input.cashReceiptNumber.trim(),
      collectedBy: input.collectedBy.trim(),
      note: input.note ?? null,
      recordedBy: principal.userId?.toString(),
    },
    residentId: invoice.residentId,
    source: "CASH_ENTRY",
    status: "PENDING",
  });

  if (!created) {
    // The same slip was already entered. Return what exists rather than
    // crediting the invoice a second time.
    return {
      balance: null,
      eventId: event._id.toString(),
      pendingApproval: event.status === "PENDING",
      receipt: null,
    };
  }

  if (needsSecondApprover) {
    return {
      balance: null,
      eventId: event._id.toString(),
      pendingApproval: true,
      receipt: null,
    };
  }

  const settled = await settleEvent(event._id, {
    confirmation: "MANUAL_REVIEW",
    principal,
  });

  return {
    balance: settled.balance,
    eventId: event._id.toString(),
    pendingApproval: false,
    receipt: settled.receipt,
  };
}

/**
 * The second half of maker-checker: someone else confirms a large cash entry.
 *
 * The approver must not be the person who recorded it. That check is the only
 * thing the threshold buys — without it the "second approver" is the same
 * person clicking twice, which is exactly the control this replaces.
 */
export async function approveCashPayment(
  eventId: Types.ObjectId | string,
  principal: ApiPrincipal,
): Promise<{ balance: InvoiceBalanceResult | null; receipt: ReceiptRecord | null }> {
  await connectToDatabase();

  const event = await PaymentEventModel.findOne({
    _id: eventId,
    source: "CASH_ENTRY",
  }).lean<{ rawPayload?: { recordedBy?: string }; status: string } | null>();

  if (!event) {
    throw new FinanceServiceError(
      "Cash entry was not found.",
      "FEE_SCHEDULE_MISSING",
    );
  }

  if (event.status !== "PENDING") {
    throw new FinanceServiceError(
      "This cash entry is no longer pending.",
      "SETTLED_EVENT_IMMUTABLE",
    );
  }

  if (event.rawPayload?.recordedBy === principal.userId?.toString()) {
    throw new FinanceServiceError(
      "Cash above the approval threshold must be confirmed by someone else.",
      "SECOND_APPROVER_REQUIRED",
    );
  }

  const settled = await settleEvent(eventId, {
    confirmation: "MANUAL_REVIEW",
    principal,
  });

  return { balance: settled.balance, receipt: settled.receipt };
}
