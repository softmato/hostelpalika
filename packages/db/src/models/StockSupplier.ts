import { Schema, model, models } from "mongoose";

/**
 * A shop or person a hostel buys stock from (docs/INVENTORY_PLAN.md §3).
 *
 * Owned by the **group** (`groupHostelId` is the main hostel's id), like the
 * items: the main hostel and its branches buy from the same rice shop and owe
 * it one balance.
 *
 * What the hostel owes is never stored. It is folded from `openingDue`, the
 * bills (`StockEntry` BUY: `total − paid`) and the payments (`StockPayment`),
 * so it can always be rebuilt and never drifts.
 */

const stockSupplierSchema = new Schema(
  {
    groupHostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },

    name: { maxlength: 60, required: true, trim: true, type: String },
    phone: { maxlength: 20, trim: true, type: String },
    /** Owed to this supplier before the hostel started using Stock. Whole rupees. */
    openingDue: { default: 0, type: Number },
    note: { maxlength: 200, trim: true, type: String },
    active: { default: true, type: Boolean },

    createdBy: { ref: "User", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

stockSupplierSchema.index({ groupHostelId: 1, active: -1, name: 1 });

export const StockSupplierModel = models.StockSupplier || model("StockSupplier", stockSupplierSchema);
