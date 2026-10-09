import { Schema, model, models } from "mongoose";

/**
 * One tap of Save on the stock screen (docs/INVENTORY_PLAN.md §3).
 *
 * - **BUY** — goods arrived at `hostelId`. With an amount it also wrote one
 *   `Expense` (`expenseId`), so Money Out is never entered twice.
 * - **SEND** — goods left `hostelId` for `toHostelId`. `PENDING` until the
 *   receiving building taps Got it; each line's `receivedQty` is what actually
 *   came, and the gap is "short".
 * - **OPENING** — what was already on the shelf when the hostel started.
 * - **USE** / **WASTE** — goods that left the store: issued to the kitchen, staff
 *   or a student (`useFor`), or thrown away (`wasteReason`).
 * - **COUNT** — what was found left at `hostelId`. Each line keeps the book's
 *   figure at the time (`systemQty`), and the gap is the adjustment. A warden's
 *   Count is `PENDING` until approved; only then does it move the stock. Old
 *   Counts without `systemQty` *set* the Left at their time.
 *
 * A BUY is the whole bill in one row — lines, supplier, total and what was paid
 * — so saving it is one write: the stock and the supplier's due can never
 * disagree.
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
    /** COUNT only: what the book said at the moment of the count. */
    systemQty: { default: null, type: Number },
    /** How it was entered, when in packs: `2` `SACK` for 50 kg. */
    packQty: { default: null, min: 0, type: Number },
    packUnit: { default: null, type: String },
    /** SEND only, set by Got it. */
    receivedQty: { default: null, min: 0, type: Number },
    /** BUY only: whole rupees per unit, if the bill showed it. */
    rate: { default: null, min: 0, type: Number },
  },
  { _id: false },
);

const stockEntrySchema = new Schema(
  {
    groupHostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    kind: { enum: ["BUY", "OPENING", "USE", "WASTE", "SEND", "COUNT"], required: true, type: String },

    /** Where it landed (BUY), where it left from (SEND), where it was counted (COUNT). */
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    toHostelId: { default: null, ref: "Hostel", type: Schema.Types.ObjectId },

    /** Calendar day, UTC midnight of the Nepal day, read in Bikram Sambat. */
    on: { required: true, type: Date },
    lines: { required: true, type: [stockLineSchema] },
    note: { maxlength: 200, trim: true, type: String },
    /** BUY only: the shop or person it came from, as typed (old bills) or the supplier's name. */
    supplier: { maxlength: 80, trim: true, type: String },
    supplierId: { default: null, ref: "StockSupplier", type: Schema.Types.ObjectId },
    billNo: { maxlength: 40, trim: true, type: String },
    photoAssetId: { default: null, ref: "FileAsset", type: Schema.Types.ObjectId },
    /** BUY: whole rupees. `total` = lines − `discount` + `tax`; `paid` went out on the day. */
    discount: { default: 0, min: 0, type: Number },
    tax: { default: 0, min: 0, type: Number },
    total: { default: null, min: 0, type: Number },
    paid: { default: null, min: 0, type: Number },
    /** USE only. */
    useFor: { default: null, type: String },
    /** WASTE only. */
    wasteReason: { default: null, type: String },

    status: {
      default: "DONE",
      enum: ["DONE", "PENDING", "RECEIVED", "CANCELLED"],
      required: true,
      type: String,
    },

    /** COUNT: who approved it. */
    approvedAt: Date,
    approvedBy: { ref: "User", type: Schema.Types.ObjectId },
    approvedByName: { trim: true, type: String },

    /** BUY with an amount paid: the Money Out row it wrote. `amount` is that row's amount. */
    expenseId: { default: null, ref: "Expense", type: Schema.Types.ObjectId },
    amount: { default: null, min: 0, type: Number },

    recordedBy: { ref: "User", required: true, type: Schema.Types.ObjectId },
    recordedByName: { default: "", trim: true, type: String },
    /** `OWNER`, `WARDEN` or `COOK` — so usage can say who in the hostel entered it. Old rows: `null`. */
    recordedRole: { default: null, type: String },

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
stockEntrySchema.index({ groupHostelId: 1, supplierId: 1, on: -1 });
stockEntrySchema.index(
  { recordedBy: 1, clientRequestId: 1 },
  { partialFilterExpression: { clientRequestId: { $type: "string" } }, unique: true },
);

export const StockEntryModel = models.StockEntry || model("StockEntry", stockEntrySchema);
