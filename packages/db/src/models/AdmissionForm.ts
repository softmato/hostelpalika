import { Schema, model, models } from "mongoose";

/**
 * Somebody who wants to live in a hostel, filled in through the hostel's Form
 * QR (`AdmissionFormLink`) — the paper application form, on their own phone.
 *
 * No account and no ID card needed: it is the form a walk-in fills at the
 * desk. Nobody becomes a resident from it until staff pick a bed and register
 * them through the normal intake, which marks it ADDED. The personal answers
 * are one encrypted blob (`resident-details.ts`); name and phone stay plain so
 * the list can show them and a second send from the same phone replaces the
 * first instead of queueing twice.
 */
const admissionFormSchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    /** Set when they were signed in while filling it. */
    userId: { ref: "User", default: null, type: Schema.Types.ObjectId },
    firstName: { required: true, trim: true, type: String },
    lastName: { required: true, trim: true, type: String },
    phone: { required: true, trim: true, type: String },
    email: { default: "", lowercase: true, trim: true, type: String },
    residentType: {
      default: "STUDENT",
      enum: ["STUDENT", "WORKING_PROFESSIONAL", "OTHER"],
      type: String,
    },
    detailsData: { default: null, type: String },
    /** Taken or uploaded on the form; copied onto the resident when they are registered. */
    photoAssetId: { default: null, ref: "FileAsset", type: Schema.Types.ObjectId },
    /** Citizenship or ID scans; become `ResidentDocument` rows when they are registered. */
    documents: {
      default: [],
      type: [
        {
          _id: false,
          fileAssetId: { ref: "FileAsset", required: true, type: Schema.Types.ObjectId },
          kind: { enum: ["APPLICANT_ID", "GUARDIAN_ID"], required: true, type: String },
        },
      ],
    },
    status: {
      default: "PENDING",
      enum: ["PENDING", "ADDED", "DECLINED"],
      required: true,
      type: String,
    },
    submittedAt: { default: () => new Date(), type: Date },
    decidedAt: { default: null, type: Date },
    decidedBy: { ref: "User", type: Schema.Types.ObjectId },
    residentId: { default: null, ref: "Resident", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

admissionFormSchema.index({ hostelId: 1, status: 1, submittedAt: -1 });
admissionFormSchema.index({ hostelId: 1, phone: 1, status: 1 });

export const AdmissionFormModel =
  models.AdmissionForm || model("AdmissionForm", admissionFormSchema);
