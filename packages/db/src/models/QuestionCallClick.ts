import { Schema, model, models } from "mongoose";

/**
 * One row per resident tap on the QuestionCall study link (ARCHITECTURE.md §12).
 * `converted` is only ever set by QuestionCall's own callback, so the platform
 * never claims a signup it cannot prove.
 */
const questionCallClickSchema = new Schema(
  {
    residentId: {
      index: true,
      ref: "Resident",
      required: true,
      type: Schema.Types.ObjectId,
    },
    userId: { ref: "User", required: true, type: Schema.Types.ObjectId },
    hostelId: {
      index: true,
      ref: "Hostel",
      required: true,
      type: Schema.Types.ObjectId,
    },
    clickedAt: { default: Date.now, index: true, required: true, type: Date },
    deviceType: { default: "web", enum: ["web", "android", "ios"], type: String },
    converted: { default: false, index: true, type: Boolean },
    conversionTrackedAt: Date,
    /*
      Single-use sign-in handoff to QuestionCall. Only the SHA-256 of the code's
      secret half is kept; the code is `<this _id>.<secret>`, so the exchange
      looks the row up by `_id` and needs no index of its own.
    */
    ssoCodeHash: String,
    ssoExpiresAt: Date,
    ssoUsedAt: Date,
  },
  { timestamps: true },
);

questionCallClickSchema.index({ hostelId: 1, clickedAt: -1 });
questionCallClickSchema.index({ userId: 1, clickedAt: -1 });
questionCallClickSchema.index({ converted: 1, clickedAt: -1 });

export const QuestionCallClickModel =
  models.QuestionCallClick || model("QuestionCallClick", questionCallClickSchema);
