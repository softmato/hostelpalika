import { Schema, model, models } from "mongoose";

/**
 * A spending category a hostel added for itself, beside the built-in list in
 * `@hostel/shared/expenses/categories` (docs/EXPENSES_PLAN.md §3.3).
 *
 * Expenses point at it by id, so renaming one renames every row filed under it.
 * Hiding one keeps its rows and their totals; it only stops being offered as a
 * tile.
 */

const hostelExpenseCategorySchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    name: { maxlength: 32, required: true, trim: true, type: String },
    hidden: { default: false, type: Boolean },
    createdBy: { ref: "User", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

hostelExpenseCategorySchema.index({ hostelId: 1, hidden: 1, name: 1 });

export const HostelExpenseCategoryModel =
  models.HostelExpenseCategory ||
  model("HostelExpenseCategory", hostelExpenseCategorySchema);
