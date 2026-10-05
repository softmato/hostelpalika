import { Schema, model, models } from "mongoose";

import { currencyField, positiveWholeRupees } from "./finance-fields";

/**
 * Money that left the hostel (docs/EXPENSES_PLAN.md §4).
 *
 * **Not a `PaymentEvent`.** That collection is the residents' invoice ledger and
 * its conservation rule — an invoice's balance is its settled credits minus its
 * settled debits — must never see a sack of rice. Hostel spending lives here,
 * beside it, and the two meet only in the month card's *In · Out · Left*.
 *
 * - **Never deleted.** A mistake is voided with a reason, the same principle as
 *   a payment reversal (target §9.3). A void is visible to the owner, so a
 *   wrong entry and its correction both stay on the record.
 * - **`spentOn` is a calendar day**, stored as UTC midnight of the Nepal day like
 *   every other day field here, and read in Bikram Sambat on every screen.
 * - **`payer` is who the money came from.** `HOSTEL` when the owner records it;
 *   `STAFF` when a warden or the cook does — paid from the cash the owner gave
 *   them, or from their own pocket. Their cash box is derived from these rows
 *   rather than kept as a number that can drift.
 * - **`recordedByName` is a snapshot.** The cook login can be a phone the kitchen
 *   passes around (cook_app_portal.md §0), and the name on a row has to stay
 *   what it was when the row was written.
 */

const expenseSchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },

    amount: { ...positiveWholeRupees, required: true },
    currency: currencyField,
    spentOn: { required: true, type: Date },

    /** A built-in key from `@hostel/shared/expenses/categories`, or `CUSTOM`. */
    category: { required: true, trim: true, type: String },
    /** Set only when `category` is `CUSTOM`. */
    customCategoryId: {
      default: null,
      ref: "HostelExpenseCategory",
      type: Schema.Types.ObjectId,
    },
    /** One short phrase — "Rice 25 kg". */
    what: { default: "", maxlength: 120, trim: true, type: String },
    /** For `SALARY` only: whose salary. `userId` is empty for someone without an account. */
    salaryFor: {
      default: null,
      type: new Schema(
        {
          name: { maxlength: 120, required: true, trim: true, type: String },
          userId: { default: null, ref: "User", type: Schema.Types.ObjectId },
        },
        { _id: false },
      ),
    },

    /**
     * For `STAFF_CASH` only: the warden the owner handed money to. The warden
     * confirms it (`cashStatus`) before it counts in their cash box, so an owner
     * cannot fill a box the warden never received. `name` is a snapshot.
     */
    cashTo: {
      default: null,
      type: new Schema(
        {
          name: { maxlength: 120, required: true, trim: true, type: String },
          userId: { ref: "User", required: true, type: Schema.Types.ObjectId },
        },
        { _id: false },
      ),
    },
    cashStatus: { default: null, enum: ["PENDING", "ACCEPTED", "DECLINED", null], type: String },
    cashRespondedAt: Date,
    /** The warden's words when they say they did not get it. */
    cashNote: { maxlength: 300, trim: true, type: String },

    paidBy: {
      default: "CASH",
      enum: ["CASH", "ESEWA", "KHALTI", "BANK"],
      required: true,
      type: String,
    },
    payer: { default: "HOSTEL", enum: ["HOSTEL", "STAFF"], required: true, type: String },

    photoAssetId: { default: null, ref: "FileAsset", type: Schema.Types.ObjectId },

    recordedBy: { ref: "User", required: true, type: Schema.Types.ObjectId },
    recordedByRole: {
      enum: ["HOSTEL_ADMIN", "WARDEN", "COOK"],
      required: true,
      type: String,
    },
    recordedByName: { default: "", trim: true, type: String },

    /** How the row came in. Only `MANUAL` exists today; the plan adds the rest. */
    source: {
      default: "MANUAL",
      enum: ["MANUAL", "SHARED_RECEIPT", "PAYMENT_NUDGE", "MAINTENANCE"],
      type: String,
    },

    /**
     * Set by the client once per Save tap, so a retry after a dropped
     * connection returns the row it already made instead of adding it twice.
     */
    clientRequestId: { default: null, trim: true, type: String },

    status: { default: "RECORDED", enum: ["RECORDED", "VOID"], required: true, type: String },
    voidReason: { trim: true, type: String },
    voidedAt: Date,
    voidedBy: { ref: "User", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

expenseSchema.index({ hostelId: 1, status: 1, spentOn: -1 });
expenseSchema.index({ hostelId: 1, recordedBy: 1, spentOn: -1 });
// A warden's cash box: what was handed to them.
expenseSchema.index(
  { hostelId: 1, "cashTo.userId": 1, spentOn: -1 },
  { partialFilterExpression: { category: "STAFF_CASH" } },
);
expenseSchema.index(
  { hostelId: 1, recordedBy: 1, clientRequestId: 1 },
  { partialFilterExpression: { clientRequestId: { $type: "string" } }, unique: true },
);

export const ExpenseModel = models.Expense || model("Expense", expenseSchema);
