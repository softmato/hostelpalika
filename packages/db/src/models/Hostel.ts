import { Schema, model, models } from "mongoose";

const hostelSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, unique: true },
    /**
     * Three uppercase letters, unique platform-wide, opening every reference
     * code this hostel issues — `RUP` in `RUP-4821-K` (target §5.1).
     *
     * Nullable only so existing hostels can be backfilled; every hostel must
     * have one before it can issue an invoice, because the code is what lets a
     * payment identify itself (P2). Derived from the name, then disambiguated
     * numerically — see `finance/reference-code.ts`.
     */
    referencePrefix: {
      type: String,
      trim: true,
      uppercase: true,
      match: /^[A-Z]{3}$/,
    },
    description: String,
    ownerId: { ref: "User", required: true, type: Schema.Types.ObjectId },
    // Set on a branch: the Max hostel it belongs to. A branch has no plan of
    // its own — billing, plan limits and suspension are its main hostel's.
    parentHostelId: { default: null, ref: "Hostel", type: Schema.Types.ObjectId },
    location: {
      area: { type: String, required: true, trim: true },
      city: { type: String, default: "Kathmandu", trim: true },
      province: { type: String, trim: true },
      address: { type: String, trim: true },
      lat: Number,
      lng: Number,
      // MANUAL means an admin dropped the pin on the map themselves — the
      // geocoder must never overwrite those coordinates. GEOCODED means lat/lng
      // were derived from the address text and may be refreshed freely.
      locationSource: {
        type: String,
        enum: ["MANUAL", "GEOCODED"],
        default: "GEOCODED",
      },
      /** "Opposite the campus gate" — how people actually give directions here. */
      landmark: { type: String, trim: true },
      /**
       * A Google Maps link the owner pasted.
       *
       * Kept alongside lat/lng rather than parsed into them: a shortened
       * `maps.app.goo.gl` link cannot be resolved without a network call, and
       * the honest thing to store is what the owner actually gave us.
       */
      mapLink: { type: String, trim: true },
    },
    contact: {
      phone: String,
      email: String,
      /** A second number to try. Both registration forms ask for it. */
      alternatePhone: { type: String, trim: true },
    },
    // The business's PAN/VAT number, digits only. Optional at registration; it
    // fingerprints the building for its free months and ties a branch to it.
    panNumber: { type: String, trim: true },
    hostelType: {
      type: String,
      enum: ["BOYS", "GIRLS", "CO_LIVING"],
      default: "CO_LIVING",
    },
    pricing: {
      currency: { type: String, default: "NPR", trim: true },
      monthlyRentMin: { min: 0, type: Number },
      monthlyRentMax: { min: 0, type: Number },
      admissionFee: { min: 0, type: Number },
      formFee: { min: 0, type: Number },
    },
    securityDeposit: { min: 0, type: Number },
    facilities: [{ type: String, trim: true }],
    roomTypes: [{ type: String, trim: true }],
    // Per-room-type pricing and vacancy as the owner submitted it. `roomTypes`
    // above stays the flat, indexable list used by listing filters; this is the
    // authoritative source for what each room type actually costs. Without it
    // the public detail page has to guess rents from pricing.monthlyRentMin/Max.
    roomConfigurations: [
      {
        roomType: { type: String, required: true, trim: true },
        monthlyRent: { min: 0, type: Number },
        securityDeposit: { min: 0, type: Number },
        bedsPerRoom: { min: 0, type: Number },
        rooms: { min: 0, type: Number },
        vacantBeds: { min: 0, type: Number, default: 0 },
        mealInclusion: {
          type: String,
          enum: ["Included", "Not Included", "Optional"],
          default: "Included",
        },
      },
    ],
    food: {
      mealsPerDay: { min: 0, type: Number },
      hasVeg: { default: true, type: Boolean },
      hasNonVeg: { default: true, type: Boolean },
      notes: { type: String, trim: true },
    },
    rules: [{ type: String, trim: true }],
    photos: [
      {
        alt: { type: String, trim: true },
        fileAssetId: { ref: "FileAsset", type: Schema.Types.ObjectId },
        url: { type: String, trim: true },
        // EXTERIOR (max 3) leads the public listing; INTERIOR (max 20) fills
        // the gallery; ROOM (max 10 per room type) illustrates one entry of
        // roomConfigurations. Limits enforced in the profile service.
        kind: {
          type: String,
          enum: ["EXTERIOR", "INTERIOR", "ROOM"],
          default: "INTERIOR",
        },
        // Set only on ROOM photos — matches roomConfigurations[].roomType.
        roomType: { type: String, trim: true },
      },
    ],
    // Post-approval renames are limited to 2; further changes go through the
    // superadmin change-request flow.
    nameChangeCount: { type: Number, default: 0, min: 0 },
    // Running total of de-duplicated visits to /hostels/{slug}, kept here so the
    // admin dashboard reads one number instead of aggregating HostelPageView.
    // The event rows stay the source of truth for unique/recent breakdowns.
    publicViewCount: { type: Number, default: 0, min: 0 },
    // How many floors the building has. Purely descriptive — rooms are stored
    // as one flat list per hostel and are not grouped by floor.
    totalFloors: { min: 0, type: Number },
    /** Four-digit year the hostel opened. Shown on the public listing. */
    yearEstablished: { type: String, trim: true },
    capacitySummary: {
      totalRooms: { min: 0, type: Number },
      totalBeds: { min: 0, type: Number },
      vacantBeds: { min: 0, type: Number },
    },
    nearbyPlaces: [
      {
        name: { type: String, trim: true },
        type: {
          type: String,
          enum: [
            "college",
            "hospital",
            "bus_stop",
            "park",
            "gym",
            "restaurant",
            "pharmacy",
            "other",
          ],
          default: "other",
        },
        distance: Number,
        coordinates: {
          lat: Number,
          lng: Number,
        },
      },
    ],
    nearbyPlacesLastUpdated: Date,
    status: {
      type: String,
      enum: [
        "DRAFT",
        "PENDING_APPROVAL",
        "APPROVED",
        "PUBLISHED",
        "REJECTED",
        "SUSPENDED",
      ],
      default: "DRAFT",
    },
    verificationStatus: {
      type: String,
      enum: ["UNVERIFIED", "PENDING", "VERIFIED", "REJECTED"],
      default: "UNVERIFIED",
    },
    createdBy: { ref: "User", type: Schema.Types.ObjectId },
    updatedBy: { ref: "User", type: Schema.Types.ObjectId },
    isDemoData: { type: Boolean, default: false },
    demoDataLabel: { type: String, trim: true },
    // Archived, not erased. Every read in the app already filters `isDeleted`,
    // so setting it is what takes a hostel off the public site, out of search
    // and out of its own portal — `billing/subscription-access.ts` refuses an
    // archived hostel, which locks its staff out without a separate check.
    isDeleted: { type: Boolean, default: false },
    deletedAt: Date,
    deletedBy: { ref: "User", type: Schema.Types.ObjectId },
    /**
     * When the archive stops being reversible and the row is erased for good —
     * `deletedAt + 60 days`, mirroring the account deletion grace period
     * (PRIVACY_POLICY.md §8.3). The `hostel-purge` cron sweeps on this alone,
     * so a hostel archived before the field existed is never picked up by
     * accident: it has no purge date and stays archived until somebody sets one.
     */
    purgeScheduledAt: Date,
    /** Why it was archived. Shown to the superadmin on the Archived queue. */
    archiveReason: { type: String, trim: true },
    /**
     * The platform taking the hostel's portal away for an unpaid plan.
     *
     * One field, two stages, read off the clock: before `graceEndsAt` the hostel
     * is in **pre-suspension** (its staff see a countdown and keep working);
     * from `graceEndsAt` on it is **suspended**, and the admin, warden,
     * resident, guardian and cook portals stop. Nothing runs at the deadline —
     * `modules/hostels/hostel-suspension.ts` derives the stage.
     *
     * The listing's `status` is deliberately untouched, so lifting a suspension
     * never has to remember what the hostel was before. Cleared by the
     * settlement that pays the plan in full, or by a platform admin.
     */
    suspension: {
      graceEndsAt: { default: null, type: Date },
      reason: { default: null, enum: ["PLAN_PAYMENT", null], type: String },
      startedAt: { default: null, type: Date },
      startedBy: { default: null, ref: "User", type: Schema.Types.ObjectId },
    },
    /**
     * Room bookings on this hostel stopped by the platform (docs/BOOKINGS.md).
     *
     * Set automatically when missed answers and hostel cancellations reach the
     * strike limit, or by a superadmin. Only a superadmin clears it. While
     * `pausedAt` is set the Book button does not show and no booking is taken.
     */
    /**
     * Stays of a few nights, booked and paid through us (docs/PLANS_BRANCHES_SHORT_STAYS.md).
     *
     * The daily rate lives here rather than on the rate card: the rate card is
     * versioned by month because it bills residents, while a short stay is sold
     * once and freezes its own rate on the booking.
     */
    shortStays: {
      enabled: { default: false, type: Boolean },
      minNights: { default: 1, max: 29, min: 1, type: Number },
      rates: {
        default: [],
        type: [
          new Schema(
            {
              dailyRate: { min: 1, required: true, type: Number },
              roomType: { required: true, trim: true, type: String },
            },
            { _id: false },
          ),
        ],
      },
    },
    bookingPause: {
      pausedAt: { default: null, type: Date },
      pausedBy: { default: null, ref: "User", type: Schema.Types.ObjectId },
      reason: { default: null, trim: true, type: String },
      /** Strikes before this are forgiven: a resumed hostel starts counting again. */
      resumedAt: { default: null, type: Date },
    },
  },
  { timestamps: true },
);

// Partial, because the prefix is nullable until every hostel is backfilled —
// a plain unique index would collide on the nulls.
hostelSchema.index(
  { referencePrefix: 1 },
  {
    partialFilterExpression: { referencePrefix: { $type: "string" } },
    unique: true,
  },
);
hostelSchema.index({ status: 1, "location.area": 1, hostelType: 1 });
hostelSchema.index({ verificationStatus: 1, status: 1 });
hostelSchema.index({ ownerId: 1, status: 1 });
hostelSchema.index(
  { parentHostelId: 1 },
  { partialFilterExpression: { parentHostelId: { $type: "objectId" } } },
);
// The only query the purge cron runs.
hostelSchema.index({ isDeleted: 1, purgeScheduledAt: 1 });
hostelSchema.index({
  "pricing.monthlyRentMin": 1,
  "pricing.monthlyRentMax": 1,
});

export const HostelModel = models.Hostel || model("Hostel", hostelSchema);
