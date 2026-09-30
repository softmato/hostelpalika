import { Schema, model, models } from "mongoose";

const bonus = {
  days: { default: 0, min: 0, type: Number },
  months: { default: 0, min: 0, type: Number },
};

/**
 * One hostel that registered with a `HostelReferralCode`.
 *
 * The rewards are copied from the code (or the program settings) when the
 * hostel registers, so a later edit in Referral settings never changes what the
 * owner was shown on the form.
 *
 * `PENDING` until the referred hostel goes live (free months start or its plan
 * is paid); `LIVE` from then. Each side's extra time is added to that hostel's
 * plan once it has a running plan — `refereeAppliedAt` / `referrerAppliedAt`
 * record when, so a retry never adds it twice.
 */
const hostelReferralSchema = new Schema(
  {
    codeId: { ref: "HostelReferralCode", required: true, type: Schema.Types.ObjectId },
    code: { required: true, type: String },
    kind: { enum: ["HOSTEL", "PARTNER"], required: true, type: String },
    /** The hostel whose code it was. Null for a partner code. */
    referrerHostelId: { default: null, ref: "Hostel", type: Schema.Types.ObjectId },
    refereeHostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId, unique: true },
    status: { default: "PENDING", enum: ["PENDING", "LIVE"], type: String },
    liveAt: { default: null, type: Date },
    refereeReward: bonus,
    referrerReward: bonus,
    refereeAppliedAt: { default: null, type: Date },
    referrerAppliedAt: { default: null, type: Date },
    /** Partner codes. Worked out when the hostel goes live; `PAID` once settled. */
    commission: {
      amount: { default: 0, min: 0, type: Number },
      paidAt: { default: null, type: Date },
      status: { default: "NONE", enum: ["NONE", "EARNED", "PAID"], type: String },
      type: { default: "AMOUNT", enum: ["AMOUNT", "PERCENT"], type: String },
      value: { default: 0, min: 0, type: Number },
    },
  },
  { timestamps: true },
);

hostelReferralSchema.index({ codeId: 1, createdAt: -1 });
hostelReferralSchema.index({ referrerHostelId: 1, status: 1 });

export const HostelReferralModel =
  models.HostelReferral || model("HostelReferral", hostelReferralSchema);
