import { Schema, model, models } from "mongoose";

import {
  BED_TYPE_VALUES,
  currencyField,
  signedWholeRupees,
  wholeRupees,
} from "@hostel/db/models/finance-fields";

/**
 * What a resident owes for a period (target §4.1).
 *
 * Replaces `Payment` as the obligation record — but only the *obligation* half
 * of it. `Payment` was simultaneously the invoice, the ledger and the balance,
 * with a mutable `paidAmount` that nothing could verify (current §2.1). Here the
 * money lives in `PaymentEvent` and the balance is derived from it.
 *
 * **`paidAmount` deliberately does not exist on this document.** If you find
 * yourself wanting to add it, you want `InvoiceBalance` — which is a cache, and
 * is treated as one.
 */

export const INVOICE_STATUSES = [
  "DRAFT",
  "OPEN",
  "PAID",
  "PARTIAL",
  "OVERDUE",
  "VOID",
  "WRITTEN_OFF",
] as const;

/**
 * Every status that still occupies its period.
 *
 * Derived from the enum rather than written out, so adding a status
 * automatically brings it under the double-billing rule. Listing them by hand
 * would mean a new status silently escapes the unique index — and the failure
 * mode of that is billing a resident twice.
 */
const OCCUPYING_STATUSES = INVOICE_STATUSES.filter(
  (status) => status !== "VOID",
);

const invoiceLineSchema = new Schema(
  {
    description: { type: String, required: true, trim: true },
    /** Null on non-rent lines: admission fees and adjustments have no bed type. */
    bedType: { type: String, enum: [...BED_TYPE_VALUES, null], default: null },
    /** Signed: a credit line is negative (target §9.4). See `signedWholeRupees`. */
    amount: { ...signedWholeRupees, required: true },
    basis: {
      type: String,
      enum: ["SCHEDULE", "OVERRIDE", "MANUAL", "CREDIT", "FINE", "KHATA"],
      required: true,
    },
    /**
     * The late-fine rule this `FINE` line was first charged at — see
     * `late-fine.service`. Snapshotted so a rate the warden changes later moves
     * only the bills that fall late afterwards, never a fine already running.
     */
    fineMode: { type: String, enum: ["PER_DAY_AMOUNT", "PER_DAY_PERCENT"] },
    fineRate: { min: 0, type: Number },
    /**
     * The schedule this line came from, for tracing — **not** for re-deriving.
     * The amount above is snapshotted, so a historical invoice stays correct
     * even if every schedule is later closed or deleted (target §3.3).
     */
    feeScheduleId: { ref: "FeeSchedule", type: Schema.Types.ObjectId },
    /** e.g. "18/31 days" — the resident-facing explanation of a part month. */
    prorationBasis: { type: String, trim: true },
    /**
     * Present only on the negative line a **festival discount** puts on an
     * already-issued invoice — see `rent-concession.service`.
     *
     * It exists to make that one line *findable*. A discount decided after the
     * month was billed is a correction to a bill that has already gone out, and
     * a warden who changes 50% to 40% must move that line rather than add a
     * second one. `basis: "CREDIT"` cannot tell the two apart: an applied credit
     * from an earlier overpayment is also a negative CREDIT line, and matching on
     * the description would break the first time the wording changed.
     *
     * The percentage is stored, not just the flag, because it is the number the
     * line's own words quote. Nothing re-derives the amount from it — the amount
     * is the snapshot, as everywhere else here.
     */
    concessionPercent: { max: 100, min: 1, type: Number },
  },
  { _id: false },
);

const invoiceSchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    residentId: {
      ref: "Resident",
      required: true,
      type: Schema.Types.ObjectId,
    },
    /** "YYYY-MM". Null for one-off invoices that belong to no month. */
    period: { type: String, default: null, trim: true },
    kind: {
      type: String,
      enum: ["MONTHLY_RENT", "ADMISSION_FEE", "DEPOSIT", "ADJUSTMENT", "OTHER"],
      default: "MONTHLY_RENT",
      required: true,
    },
    lines: { type: [invoiceLineSchema], default: [] },
    /** Denormalised sum of `lines`, kept honest by a pre-validate hook below. */
    totalAmount: { ...wholeRupees, required: true },
    currency: currencyField,
    dueDate: { type: Date, required: true },
    issuedAt: { type: Date, default: Date.now },
    /**
     * Derived from the settled event sum, never typed by a human (P3). The one
     * exception is VOID, which is a decision rather than a balance.
     */
    status: {
      type: String,
      enum: INVOICE_STATUSES,
      default: "OPEN",
      required: true,
    },
    /** The code a payment carries to identify this invoice (target §5). */
    referenceCode: { type: String, trim: true, uppercase: true },
    /**
     * The `Payment` row this invoice was migrated from (plan §7.2).
     *
     * Present only on migrated history, and the reason
     * `migrate-finance-ledger.mjs` is safe to re-run: the unique index below
     * makes a second pass a no-op **by construction** rather than by a check the
     * script has to remember. Dropped with `Payment` itself in 2.8.
     */
    legacyPaymentId: {
      ref: "Payment",
      default: null,
      type: Schema.Types.ObjectId,
    },
    /**
     * How far the chase for this invoice has got (plan item 5.2, target §10.3).
     *
     * **Per invoice, not per day.** The job it replaces decided whether to write
     * by comparing today's offset from the due date to an exact number, so a
     * single missed cron run skipped that resident permanently and silently. The
     * stage recorded here turns the question into "has this invoice been chased
     * at this stage yet", which a late run answers correctly.
     *
     * `stage` also carries the ladder's terminator: once it reaches `STOPPED`
     * nothing further is sent automatically, which is the difference between
     * dunning and harassment.
     */
    dunning: {
      lastNotifiedAt: { default: null, type: Date },
      /** How many weekly chases have gone out. Capped — see `dunning.service`. */
      chaseCount: { default: 0, min: 0, type: Number },
      stage: {
        type: String,
        enum: [
          "NONE",
          "REMINDED",
          "OVERDUE_FIRST",
          "OVERDUE_SECOND",
          "CHASING",
          "ESCALATED",
          "STOPPED",
        ],
        default: "NONE",
      },
    },

    /** Staff took the late fine off; the daily fine pass leaves this bill alone. */
    fineWaived: { default: false, type: Boolean },
    voidedAt: Date,
    voidedBy: { ref: "User", type: Schema.Types.ObjectId },
    voidReason: { type: String, trim: true },
    createdBy: { ref: "User", type: Schema.Types.ObjectId },
    updatedBy: { ref: "User", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

/**
 * `totalAmount` is a denormalisation, so it is checked rather than trusted. An
 * invoice whose header disagrees with its own lines is the kind of quiet
 * inconsistency that turns into an unanswerable support question.
 */
invoiceSchema.pre("validate", function checkTotal() {
  const invoice = this as unknown as {
    invalidate(path: string, message: string): void;
    lines?: { amount: number }[];
    totalAmount?: number;
  };

  if (!invoice.lines || invoice.lines.length === 0) {
    return;
  }

  const sum = invoice.lines.reduce(
    (total, line) => total + (line.amount ?? 0),
    0,
  );

  if (invoice.totalAmount !== sum) {
    invoice.invalidate(
      "totalAmount",
      `totalAmount ${invoice.totalAmount} does not equal the sum of lines ${sum}.`,
    );
  }
});

/**
 * The double-billing control (target §4.1).
 *
 * Excludes VOID, so a voided invoice can be reissued for the same period —
 * which is the correction path once the unrestricted PATCH is gone
 * (target §9.2). `period: null` rows are excluded too: one-off invoices are not
 * period-unique, and Mongo would otherwise treat every null as equal.
 *
 * Expressed as `$in` over the occupying statuses rather than the `$ne: "VOID"`
 * the target doc suggests, because **MongoDB rejects `$ne` in a partial filter
 * expression** — the index simply cannot be created that way. `$in` needs
 * MongoDB 5.0 or later; this deployment is on 8.0.
 */
invoiceSchema.index(
  { hostelId: 1, residentId: 1, period: 1, kind: 1 },
  {
    partialFilterExpression: {
      period: { $type: "string" },
      status: { $in: [...OCCUPYING_STATUSES] },
    },
    unique: true,
  },
);

/**
 * One invoice per migrated `Payment`, enforced rather than assumed — a migration
 * that double-writes on its second run would double every historical balance.
 */
invoiceSchema.index(
  { legacyPaymentId: 1 },
  {
    partialFilterExpression: { legacyPaymentId: { $type: "objectId" } },
    unique: true,
  },
);

invoiceSchema.index({ hostelId: 1, status: 1, dueDate: 1 });
invoiceSchema.index({ residentId: 1, status: 1 });
invoiceSchema.index(
  { referenceCode: 1 },
  { partialFilterExpression: { referenceCode: { $type: "string" } } },
);

export const InvoiceModel = models.Invoice || model("Invoice", invoiceSchema);
