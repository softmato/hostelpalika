import { Schema, model, models } from "mongoose";

/**
 * One "Is this page useful?" vote on the public guide. Anyone may vote; a
 * signed-in reader's id and role ride along. A "No" may carry a reason.
 * Read per page in Platform → Feedback → Guide pages.
 */
const guideFeedbackSchema = new Schema(
  {
    page: { maxlength: 200, required: true, trim: true, type: String },
    helpful: { required: true, type: Boolean },
    reason: { maxlength: 1000, trim: true, type: String },
    userId: { ref: "User", type: Schema.Types.ObjectId },
    role: { trim: true, type: String },
  },
  { timestamps: true },
);

export const GuideFeedbackModel = models.GuideFeedback || model("GuideFeedback", guideFeedbackSchema);
