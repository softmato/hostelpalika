import { Schema, model, models } from "mongoose";

/**
 * A code a new hostel types (or arrives with, on a `?ref=` link) when it
 * registers. Two kinds share one namespace so the registration form checks one
 * collection:
 *
 * - `HOSTEL` — one per hostel, made the first time its owner or a warden opens
 *   Invite hostels. Rewards come from the platform-wide program settings and go
 *   to both hostels.
 * - `PARTNER` — issued by a superadmin to a marketer. Carries its own offer for
 *   the hostel that uses it, and the commission the partner earns per hostel
 *   that goes live.
 *
 * Not the resident `ReferralCode`: that one brings residents to a hostel, this
 * one brings hostels to the platform.
 */
const hostelReferralCodeSchema = new Schema(
  {
    code: { required: true, trim: true, type: String, unique: true, uppercase: true },
    kind: { enum: ["HOSTEL", "PARTNER"], required: true, type: String },
    /** HOSTEL codes only. */
    hostelId: { default: null, ref: "Hostel", type: Schema.Types.ObjectId },
    /** PARTNER codes: who the superadmin issued it to. */
    name: { default: "", trim: true, type: String },
    contact: { default: "", trim: true, type: String },
    note: { default: "", trim: true, type: String },
    /** PARTNER codes: extra plan time for the hostel that registers with it. */
    offerMonths: { default: 0, min: 0, type: Number },
    offerDays: { default: 0, min: 0, type: Number },
    /** PARTNER codes: paid per referred hostel that goes live. */
    commissionType: { default: "AMOUNT", enum: ["AMOUNT", "PERCENT"], type: String },
    commissionValue: { default: 0, min: 0, type: Number },
    status: { default: "ACTIVE", enum: ["ACTIVE", "INACTIVE"], type: String },
    createdBy: { default: null, ref: "User", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

hostelReferralCodeSchema.index(
  { hostelId: 1 },
  { partialFilterExpression: { kind: "HOSTEL" }, unique: true },
);

export const HostelReferralCodeModel =
  models.HostelReferralCode || model("HostelReferralCode", hostelReferralCodeSchema);
