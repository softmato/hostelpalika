import { Schema, model, models } from "mongoose";

/**
 * One tap of Save on the stock screen (docs/INVENTORY_PLAN.md §3).
 *
 * - **BUY** — goods arrived at `hostelId`. With an amount it also wrote one
 *   `Expense` (`expenseId`), so Money Out is never entered twice.
 * - **SEND** — goods left `hostelId` for `toHostelId`. `PENDING` until the
 *   receiving building taps Got it; each line's `receivedQty` is what actually
 *   came, and the gap is "short".
 * - **COUNT** — what was found left at `hostelId`. Each line's `qty` *sets* the
 *   building's Left; what it found missing is that period's Used.
 *
 * Balances are folded from these rows on every read and never stored, the same
 * rule as the warden cash box. Never deleted: a mistake is `CANCELLED` with a
 * reason, and cancelling a BUY voids its expense.
 *
 * Lines are snapshots (name, unit): renaming an item must not rewrite what was
 * bought last month.
 */

const stockLineSchema = new Schema(
  {
    itemId: { ref: "StockItem", required: true, type: Schema.Types.ObjectId },
    name: { required: true, trim: true, type: String },
    unit: { required: true, type: String },
    qty: { min: 0, required: true, type: Number },
    /** SEND only, set by Got it. */
    receivedQty: { default: null, min: 0, type: Number },
  },
  { _id: false },
);

const stockEntrySchema = new Schema(
  {
    groupHostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    kind: { enum: ["BUY", "SEND", "COUNT"], required: true, type: String },

    /** Where it landed (BUY), where it left from (SEND), where it was counted (COUNT). */
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    toHostelId: { default: null, ref: "Hostel", type: Schema.Types.ObjectId },

    /** Calendar day, UTC midnight of the Nepal day, read in Bikram Sambat. */
    on: { required: true, type: Date },
    lines: { required: true, type: [stockLineSchema] },
    note: { maxlength: 200, trim: true, type: String },

    status: {
      default: "DONE",
      enum: ["DONE", "PENDING", "RECEIVED", "CANCELLED"],
      required: true,
      type: String,
    },

    /** BUY with an amount: the Money Out row it wrote. */
    expenseId: { default: null, ref: "Expense", type: Schema.Types.ObjectId },
    amount: { default: null, min: 0, type: Number },

    recordedBy: { ref: "User", required: true, type: Schema.Types.ObjectId },
    recordedByName: { default: "", trim: true, type: String },

    receivedAt: Date,
    receivedBy: { ref: "User", type: Schema.Types.ObjectId },
    receivedByName: { trim: true, type: String },

    cancelReason: { trim: true, type: String },
    cancelledAt: Date,
    cancelledBy: { ref: "User", type: Schema.Types.ObjectId },

    /** One id per Save tap: a retry returns the entry it already made. */
    clientRequestId: { default: null, trim: true, type: String },
  },
  { timestamps: true },
);

stockEntrySchema.index({ groupHostelId: 1, createdAt: 1 });
stockEntrySchema.index({ groupHostelId: 1, on: -1 });
stockEntrySchema.index(
  { recordedBy: 1, clientRequestId: 1 },
  { partialFilterExpression: { clientRequestId: { $type: "string" } }, unique: true },
);

export const StockEntryModel = models.StockEntry || model("StockEntry", stockEntrySchema);
