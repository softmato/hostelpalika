import { Schema, model, models } from "mongoose";

/**
 * An atomic per-hostel, per-period receipt sequence (target §4.4).
 *
 * Replaces `findOne({receiptNumber: /^prefix/}).sort({receiptNumber: -1})`,
 * which is a race dressed as a query: it works only because of five-digit
 * zero-padding, breaks at 100,000 receipts in a month, and two concurrent
 * approvals read the same "last" number (current §5.5).
 *
 * A single `findOneAndUpdate($inc)` with `upsert` is atomic in MongoDB, so
 * concurrent callers get distinct numbers with no retry loop and no lock.
 *
 * **Per hostel, not global.** Global numbering interleaves one hostel's receipts
 * with another's, and the gaps leak the platform's total monthly volume to any
 * hostel that looks at its own sequence.
 */

const receiptCounterSchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    /**
     * Which sequence this is. `RECEIPT` numbers receipts per period; `REFERENCE`
     * numbers the codes on invoices (target §5.2) and runs for the hostel's
     * lifetime, since a code must never be reissued.
     *
     * One counter model rather than two collections: the mechanism — an atomic
     * `$inc` on a per-hostel row — is identical, and a second copy of it would be
     * a second chance to get the race wrong. `STORE_ORDER` joined on that
     * reasoning rather than by growing a fourth collection — supply orders are
     * numbered per hostel per month, exactly like receipts.
     */
    kind: {
      type: String,
      enum: [
        "RECEIPT",
        "REFERENCE",
        /** A resident's fixed payment code number (`RUP-482K`), per hostel, LIFETIME. */
        "RESIDENT_CODE",
        "STORE_ORDER",
        /**
         * The platform's own invoices and receipts to a hostel, for its plan.
         * They join here on the same reasoning `STORE_ORDER` did — the
         * mechanism is an atomic `$inc` on a per-hostel row, and a second copy
         * of it would be a second chance to get the race wrong.
         *
         * Both run for the hostel's lifetime rather than per month: a
         * subscription document is quoted back years later, and a per-period
         * sequence would reissue the same number every January.
         */
        "SUBSCRIPTION_INVOICE",
        "SUBSCRIPTION_RECEIPT",
      ],
      default: "RECEIPT",
      required: true,
    },
    /**
     * "YYYY-MM" or a fiscal-year label — whatever the number format quotes.
     * `REFERENCE` uses the constant `LIFETIME`, because a per-period reference
     * sequence would reissue `RUP-0001-x` every January.
     */
    period: { type: String, required: true, trim: true },
    /** Last issued value. The next number is this + 1. */
    sequence: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

receiptCounterSchema.index({ hostelId: 1, kind: 1, period: 1 }, { unique: true });

export const ReceiptCounterModel =
  models.ReceiptCounter || model("ReceiptCounter", receiptCounterSchema);
