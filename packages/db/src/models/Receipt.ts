import { Schema, model, models } from "mongoose";

import { FinanceModelError } from "@hostel/db/models/finance-fields";

/**
 * Proof that money was received (target §4.4).
 *
 * **One receipt per settled `PaymentEvent`**, not one per month. The old rule —
 * one per `Payment`, amended in place every time more money arrived — meant a
 * resident who paid in two instalments held a document that had silently changed
 * since they downloaded it, and there was no record of what it used to say.
 *
 * A receipt is therefore **immutable**. A wrong one is voided and reissued, and
 * both stay readable: the void carries a reason and the reissue points back at
 * what it replaced. That is what makes a receipt evidence rather than a view.
 *
 * `paymentId` and `month` are the legacy fields, kept nullable through the
 * expand phase so the old approval path keeps working until 2.8 deletes it
 * (ADR-8). New receipts set `eventId` and `invoiceId`.
 */

const receiptSchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    residentId: { ref: "Resident", required: true, type: Schema.Types.ObjectId },

    /** The settled event this receipts. One receipt per event, enforced below. */
    eventId: { ref: "PaymentEvent", default: null, type: Schema.Types.ObjectId },
    invoiceId: { ref: "Invoice", default: null, type: Schema.Types.ObjectId },

    /** Legacy. Removed with `Payment` in 2.8. */
    paymentId: { ref: "Payment", default: null, type: Schema.Types.ObjectId },
    month: { default: null, trim: true, type: String },

    receiptNumber: { required: true, trim: true, type: String },
    issuedAt: { default: Date.now, type: Date },
    /** Null when a scheduled job issued it — no human did, and saying so is honest. */
    issuedBy: { ref: "User", default: null, type: Schema.Types.ObjectId },
    amount: { min: 0, required: true, type: Number },

    /**
     * Resident Offer Program certification. Set at issue, only when the payment
     * quoted its invoice's reference code and the hostel (or the gateway, or the
     * hostel's own statement) verified it. Random, not sequential: the receipt
     * number can be guessed, this cannot, so it is what `/verify-receipt` looks
     * up and what makes a printed receipt checkable by anyone holding it.
     */
    certificationCode: { default: null, trim: true, type: String, uppercase: true },
    certifiedAt: { default: null, type: Date },

    voidedAt: { default: null, type: Date },
    voidedBy: { ref: "User", default: null, type: Schema.Types.ObjectId },
    voidReason: { default: null, trim: true, type: String },
    /** Set on the voided receipt, pointing at the one issued in its place. */
    replacedByReceiptId: {
      ref: "Receipt",
      default: null,
      type: Schema.Types.ObjectId,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

/**
 * What a receipt asserts. Changing any of these rewrites a document somebody may
 * already have downloaded, printed, or handed to a landlord.
 */
export const FROZEN_RECEIPT_FIELDS = [
  "amount",
  "certificationCode",
  "eventId",
  "invoiceId",
  "receiptNumber",
  "residentId",
] as const;

/**
 * Whether an update would rewrite what a receipt asserts.
 *
 * Pure and exported so the rule is testable without a database. Voiding is not a
 * rewrite: it touches `voidedAt`, `voidedBy`, `voidReason` and
 * `replacedByReceiptId`, none of which change what the receipt said.
 */
export function receiptUpdateViolatesImmutability(
  update: Record<string, unknown> | null,
): boolean {
  if (!update) {
    return false;
  }

  const assignments = {
    ...(update as Record<string, Record<string, unknown>>).$set,
    ...(update as Record<string, Record<string, unknown>>).$inc,
    ...Object.fromEntries(
      Object.entries(update).filter(([key]) => !key.startsWith("$")),
    ),
  };

  return FROZEN_RECEIPT_FIELDS.some((field) => field in assignments);
}

function immutabilityError() {
  return new FinanceModelError(
    "A receipt cannot be modified. Void it and issue a replacement instead.",
    "RECEIPT_IMMUTABLE",
    500,
  );
}

/**
 * Enforced at the model layer, like ADR-2's event guard and for the same reason:
 * service-layer enforcement is defeated by one forgotten `updateOne` in a future
 * feature. Reaching this is a bug, never a user error, hence a 500.
 */
receiptSchema.pre("save", function guardReceipt() {
  const receipt = this as unknown as { isNew: boolean; modifiedPaths(): string[] };

  if (receipt.isNew) {
    return;
  }

  const touched = receipt
    .modifiedPaths()
    .filter((path) =>
      FROZEN_RECEIPT_FIELDS.includes(path as (typeof FROZEN_RECEIPT_FIELDS)[number]),
    );

  if (touched.length > 0) {
    throw immutabilityError();
  }
});

function guardUpdate(this: { getUpdate(): Record<string, unknown> | null }) {
  if (receiptUpdateViolatesImmutability(this.getUpdate())) {
    throw immutabilityError();
  }
}

receiptSchema.pre("findOneAndUpdate", guardUpdate);
receiptSchema.pre("updateOne", guardUpdate);
receiptSchema.pre("updateMany", guardUpdate);

receiptSchema.index({ hostelId: 1, residentId: 1, paymentId: 1 });
receiptSchema.index({ receiptNumber: 1 }, { unique: true });

/**
 * One receipt per settled event (invariant 6).
 *
 * Partial on `eventId` so legacy receipts, which have none, do not all collide
 * on null. A double-issue is a duplicate-key error rather than two documents
 * claiming the same money.
 */
receiptSchema.index(
  { eventId: 1 },
  {
    partialFilterExpression: { eventId: { $type: "objectId" } },
    unique: true,
  },
);

receiptSchema.index({ hostelId: 1, issuedAt: -1 });

/** Receipts of a set of invoices: the resident invoice page and the ledger drift check (P10-2). */
receiptSchema.index({ invoiceId: 1 });

/** One document per code, and the quarter's eligibility scan. */
receiptSchema.index(
  { certificationCode: 1 },
  { partialFilterExpression: { certificationCode: { $type: "string" } }, unique: true },
);
receiptSchema.index(
  { certifiedAt: 1, residentId: 1 },
  { partialFilterExpression: { certificationCode: { $type: "string" } } },
);

export const ReceiptModel = models.Receipt || model("Receipt", receiptSchema);
