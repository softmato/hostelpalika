import { Schema, model, models } from "mongoose";

/**
 * Money paid to a supplier against what the hostel owes them
 * (docs/INVENTORY_PLAN.md §3).
 *
 * Each payment also writes one ordinary `Expense` (`expenseId`) in the building
 * it was paid from, so Money Out, the warden's cash box and the owner's
 * statement see it like any other spend. A bill's part paid on the day is on
 * the bill itself (`StockEntry.paid`); this is for paying later.
 *
 * Never deleted: a mistake is `CANCELLED` with a reason, and its expense is
 * voided with it.
 */

const stockPaymentSchema = new Schema(
  {
    groupHostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    /** The building it was paid from. */
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    supplierId: { ref: "StockSupplier", required: true, type: Schema.Types.ObjectId },

    amount: { min: 1, required: true, type: Number },
    /** Calendar day, UTC midnight of the Nepal day. */
    on: { required: true, type: Date },
    paidBy: { default: "CASH", type: String },
    note: { maxlength: 200, trim: true, type: String },
    /** Bills this payment was meant for. Informational: the balance is per supplier. */
    entryIds: { default: [], type: [{ ref: "StockEntry", type: Schema.Types.ObjectId }] },

    expenseId: { default: null, ref: "Expense", type: Schema.Types.ObjectId },
    status: { default: "DONE", enum: ["DONE", "CANCELLED"], required: true, type: String },

    recordedBy: { ref: "User", required: true, type: Schema.Types.ObjectId },
    recordedByName: { default: "", trim: true, type: String },

    cancelReason: { trim: true, type: String },
    cancelledAt: Date,
    cancelledBy: { ref: "User", type: Schema.Types.ObjectId },

    /** One id per Save tap: a retry returns the payment it already made. */
    clientRequestId: { default: null, trim: true, type: String },
  },
  { timestamps: true },
);

stockPaymentSchema.index({ groupHostelId: 1, supplierId: 1, on: -1 });
stockPaymentSchema.index(
  { recordedBy: 1, clientRequestId: 1 },
  { partialFilterExpression: { clientRequestId: { $type: "string" } }, unique: true },
);

export const StockPaymentModel = models.StockPayment || model("StockPayment", stockPaymentSchema);
