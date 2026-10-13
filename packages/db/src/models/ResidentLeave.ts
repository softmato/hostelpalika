import { Schema, model, models } from "mongoose";

/**
 * Days a resident was away — home for Dashain, a holiday — and what came off
 * their rent for it (docs/FIELD_FIXES_2026_10.md §9).
 *
 * The rule (food only, or the full day) is snapshotted here when the days are
 * saved, so changing the hostel's setting later never rewrites an old bill.
 * The money lands as one `LEAVE` line on the bill for `period`; `invoiceId`
 * says which. Cancelling takes the line off again.
 */
const residentLeaveSchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    residentId: { ref: "Resident", required: true, type: Schema.Types.ObjectId },
    /** First and last day away, Nepal days at 00:00 UTC. */
    from: { required: true, type: Date },
    to: { required: true, type: Date },
    days: { min: 1, required: true, type: Number },
    /** The BS month the days fall in; a stay away is kept inside one month. */
    period: { required: true, trim: true, type: String },
    mode: { enum: ["FOOD", "FULL_DAY"], required: true, type: String },
    /** Whole rupees off. */
    amount: { min: 0, required: true, type: Number },
    note: { maxlength: 200, trim: true, type: String },
    status: { default: "ACTIVE", enum: ["ACTIVE", "CANCELLED"], type: String },
    invoiceId: { default: null, ref: "Invoice", type: Schema.Types.ObjectId },
    createdBy: { ref: "User", type: Schema.Types.ObjectId },
    cancelledBy: { ref: "User", type: Schema.Types.ObjectId },
    cancelledAt: Date,
  },
  { timestamps: true },
);

residentLeaveSchema.index({ hostelId: 1, residentId: 1, period: 1 });

export const ResidentLeaveModel =
  models.ResidentLeave || model("ResidentLeave", residentLeaveSchema);
