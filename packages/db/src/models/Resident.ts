import { Schema, model, models } from "mongoose";

const residentSchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    userId: { ref: "User", type: Schema.Types.ObjectId },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    // Residents are tracked against a room type, not an individual room or
    // bed. Occupancy is a running count on hostel.roomConfigurations: taking a
    // resident in decrements that type's vacantBeds, moving them out adds it
    // back. There are no Room or Bed records to point at.
    roomType: { type: String, required: true, trim: true },
    /**
     * Canonical pricing vocabulary, derived from `roomType` via
     * `normalizeBedType`. Additive and nullable on purpose: `roomType` above
     * stays the capacity key and the display label everywhere outside finance
     * (plan §3.2, D1). Null means the room type could not be mapped — billing
     * then fails loudly with BED_TYPE_NOT_PRICED rather than picking a rate.
     */
    bedType: {
      type: String,
      enum: [
        "SINGLE",
        "DOUBLE_SHARING",
        "TRIPLE_SHARING",
        "FOUR_SHARING",
        "DORMITORY",
        null,
      ],
      default: null,
    },
    moveInDate: { type: Date, required: true },
    depositAmount: { min: 0, default: 0, type: Number },
    /**
     * Per-resident rent **override**, not the normal path (target §3.3).
     *
     * Null — the default — means the hostel's `FeeSchedule` governs, via the
     * resident's bed type. A value here wins outright and covers the real cases:
     * a long-staying resident on an old rate, a staff member's child, a
     * negotiated discount. It must carry a reason, so an unexplained number
     * cannot become the norm again.
     *
     * Nullable rather than `0`-defaulted because zero is a legitimate override
     * and "not set" is not. Conflating them is what let a misconfigured resident
     * be billed nothing with nobody noticing (current §5.1 A2).
     */
    monthlyFee: { min: 0, default: null, type: Number },
    feeOverrideReason: { type: String, trim: true },
    feeOverrideSetBy: { ref: "User", type: Schema.Types.ObjectId },
    feeOverrideSetAt: Date,
    /**
     * What was actually agreed at intake, snapshotted (target §3.3, same rule
     * as an invoice line).
     *
     * The rate card these came from is versioned and will be closed and
     * replaced; re-deriving the admission fee from "the current schedule" a year
     * later answers a different question than "what did this person pay to move
     * in". Null means no admission fee was levied — not zero, which is a fee
     * that was set to nothing on purpose.
     */
    admissionFee: { min: 0, default: null, type: Number },
    /** What the referral code took off {@link admissionFee}, if anything. */
    admissionFeeDiscount: { min: 0, default: 0, type: Number },
    /**
     * The code that brought them in, kept verbatim.
     *
     * `Referral` already records the link and is the row finance reports off, so
     * this is not the source of truth for who gets rewarded. It is here because
     * it is what the discount above was justified by, and a discount whose
     * reason has to be reconstructed by joining three collections is a discount
     * nobody can explain at the counter.
     */
    referralCode: { type: String, trim: true, uppercase: true },
    /**
     * For a resident who was already living here when the hostel joined: the
     * last BS month (`2083-05`) they had fully paid before that. Billing never
     * issues rent for this month or any earlier one. Null for everyone who came
     * in through the normal intake (docs/EXISTING_RESIDENTS.md).
     */
    paidTill: { type: String, default: null, trim: true },
    /**
     * The resident's khata — things taken from the hostel (an egg, laundry)
     * charged onto next month's bill. Opened on request, approved by staff.
     * Absent means never asked. See `khata.service`.
     */
    khata: {
      type: {
        status: { enum: ["REQUESTED", "ACTIVE", "DECLINED", "CLOSED"], type: String },
        requestedAt: Date,
        decidedAt: Date,
        decidedBy: { ref: "User", type: Schema.Types.ObjectId },
      },
      default: undefined,
    },
    /** The existing-residents list this resident was added from, if any. */
    existingListId: {
      ref: "ExistingResidentList",
      default: null,
      type: Schema.Types.ObjectId,
    },
    /**
     * Somebody signed in with this resident's email and said "this is not me"
     * (docs/EXISTING_RESIDENTS.md). The email was typed by the hostel, so this is
     * how a typo stops a stranger being asked again. Cleared when the hostel
     * changes the email on the record.
     */
    accountLinkDeclinedAt: { type: Date, default: null },
    accountLinkDeclinedBy: { ref: "User", type: Schema.Types.ObjectId, default: null },
    residentType: {
      type: String,
      enum: ["STUDENT", "WORKING_PROFESSIONAL", "OTHER"],
      default: "STUDENT",
    },
    /**
     * A short-stay guest admitted on a booking: the end of their move-out day.
     * They paid their nights upfront, so no monthly rent or joining invoice is
     * ever raised for them, and the booking sweep moves them out at this time.
     */
    stayEndsAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ["PENDING", "ACTIVE", "SUSPENDED", "MOVED_OUT"],
      default: "PENDING",
    },
    createdBy: { ref: "User", type: Schema.Types.ObjectId },
    updatedBy: { ref: "User", type: Schema.Types.ObjectId },
    isDemoData: { type: Boolean, default: false },
    demoDataLabel: { type: String, trim: true },
    isDeleted: { type: Boolean, default: false },
    deletedAt: Date,
    deletedBy: { ref: "User", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

// Deletion is soft (`isDeleted`), so a plain unique index would keep a removed
// resident's phone reserved forever and make re-registering the same person
// fail with a raw E11000. The partial filter scopes uniqueness to the residents
// that are actually still on the roll.
residentSchema.index(
  { hostelId: 1, phone: 1 },
  { partialFilterExpression: { isDeleted: false }, unique: true },
);
// The same rule for the mailbox, and it is the stronger of the two: `email` is
// what `linkResidentAccount` turns into a login, and one account may hold only
// one live resident profile. Without this the roll happily took two residents on
// one address — which is exactly what happened when an admin hit the phone
// conflict above, changed the number, and submitted the same person again.
//
// `email` is optional, so the filter requires a string as well as a live record:
// a plain sparse index would still let two residents share `null`, and a plain
// unique one would forbid the second resident who simply has no email.
residentSchema.index(
  { hostelId: 1, email: 1 },
  {
    partialFilterExpression: { isDeleted: false, email: { $type: "string" } },
    unique: true,
  },
);
residentSchema.index({ hostelId: 1, status: 1 });
residentSchema.index({ hostelId: 1, roomType: 1 });
residentSchema.index({ userId: 1, status: 1 });

export const ResidentModel =
  models.Resident || model("Resident", residentSchema);
