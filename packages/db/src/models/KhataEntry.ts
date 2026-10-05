import { Schema, model, models } from "mongoose";

import { wholeRupees } from "@hostel/db/models/finance-fields";

/**
 * One thing a resident asked for on khata — two eggs, a laundry load.
 *
 * `REQUESTED` until the cook (or staff) hands it over (`GIVEN`, now owed) or
 * says it is not available (`DECLINED`). The resident may `CANCELLED` it while
 * it waits. Name and price are snapshotted: renaming or repricing an item later
 * never changes what was already taken.
 *
 * `invoiceId` is set when a `GIVEN` entry lands on a rent bill, which is what
 * keeps it from being billed twice; voiding that bill clears it again.
 */
const khataEntrySchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    residentId: { ref: "Resident", required: true, type: Schema.Types.ObjectId },
    itemId: { required: true, type: Schema.Types.ObjectId },
    name: { required: true, trim: true, type: String },
    unitPrice: { ...wholeRupees, required: true },
    quantity: { max: 20, min: 1, required: true, type: Number },
    amount: { ...wholeRupees, required: true },
    note: { maxlength: 120, trim: true, type: String },
    status: {
      default: "REQUESTED",
      enum: ["REQUESTED", "GIVEN", "DECLINED", "CANCELLED"],
      required: true,
      type: String,
    },
    decidedAt: Date,
    decidedBy: { ref: "User", type: Schema.Types.ObjectId },
    invoiceId: { ref: "Invoice", default: null, type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

khataEntrySchema.index({ hostelId: 1, status: 1, createdAt: -1 });
khataEntrySchema.index({ residentId: 1, createdAt: -1 });
khataEntrySchema.index({ residentId: 1, status: 1, invoiceId: 1 });

export const KhataEntryModel = models.KhataEntry || model("KhataEntry", khataEntrySchema);
