import { Schema, model, models } from "mongoose";

const otpChallengeSchema = new Schema(
  {
    attempts: { default: 0, type: Number },
    channel: { enum: ["email"], required: true, type: String },
    codeHash: { required: true, select: false, type: String },
    codeLastSentAt: { required: true, type: Date },
    consumedAt: { default: null, type: Date },
    expiresAt: { required: true, type: Date },
    identifier: { required: true, trim: true, type: String },
    ipAddress: String,
    purpose: { enum: ["registration", "plan-checkout", "biometric"], required: true, type: String },
    requestCount: { default: 1, type: Number },
    userAgent: String,
    verifiedAt: { default: null, type: Date },
  },
  { timestamps: true },
);

otpChallengeSchema.index({ channel: 1, identifier: 1, createdAt: -1 });
otpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpChallengeSchema.index({ purpose: 1, verifiedAt: 1, consumedAt: 1 });

export const OtpChallengeModel =
  models.OtpChallenge || model("OtpChallenge", otpChallengeSchema);
