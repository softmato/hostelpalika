import { Schema, model, models } from "mongoose";

/**
 * The hostel's rate card, versioned by effective date (target §3.3).
 *
 * Replaces `Resident.monthlyFee` as the source of what a resident is charged.
 * That field was a bare number set per resident or bulk-set across a whole
 * hostel, with no history — so "what was this resident's rent in March?" had no
 * answer, and a bulk change silently rewrote the basis for every future bill.
 *
 * **A schedule is never edited.** Changing rates closes the current row
 * (`effectiveTo` = the day before the new one starts) and inserts a new one.
 * Invoices snapshot the amount they were computed from and do not re-derive it,
 * so a historical invoice stays correct even if every schedule is later deleted.
 *
 * **This is the single source of a price.** `Hostel.roomConfigurations[].monthlyRent`
 * and `Hostel.pricing` used to be a second, independently typed rate card that
 * the public listing read while billing read this one; nothing compared them and
 * they drifted. Writing a schedule now projects its rates onto those fields
 * (`projectScheduleOntoListing`), and the profile form no longer accepts them
 * once a schedule exists. The listing is a view of this document.
 */

/** Whole NPR rupees, always (ADR-1). A fraction here is a bug upstream. */
const wholeRupees = {
  min: 0,
  type: Number,
  validate: {
    message: "{PATH} must be a whole number of rupees.",
    validator: Number.isInteger,
  },
};

const rateSchema = new Schema(
  {
    /**
     * The hostel's own room type, and the key a rate is looked up by.
     *
     * `bedType` used to be the only key, and that was the reason the platform
     * had two prices for one bed. A bed type is a five-value enum derived from
     * free text, and `normalizeBedType` returns null for real room types — a
     * hostel whose rooms are called `"Shared"` could not be priced by a rate
     * card at all, so `roomConfigurations[].monthlyRent` had to stay as a second
     * store, and the two drifted until one hostel quoted 18,000 on its listing
     * and invoiced 174,000.
     *
     * Keying on the room type the hostel actually uses removes the second store:
     * one rate per room type, one number, and the listing is written from it.
     *
     * Optional only so schedules written before this survive validation; the
     * migration backfills them and `rateForRoomType` still falls back to
     * `bedType` for any it could not map.
     */
    roomType: { type: String, trim: true },
    /**
     * Still carried, still derived. Invoices, receipts and finance reports group
     * by it, and it is the vocabulary that means the same thing across hostels —
     * one hostel's "Two Sharing" and another's "Double Room" are one line in a
     * platform report. It is written by the server from `roomType`, never typed.
     */
    bedType: {
      type: String,
      enum: [
        "SINGLE",
        "DOUBLE_SHARING",
        "TRIPLE_SHARING",
        "FOUR_SHARING",
        "DORMITORY",
      ],
    },
    monthlyAmount: { ...wholeRupees, required: true },
    currency: { type: String, default: "NPR" },
  },
  { _id: false },
);

const feeScheduleSchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    effectiveFrom: { type: Date, required: true },
    /** Null means "current". Exactly one row per hostel may be open. */
    effectiveTo: { type: Date, default: null },
    /** One entry per room type the hostel actually offers. */
    rates: { type: [rateSchema], default: [] },
    /** One-time charge at move-in. Optional — many hostels do not levy one. */
    admissionFee: { ...wholeRupees },
    formFee: { ...wholeRupees },
    /**
     * What comes off the admission fee when the new resident arrives on another
     * resident's referral code.
     *
     * On the rate card rather than in settings because it is a **price**, and
     * prices here are versioned: an intake done in March has to stay explicable
     * in December even if the hostel has since withdrawn the offer. A flat
     * rupee figure rather than a percentage for the same reason the rates are —
     * the number on the receipt is the number that was configured, with no
     * arithmetic in between to disagree about.
     *
     * It discounts the admission fee **only**. Rent is untouched: a referral is
     * a one-time thank-you, not a standing rate for the referred resident.
     */
    referralAdmissionDiscount: { ...wholeRupees },
    /** Refundable security deposit. */
    depositAmount: { ...wholeRupees },
    createdBy: { ref: "User", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

feeScheduleSchema.index({ hostelId: 1, effectiveFrom: -1 });

/**
 * At most one open schedule per hostel. This is what makes "the current rate
 * card" a single well-defined document rather than whichever row a sort happened
 * to return first — the ambiguity that made two billing paths disagree.
 */
feeScheduleSchema.index(
  { hostelId: 1 },
  { partialFilterExpression: { effectiveTo: null }, unique: true },
);

export const FeeScheduleModel =
  models.FeeSchedule || model("FeeSchedule", feeScheduleSchema);
