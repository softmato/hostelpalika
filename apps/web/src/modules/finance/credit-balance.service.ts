import { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import { assertWholeRupees } from "@/modules/finance/money";
import {
  computeCreditAmount,
  CreditBalanceModel,
} from "@hostel/db/models/CreditBalance";

/**
 * Credit balances (target §9.4, plan item 5.3).
 *
 * The rule this module enforces is one sentence long: **an event whose amount
 * exceeds the invoice's outstanding balance settles in full, and the excess
 * becomes credit.** What it replaces was `Math.min(paid + verified, dueAmount)`
 * — a clamp that made 15,000 against a 12,000 invoice indistinguishable from a
 * 12,000 payment, with no record anywhere that 3,000 had arrived. Deleted in
 * Block 2; this gives the excess the place it should have gone.
 *
 * Two properties, both structural rather than remembered:
 *
 * - **Every entry is idempotent.** The key is derived from what caused it
 *   (`overpay:{eventId}`, `apply:{invoiceId}`), and a unique index refuses a
 *   second entry with the same key. Crediting the same overpayment twice is not
 *   a bug this code has to avoid; it is a write the database rejects.
 * - **`amount` is recomputed from the entries**, never incremented, so a retry
 *   that half-succeeded leaves a detectable state rather than a plausible wrong
 *   number (P3, ADR-3).
 */

export type CreditEntryKind = "APPLIED" | "EARNED" | "REFUNDED";

export type CreditBalanceView = {
  amount: number;
  entries: {
    amount: number;
    invoiceId: string | null;
    kind: CreditEntryKind;
    note: string | null;
    occurredAt: Date;
  }[];
  residentId: string;
};

/** Mongo's duplicate-key error — here, an entry key that already exists. */
function isDuplicateKey(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { code?: number }).code === 11000,
  );
}

/**
 * Appends an entry and recomputes the balance.
 *
 * Returns `false` when the entry already existed, so callers can tell a genuine
 * credit from a replay without a read-then-write race of their own — the same
 * contract `appendEvent` has, for the same reason.
 */
async function appendEntry(input: {
  amount: number;
  eventId?: Types.ObjectId | string | null;
  hostelId: Types.ObjectId | string;
  idempotencyKey: string;
  invoiceId?: Types.ObjectId | string | null;
  kind: CreditEntryKind;
  note?: string;
  occurredAt?: Date;
  residentId: Types.ObjectId | string;
}): Promise<{ amount: number; created: boolean }> {
  await connectToDatabase();

  assertWholeRupees(input.amount, "credit amount");

  if (input.amount <= 0) {
    throw new FinanceServiceError(
      "A credit entry must move a positive amount.",
      "AMOUNT_OUT_OF_BOUNDS",
    );
  }

  try {
    await CreditBalanceModel.updateOne(
      { hostelId: input.hostelId, residentId: input.residentId },
      {
        $push: {
          entries: {
            amount: input.amount,
            eventId: input.eventId ?? null,
            idempotencyKey: input.idempotencyKey,
            invoiceId: input.invoiceId ?? null,
            kind: input.kind,
            note: input.note,
            occurredAt: input.occurredAt ?? new Date(),
          },
        },
        $setOnInsert: { hostelId: input.hostelId, residentId: input.residentId },
      },
      { upsert: true },
    );
  } catch (error) {
    if (!isDuplicateKey(error)) {
      throw error;
    }

    // The key already exists: this exact credit was already recorded. Return the
    // balance as it stands rather than treating a replay as a failure.
    return { amount: await recomputeCreditBalance(input.hostelId, input.residentId), created: false };
  }

  return {
    amount: await recomputeCreditBalance(input.hostelId, input.residentId),
    created: true,
  };
}

/**
 * Rebuilds `amount` from the entries.
 *
 * Written from scratch each time rather than incremented — an increment can
 * drift, a recomputation cannot — which is the same argument that governs
 * `recomputeInvoiceBalance`, and the reason both can be audited the same way.
 */
export async function recomputeCreditBalance(
  hostelId: Types.ObjectId | string,
  residentId: Types.ObjectId | string,
): Promise<number> {
  await connectToDatabase();

  const balance = await CreditBalanceModel.findOne({ hostelId, residentId }).lean<{
    entries?: { amount: number; kind: string }[];
  } | null>();

  const amount = computeCreditAmount(balance?.entries ?? []);

  await CreditBalanceModel.updateOne(
    { hostelId, residentId },
    { $set: { amount, lastComputedAt: new Date() } },
  );

  return amount;
}

/**
 * Records the change from an overpayment (target §9.4).
 *
 * Called after the invoice balance is recomputed, so `excess` is measured
 * against a settled total rather than a predicted one. Idempotent on the event,
 * which is what makes the crash-and-resume path this ledger deliberately allows
 * unable to credit the same money twice.
 */
export async function creditOverpayment(input: {
  eventId: Types.ObjectId | string;
  excess: number;
  hostelId: Types.ObjectId | string;
  invoiceId: Types.ObjectId | string;
  occurredAt?: Date;
  residentId: Types.ObjectId | string;
}): Promise<{ amount: number; created: boolean }> {
  return appendEntry({
    amount: input.excess,
    eventId: input.eventId,
    hostelId: input.hostelId,
    idempotencyKey: `overpay:${input.eventId.toString()}`,
    invoiceId: input.invoiceId,
    kind: "EARNED",
    note: "Overpayment carried forward",
    occurredAt: input.occurredAt,
    residentId: input.residentId,
  });
}

