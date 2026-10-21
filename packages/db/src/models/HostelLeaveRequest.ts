import { Schema, model, models } from "mongoose";

/**
 * A hostel asking to leave the platform (docs/HOSTEL_LEAVE_PLATFORM.md).
 *
 * `PENDING` until a superadmin acts. Approval archives the hostel (and its
 * branches) with `purgeScheduledAt = approvedAt + holdDays`, so the hold is the
 * archive's grace period, chosen by the owner within the platform's bounds.
 * While it runs the owner can claim the hostel back (`RECLAIMED`); after it the
 * `hostel-purge` cron erases the hostel and this row stays as the record that
 * the owner asked and who approved — and, until `filesUntil`, the list of the
 * original files kept for the owner to download.
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
    /** The hostel's owner at approval — who may download the files once the hostel is erased. */
    ownerId: { ref: "User", type: Schema.Types.ObjectId },
    /**
     * Until when the owner can download the original files: 30 days after
     * leaving (the agreement's point 9), or the hold if that is longer.
     */
    filesUntil: Date,
    /**
     * The originals the purge left in storage because `filesUntil` had not come
     * yet — the hostel's rows are gone, so this is what lists and serves them.
     * The `hostel-purge` cron deletes the objects and empties this at `filesUntil`.
     */
    keptFiles: [
      {
        bucket: { required: true, type: String },
        createdAt: Date,
        fileName: String,
        hostelId: { ref: "Hostel", type: Schema.Types.ObjectId },
        key: { required: true, type: String },
        kind: String,
        mimeType: String,
        sizeBytes: Number,
      },
    ],
    /**
     * The data workbook and JSON emailed at approval, kept privately in our own
     * storage so they download with the files — the hostel's rows that built
     * them are erased with the hold. Deleted with `keptFiles` at `filesUntil`.
     */
    exportFiles: [
      {
        bucket: { required: true, type: String },
        createdAt: Date,
        fileName: String,
        key: { required: true, type: String },
        mimeType: String,
        sizeBytes: Number,
      },
    ],
    filesErasedAt: Date,
    /**
     * Download caps (bandwidth): every ZIP download started in the last day, by
     * part, and a per-Nepal-day count of single-file links handed out.
     */
    zipDownloads: [{ _id: false, at: { required: true, type: Date }, part: { required: true, type: Number } }],
    fileLinkDay: String,
    fileLinkCount: { default: 0, type: Number },
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
