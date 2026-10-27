import { Schema, model, models } from "mongoose";

const complaintSchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    residentId: { ref: "Resident", required: true, type: Schema.Types.ObjectId },
    title: { required: true, trim: true, type: String },
    /**
     * Optional since the phone stopped demanding one.
     *
     * A resident raising an issue from the app photographs it and says what is
     * wrong out loud; `voiceNoteAssetId` is then the description, and forcing a
     * typed one would have meant storing filler. A complaint still always
     * carries at least one of the two — `complaintCreateSchema` refuses one
     * carrying neither.
     */
    description: { trim: true, type: String },
    /**
     * A completed `COMPLAINT_NOTE` audio asset: the resident describing the
     * problem in their own words.
     *
     * Its own field rather than a sixth attachment because attachments are
     * photographs everywhere they are drawn — the resident's gallery, the
     * admin queue — and an audio file rendered as an `<img>` is a broken
     * thumbnail, not a recording anybody plays.
     */
    voiceNoteAssetId: { ref: "FileAsset", type: Schema.Types.ObjectId },
    category: {
      default: "OTHER",
      enum: [
        "FOOD",
        "ROOM",
        "MAINTENANCE",
        "SAFETY",
        "PAYMENT",
        "STAFF",
        "NOISE",
        "OTHER",
      ],
      type: String,
    },
    isAnonymous: { default: false, type: Boolean },
    clientRequestId: { default: null, type: String },
    status: {
      default: "PENDING",
      enum: ["PENDING", "IN_PROGRESS", "RESOLVED", "REJECTED"],
      type: String,
    },
    adminResponse: { trim: true, type: String },
    slaDueAt: { required: true, type: Date },
    /**
     * Set once by the SLA cron when a still-open complaint passes slaDueAt.
     * Presence is what makes the breach alert idempotent — the job only ever
     * looks at complaints where this is missing.
     */
    slaBreachedAt: Date,
    resolvedAt: Date,
    rejectedAt: Date,
    confirmedAt: Date,
    createdBy: { ref: "User", type: Schema.Types.ObjectId },
    updatedBy: { ref: "User", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

complaintSchema.index({ hostelId: 1, status: 1, createdAt: -1 });
complaintSchema.index({ hostelId: 1, category: 1, createdAt: -1 });
complaintSchema.index({ residentId: 1, status: 1 });
complaintSchema.index({ hostelId: 1, slaDueAt: 1 });

export const ComplaintModel = models.Complaint || model("Complaint", complaintSchema);