/**
 * Consumes credit for a new invoice, returning what was actually applied.
 *
 * **Reserved before the invoice exists, not after.** Billing asks for an amount,
 * gets back what it may use, and only then writes the invoice line — so a crash
 * between the two leaves credit consumed with no invoice to show for it, which
 * the drift job can see, rather than an invoice discounted against credit that
 * was never deducted, which nothing could.
 */
export async function applyCreditToInvoice(input: {
  hostelId: Types.ObjectId | string;
  invoiceId: Types.ObjectId | string;
  /** Never applies more than this — an invoice cannot go negative. */
  maxAmount: number;
  residentId: Types.ObjectId | string;
}): Promise<number> {
  await connectToDatabase();

  const available = await getCreditAmount(input.hostelId, input.residentId);
  const applied = Math.min(available, Math.max(0, Math.floor(input.maxAmount)));

  if (applied <= 0) {
    return 0;
  }

  const { created } = await appendEntry({
    amount: applied,
    hostelId: input.hostelId,
    idempotencyKey: `apply:${input.invoiceId.toString()}`,
    invoiceId: input.invoiceId,
    kind: "APPLIED",
    note: "Applied to invoice",
    residentId: input.residentId,
  });

  // A replay means this invoice already consumed credit — the caller is
  // re-running a billing cycle, and billing it a second discount would be the
  // mirror image of double-billing.
  return created ? applied : 0;
}

/**
 * The credit a **festival discount** left behind on an invoice already paid.
 *
 * ## Why this one is replaced rather than appended
 *
 * Every other entry in this ledger is append-only and keyed by the thing that
 * caused it, because every other cause happens once: an overpayment arrives, a
 * credit is consumed. A discount is different — it is a *decision*, and a warden
 * who sets Kartik to 50% and then to 40% has corrected one decision, not made
 * two. Appended, that would credit the resident 4,000 and then a further 3,200
 * for a single 8,000 rent.
 *
 * So the entry keyed `concession:{invoiceId}` is pulled and re-pushed. That is
 * the one place in this module where an entry is rewritten, and it is safe for the
 * same reason the recomputation below is: `amount` is rebuilt from the entries
 * afterwards, so the balance cannot drift out of step with what caused it.
 *
 * `amount: 0` removes the entry and credits nothing — the shape a discount being
 * withdrawn takes.
 */
export async function setConcessionCredit(input: {
  amount: number;
  hostelId: Types.ObjectId | string;
  invoiceId: Types.ObjectId | string;
  /** One credit per (kind, invoice); a second call replaces it. Defaults to the festival discount's. */
  kind?: string;
  note: string;
  residentId: Types.ObjectId | string;
}): Promise<number> {
  await connectToDatabase();

  assertWholeRupees(input.amount, "concession credit");

  const idempotencyKey = `${input.kind ?? "concession"}:${input.invoiceId.toString()}`;

  await CreditBalanceModel.updateOne(
    { hostelId: input.hostelId, residentId: input.residentId },
    { $pull: { entries: { idempotencyKey } } },
  );

  if (input.amount > 0) {
    await CreditBalanceModel.updateOne(
      { hostelId: input.hostelId, residentId: input.residentId },
      {
        $push: {
          entries: {
            amount: input.amount,
            eventId: null,
            idempotencyKey,
            invoiceId: input.invoiceId,
            kind: "EARNED",
            note: input.note,
            occurredAt: new Date(),
          },
        },
        $setOnInsert: { hostelId: input.hostelId, residentId: input.residentId },
      },
      { upsert: true },
    );
  }

  return recomputeCreditBalance(input.hostelId, input.residentId);
}

export async function getCreditAmount(
  hostelId: Types.ObjectId | string,
  residentId: Types.ObjectId | string,
): Promise<number> {
  await connectToDatabase();

  const balance = await CreditBalanceModel.findOne({ hostelId, residentId })
    .select("amount")
    .lean<{ amount?: number } | null>();

  return balance?.amount ?? 0;
}

/** The resident's own view: how much, and where it came from. */
export async function getCreditBalance(
  hostelId: Types.ObjectId | string,
  residentId: Types.ObjectId | string,
): Promise<CreditBalanceView> {
  await connectToDatabase();

  const balance = await CreditBalanceModel.findOne({ hostelId, residentId }).lean<{
    amount?: number;
    entries?: {
      amount: number;
      invoiceId?: Types.ObjectId | null;
      kind: CreditEntryKind;
      note?: string;
      occurredAt: Date;
    }[];
  } | null>();

  return {
    amount: balance?.amount ?? 0,
    entries: (balance?.entries ?? [])
      .slice()
      .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
      .slice(0, 20)
      .map((entry) => ({
        amount: entry.amount,
        invoiceId: entry.invoiceId?.toString() ?? null,
        kind: entry.kind,
        note: entry.note ?? null,
        occurredAt: entry.occurredAt,
      })),
    residentId: residentId.toString(),
  };
}
