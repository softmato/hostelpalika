import { Schema, model, models } from "mongoose";

/**
 * Feedback, a bug report or an improvement idea sent from the Help & support
 * dialog of any portal (web or app). One text box — the first line reads as
 * its title — plus optional screenshots, and the page it was sent from.
 * Read and closed by platform staff in Platform → Feedback.
 */
const feedbackSchema = new Schema(
  {
    kind: { enum: ["FEEDBACK", "BUG", "IMPROVEMENT"], required: true, type: String },
    message: { maxlength: 4000, required: true, trim: true, type: String },
    /** FileAsset ids, owned by the sender. */
    screenshotAssetIds: [{ ref: "FileAsset", type: Schema.Types.ObjectId }],
    userId: { ref: "User", required: true, type: Schema.Types.ObjectId },
    role: { trim: true, type: String },
    hostelId: { ref: "Hostel", type: Schema.Types.ObjectId },
    /** Where they were: a web path or an app screen. */
    page: { maxlength: 300, trim: true, type: String },
    platform: { enum: ["WEB", "APP"], type: String },
    appVersion: { maxlength: 40, trim: true, type: String },
    status: { default: "NEW", enum: ["NEW", "SEEN", "DONE"], type: String },
    handledBy: { ref: "User", type: Schema.Types.ObjectId },
    handledAt: Date,
  },
  { timestamps: true },
);

// The inbox: newest first, filterable by status.
feedbackSchema.index({ status: 1, createdAt: -1 });
feedbackSchema.index({ userId: 1, createdAt: -1 });

export const FeedbackModel = models.Feedback || model("Feedback", feedbackSchema);
