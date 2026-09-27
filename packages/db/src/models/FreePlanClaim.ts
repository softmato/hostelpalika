import { Schema, model, models } from "mongoose";

/**
 * A building's free months, claimed once.
 *
 * Free months belong to the **hostel**, not to the account that registered
 * it: a second Gmail address must not buy a building a second free period. So
 * the building is fingerprinted the day its free months start, and every later
 * registration is matched against these rows before it is given any.
 *
 * The fingerprint is frozen here rather than read back from `Hostel`: a
 * rename, an archive or a purge would otherwise free the building to claim
 * again. For the same reason the row outlives the hostel — the purge keeps it
 * (`RETAINED_BY_HOSTEL_ID`).
 *
 * A hostel that went live with no free months (it matched an earlier claim, or
 * its plan has none) still writes a row, so it is fingerprinted too.
 */
const freePlanClaimSchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    planId: { required: true, trim: true, type: String },
    freeMonths: { min: 0, required: true, type: Number },
    claimedAt: { default: Date.now, type: Date },
    /** When the earlier claim matched, the hostel that made it. */
    matchedHostelId: { default: null, ref: "Hostel", type: Schema.Types.ObjectId },

    /* ── The building ──────────────────────────────────────────────────── */

    /** `hostelNameKey(name)` — case, punctuation and filler words dropped. */
    nameKey: { default: "", trim: true, type: String },
    /** Lower-cased area, so "Baneshwor" and "baneshwor " are one place. */
    area: { default: "", lowercase: true, trim: true, type: String },
    lat: { default: null, type: Number },
    lng: { default: null, type: Number },
    /** Digits only. */
    panNumber: { default: null, trim: true, type: String },
    /** The last ten digits of the owner's phone. */
    ownerPhone: { default: null, trim: true, type: String },
  },
  { timestamps: true },
);

freePlanClaimSchema.index({ hostelId: 1 }, { unique: true });
freePlanClaimSchema.index({ nameKey: 1, area: 1 });
freePlanClaimSchema.index({ ownerPhone: 1, area: 1 });
freePlanClaimSchema.index({ lat: 1, lng: 1 });
freePlanClaimSchema.index(
  { panNumber: 1 },
  { partialFilterExpression: { panNumber: { $type: "string" } } },
);

export const FreePlanClaimModel =
  models.FreePlanClaim || model("FreePlanClaim", freePlanClaimSchema);
