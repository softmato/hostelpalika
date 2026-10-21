import { Schema, model, models } from "mongoose";

/**
 * A hostel owner's signature on the HostelPalika service agreement, given on
 * the last step of Hostel KYC.
 *
 * Kept apart from `Hostel` on purpose: hostel rows are read all over the public
 * site, and a signature must never ride along with a listing.
 *
 * `parties` and `terms` are a copy of exactly what the owner read and signed, so
 * the PDF printed later — on approval, or on a download a year on — is that
 * agreement and not whatever the terms say today. `textHash` is the SHA-256 of
 * the two, printed on the PDF as the agreement's fingerprint.
 *
 * `refCode` (`SMT/HP/2026/012`) is given when the agreement is issued — at KYC
 * approval, or at signing for a hostel already verified — from the same run as
 * the paper agreements, and the track sheet gets a line for it. Once it is set
 * the signature is final.
 */
const hostelAgreementSignatureSchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    signedBy: { ref: "User", required: true, type: Schema.Types.ObjectId },
    signerName: { required: true, trim: true, type: String },
    /** `M x y L x y …` in the shared 600×200 box (`lib/signature.ts`). */
    signature: { required: true, type: String },
    signedAt: { required: true, type: Date },
    ip: { default: "", type: String },
    userAgent: { default: "", type: String },
    parties: { required: true, type: Schema.Types.Mixed },
    terms: { required: true, type: Schema.Types.Mixed },
    textHash: { required: true, type: String },
    refCode: { default: null, type: String },
    issuedAt: { default: null, type: Date },
    /** Who approved the KYC — the company's side of the signature. */
    approvedByName: { default: "", type: String },
    sentAt: { default: null, type: Date },
    sentTo: { default: "", type: String },
  },
  { timestamps: true },
);

hostelAgreementSignatureSchema.index({ hostelId: 1 }, { unique: true });

export const HostelAgreementSignatureModel =
  models.HostelAgreementSignature || model("HostelAgreementSignature", hostelAgreementSignatureSchema);
