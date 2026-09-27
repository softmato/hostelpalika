import { Schema, model, models } from "mongoose";

import { positiveWholeRupees } from "./finance-fields";

/**
 * A room booking: one person, one room type, one hostel, one fee.
 *
 * The fee is paid to HostelPalika, not the hostel (docs/BOOKINGS.md). A booking
 * is sold under the terms in force when it was created, and those terms are
 * copied onto it — `terms` — so a later settings change never reaches money
 * somebody has already paid.
 *
 * ## Status
 *
 * AWAITING_PAYMENT → PAYMENT_IN_REVIEW → AWAITING_HOSTEL → CONFIRMED → CHECKED_IN,
 * with the endings EXPIRED, DECLINED, HOSTEL_NO_RESPONSE, CANCELLED_BY_USER,
 * CANCELLED_BY_HOSTEL, CANCELLED_BY_PLATFORM and NO_SHOW. Every transition is a
 * conditional update on the status it leaves, so two people pressing two
 * buttons cannot both win.
 *
 * `isOpen` mirrors "the status is one of the first four" as a plain boolean,
 * because a unique partial index — one open booking per person — can be built
 * on an equality and not on every server's `$in`.
 */
export const BOOKING_STATUSES = [
  "AWAITING_PAYMENT",
  "PAYMENT_IN_REVIEW",
  "AWAITING_HOSTEL",
  "CONFIRMED",
  "CHECKED_IN",
  "EXPIRED",
  "DECLINED",
  "HOSTEL_NO_RESPONSE",
  "CANCELLED_BY_USER",
  "CANCELLED_BY_HOSTEL",
  "CANCELLED_BY_PLATFORM",
  "NO_SHOW",
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const OPEN_BOOKING_STATUSES: readonly BookingStatus[] = [
  "AWAITING_PAYMENT",
  "PAYMENT_IN_REVIEW",
  "AWAITING_HOSTEL",
  "CONFIRMED",
];

export function isOpenBookingStatus(status: string) {
  return (OPEN_BOOKING_STATUSES as readonly string[]).includes(status);
}

const sealedSchema = new Schema(
  {
    authTag: { required: true, type: String },
    ciphertext: { required: true, type: String },
    fingerprint: { required: true, type: String },
    format: { required: true, type: String },
    iv: { required: true, type: String },
    keyId: { required: true, type: String },
    wrappedKey: { required: true, type: String },
    wrappedKeyIv: { required: true, type: String },
    wrappedKeyTag: { required: true, type: String },
  },
  { _id: false },
);

const cancelStepSchema = new Schema(
  {
    refundPercent: { max: 100, min: 0, required: true, type: Number },
    throughDay: { min: 1, required: true, type: Number },
  },
  { _id: false },
);

/** Whole rupees, or null until the booking has ended. */
const settledRupees = {
  default: null,
  type: Number,
  validate: {
    message: "{PATH} must be a whole number of rupees.",
    validator: (value: number | null) => value === null || (Number.isInteger(value) && value >= 0),
  },
};

const reminderSentSchema = new Schema(
  {
    at: { required: true, type: Date },
    hoursLeft: { required: true, type: Number },
  },
  { _id: false },
);

/**
 * A short stay's nights, frozen when it is booked (docs/PLANS_BRANCHES_SHORT_STAYS.md).
 * Paid upfront beside the fee; `fee` is then the booking fee times `holdBlocks`.
 */
const staySchema = new Schema(
  {
    amount: { ...positiveWholeRupees, required: true },
    dailyRate: { ...positiveWholeRupees, required: true },
    holdBlocks: { min: 1, required: true, type: Number },
    hostelSharePercent: { max: 100, min: 0, required: true, type: Number },
    /** Nepal days, stored as UTC midnight like `plannedMoveIn`. */
    moveIn: { required: true, type: Date },
    moveOut: { required: true, type: Date },
    nights: { min: 1, required: true, type: Number },
  },
  { _id: false },
);

const bookingSchema = new Schema(
  {
    /** A monthly resident's bed, or a few nights paid upfront. */
    kind: { default: "MONTHLY", enum: ["MONTHLY", "SHORT_STAY"], type: String },
    stay: { default: null, type: staySchema },
    /** `BK-7F3K2Q` — short enough to type into a banking app's remarks. */
    code: { required: true, trim: true, type: String, uppercase: true },
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    userId: { ref: "User", required: true, type: Schema.Types.ObjectId },
    roomType: { required: true, trim: true, type: String },

    /** Who booked, as they were when they booked. Documents print this. */
    guest: {
      email: { default: "", trim: true, type: String },
      name: { required: true, trim: true, type: String },
      phone: { default: "", trim: true, type: String },
    },
    /** The hostel as it was when booked, for documents and email. */
    hostelSnapshot: {
      address: { default: "", trim: true, type: String },
      name: { required: true, trim: true, type: String },
      phone: { default: "", trim: true, type: String },
      slug: { default: "", trim: true, type: String },
    },

    monthlyRent: { ...positiveWholeRupees, required: true },
    fee: { ...positiveWholeRupees, required: true },
    currency: { default: "NPR", type: String },

    terms: {
      cancelSteps: { default: [], type: [cancelStepSchema] },
      feePercent: { required: true, type: Number },
      holdDays: { required: true, type: Number },
      hostelAnswerHours: { required: true, type: Number },
      hostelSharePercent: { required: true, type: Number },
      noShowRefundPercent: { required: true, type: Number },
    },

    /** The refund policy the person ticked, and when. */
    policy: {
      acceptedAt: { required: true, type: Date },
      source: { default: "WEB", enum: ["WEB", "MOBILE"], type: String },
      version: { required: true, trim: true, type: String },
    },

    /** Where a refund goes. The number is sealed to this booking. */
    refundAccount: {
      bankName: { default: "", trim: true, type: String },
      branch: { default: "", trim: true, type: String },
      holderName: { required: true, trim: true, type: String },
      method: { enum: ["BANK", "ESEWA", "KHALTI"], required: true, type: String },
      number: { required: true, type: sealedSchema },
      numberLast4: { required: true, trim: true, type: String },
    },

    /** When they mean to arrive. Informational: the hold decides. */
    plannedMoveIn: { default: null, type: Date },

    invoiceNumber: { required: true, trim: true, type: String },
    receiptNumber: { default: null, trim: true, type: String },
    /** Softmato's invoice for the fee, raised when the guest first presses Pay. */
    softmatoInvoiceNo: { default: null, trim: true, type: String },

    status: { default: "AWAITING_PAYMENT", enum: BOOKING_STATUSES, required: true, type: String },
    isOpen: { default: true, required: true, type: Boolean },

    paymentDueBy: { required: true, type: Date },
    paymentSubmittedAt: { default: null, type: Date },
    /** The last refusal of a screenshot, shown back to the person. */
    paymentRejection: {
      at: { default: null, type: Date },
      reason: { default: null, trim: true, type: String },
    },
    paymentVerifiedAt: { default: null, type: Date },
    paymentVerifiedBy: { default: null, ref: "User", type: Schema.Types.ObjectId },

    hostelAnswerBy: { default: null, type: Date },
    hostelRemindersSent: { default: [], type: [reminderSentSchema] },

    confirmedAt: { default: null, type: Date },
    confirmedBy: { default: null, ref: "User", type: Schema.Types.ObjectId },
    holdEndsAt: { default: null, type: Date },
    moveInRemindersSent: { default: [], type: [reminderSentSchema] },
    /** A bed of `roomType` is claimed for this booking and not yet released or handed over. */
    bedHeld: { default: false, type: Boolean },

    checkedInAt: { default: null, type: Date },
    checkedInBy: { default: null, ref: "User", type: Schema.Types.ObjectId },
    residentId: { default: null, ref: "Resident", type: Schema.Types.ObjectId },

    endedAt: { default: null, type: Date },
    endedBy: { default: null, ref: "User", type: Schema.Types.ObjectId },
    /** Why it ended, in the words of whoever ended it. */
    endReason: { default: null, trim: true, type: String },
    /** Counted against the hostel: a missed answer or a hostel cancellation. */
    hostelStrike: { default: false, type: Boolean },

    /** Who gets what, written once when the booking ends. */
    settlement: {
      hostelShare: settledRupees,
      kept: settledRupees,
      platformShare: settledRupees,
      refund: settledRupees,
      refundPercent: { default: null, type: Number },
      /** A short stay's nights kept and handed back, inside the totals above. */
      stayKept: settledRupees,
      stayRefund: settledRupees,
    },
  },
  { timestamps: true },
);

bookingSchema.index({ code: 1 }, { unique: true });
bookingSchema.index({ userId: 1 }, { partialFilterExpression: { isOpen: true }, unique: true });
bookingSchema.index({ userId: 1, createdAt: -1 });
bookingSchema.index({ hostelId: 1, status: 1, createdAt: -1 });
bookingSchema.index({ status: 1, paymentDueBy: 1 });
// The webhook finds the booking by the only handle Softmato sends back.
bookingSchema.index({ softmatoInvoiceNo: 1 }, { sparse: true });
bookingSchema.index({ status: 1, hostelAnswerBy: 1 });
bookingSchema.index({ status: 1, holdEndsAt: 1 });
bookingSchema.index({ hostelId: 1, hostelStrike: 1, endedAt: -1 });

export const BookingModel = models.Booking || model("Booking", bookingSchema);
