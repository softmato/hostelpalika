import { Schema, model, models } from "mongoose";

/**
 * One thing a hostel keeps in stock — "Rice", "Daal", "Pressure cooker"
 * (docs/INVENTORY_PLAN.md).
 *
 * Owned by the **group**, not a building: `groupHostelId` is the main hostel's
 * id, so the main hostel and every branch count the same Rice. Never deleted —
 * an item nobody buys any more is switched off, and its entries keep its name
 * as a snapshot anyway.
 */

const stockItemSchema = new Schema(
  {
    groupHostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },

    name: { maxlength: 40, required: true, trim: true, type: String },
    /** A key from `@hostel/shared/expenses/stock` `STOCK_UNITS`. */
    unit: { required: true, type: String },
    kind: { default: "STORE", enum: ["STORE", "DAILY"], required: true, type: String },
    /** A built-in expense category key the Bought amount is filed under. */
    category: { default: "GROCERIES", type: String },
    /** A building's Left below this is shown as low. `null` never warns. */
    lowAt: { default: null, min: 0, type: Number },
    active: { default: true, type: Boolean },

    createdBy: { ref: "User", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

stockItemSchema.index({ groupHostelId: 1, active: -1, name: 1 });

export const StockItemModel = models.StockItem || model("StockItem", stockItemSchema);
