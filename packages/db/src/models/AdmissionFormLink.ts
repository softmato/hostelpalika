import { Schema, model, models } from "mongoose";

/**
 * A hostel's Form QR — the token behind `/join/apply/{token}`. One per hostel,
 * made the first time staff open the scanner's Form QR page.
 */
const admissionFormLinkSchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    token: { required: true, trim: true, type: String },
    enabled: { default: true, type: Boolean },
    /** Settings → Form details: the guardian's ID document becomes required. Off = optional. */
    guardianDocRequired: { default: false, type: Boolean },
    createdBy: { ref: "User", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

admissionFormLinkSchema.index({ hostelId: 1 }, { unique: true });
admissionFormLinkSchema.index({ token: 1 }, { unique: true });

export const AdmissionFormLinkModel =
  models.AdmissionFormLink || model("AdmissionFormLink", admissionFormLinkSchema);
