import { Schema, model, models } from "mongoose";

/**
 * A hostel asking to leave the platform (docs/HOSTEL_LEAVE_PLATFORM.md).
 *
 * `PENDING` until a superadmin acts. Approval archives the hostel (and its
 * branches) with `purgeScheduledAt = approvedAt + holdDays`, so the hold is the
 * archive's grace period, chosen by the owner within the platform's bounds.
 * While it runs the owner can claim the hostel back (`RECLAIMED`); after it the
 * `hostel-purge` cron erases the hostel and this row stays as the record that
 * the owner asked and who approved.
 */
const hostelLeaveRequestSchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    /** Branches archived with it on approval — a main hostel leaves with them. */
    branchIds: [{ ref: "Hostel", type: Schema.Types.ObjectId }],
    requestedBy: { ref: "User", required: true, type: Schema.Types.ObjectId },
    reason: { maxlength: 1000, required: true, trim: true, type: String },
    /** Days we hold the data after approval, inside the bounds set at submission. */
    holdDays: { max: 365, min: 1, required: true, type: Number },
    status: {
      default: "PENDING",
      enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED", "RECLAIMED"],
      required: true,
      type: String,
    },
    /** Snapshot so the row still reads after the hostel is erased. */
    hostelName: { required: true, trim: true, type: String },
    ownerEmail: { lowercase: true, trim: true, type: String },
    ownerName: { trim: true, type: String },
    requestedAt: { default: Date.now, required: true, type: Date },
    cancelledAt: Date,
    reviewedAt: Date,
    reviewedBy: { ref: "User", type: Schema.Types.ObjectId },
    reviewNote: { maxlength: 1000, trim: true, type: String },
    /** `reviewedAt + holdDays` on approval — the last moment it can be claimed. */
    holdUntil: Date,
    /** Sections emailed to the owner on approval, and where they went. */
    exportSections: [{ type: String }],
    exportSentTo: { lowercase: true, trim: true, type: String },
    exportSentAt: Date,
    reclaimedAt: Date,
  },
  { timestamps: true },
);

// One open request per hostel: a second submit while one waits is refused.
hostelLeaveRequestSchema.index(
  { hostelId: 1 },
  { partialFilterExpression: { status: "PENDING" }, unique: true },
);
// The superadmin queue.
hostelLeaveRequestSchema.index({ status: 1, requestedAt: -1 });
// An owner's held hostels, for the claim-back card.
hostelLeaveRequestSchema.index({ requestedBy: 1, status: 1 });

export const HostelLeaveRequestModel =
  models.HostelLeaveRequest || model("HostelLeaveRequest", hostelLeaveRequestSchema);
