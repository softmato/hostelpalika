import type { PayoutMethod } from "@/lib/bookings/payout-account.validation";

export type BookingGuide = {
  /** False while bookings are switched off platform-wide: the page says so rather than pretending. */
  enabled: boolean;
  intro: string[];
  sections: PolicySection[];
};

export type RefundPolicy = {
  /** Website Config → Legal text with the live numbers filled in, when an owner wrote one. */
  customBody: string | null;
  intro: string[];
  sections: PolicySection[];
  /** The short-stay limits a form needs to show a daily rate's floor before it is sent. */
  shortStay: { hostelSharePercent: number; maxAdvanceDays: number; maxNights: number; minMarkupPercent: number };
  updatedAt: string;
  /** The same version the checkout sends back, so a screen can tell the policy moved. */
  version: string;
};

export type BookingPaymentToCheck = {
  amount: number;
  bookingCode: string;
  bookingId: string;
  checkBy: string;
  guest: { email: string; name: string; phone: string };
  hostelName: string;
  id: string;
  note: string | null;
  /** Read through `/api/v1/files/{id}/url`, which re-authorises every open. */
  proofAssetId: string;
  reference: string | null;
  roomType: string;
  submittedAt: string;
};

export type BookingReturnState =
  | { kind: "booking_paid"; code: string; hostelAnswerBy: string | null; hostelName: string }
  | { kind: "booking_refund"; code: string }
  | { kind: "unpaid" }
  | { kind: "pending_document" }
  | { kind: "unknown" };

export type TransferView = {
  amount: number;
  blocked: TransferBlock | null;
  bookingCode: string;
  bookingId: string;
  destination: {
    bankName: string;
    holderName: string;
    maskedNumber: string;
    method: PayoutMethod;
    methodLabel: string;
  } | null;
  documentNumber: string | null;
  dueSince: string | null;
  guestName: string;
  hostelName: string;
  id: string;
  kind: "PAYOUT" | "REFUND";
  roomType: string;
  sentAt: string | null;
  status: "DUE" | "SENT";
  transactionId: string | null;
};

export type PayoutAccountView = {
  bankName: string;
  branch: string;
  holderName: string;
  maskedNumber: string;
  method: PayoutMethod;
  methodLabel: string;
  reviewNote: string | null;
  reviewedAt: string | null;
  status: PayoutAccountStatus;
  submittedAt: string;
};

export type PayoutAccountForReview = PayoutAccountView & {
  hostelId: string;
  hostelName: string;
  /** Other hostels whose payout account has the same number. A fraud signal. */
  sharedWith: string[];
};

export type ShortStaySettingsView = {
  enabled: boolean;
  limits: { hostelSharePercent: number; maxNights: number; minMarkupPercent: number };
  minNights: number;
  rooms: ShortStayRoom[];
};

export type PolicySection = { body: string[]; icon: string; title: string };

export type TransferBlock = "NO_PAYOUT_ACCOUNT" | "PAYOUT_ACCOUNT_NOT_VERIFIED";

export type PayoutAccountStatus = "PENDING_REVIEW" | "VERIFIED" | "REJECTED";

export type ShortStayRoom = {
  dailyRate: number | null;
  /** The lowest daily rate this room type may be sold at. Null until it has a monthly rent. */
  floor: number | null;
  monthlyRent: number | null;
  roomType: string;
};

export type StayView = {
  amount: number;
  dailyRate: number;
  /** `4 Oct 2026 – 7 Oct 2026 (Asoj 18–21)`. */
  dates: string;
  holdBlocks: number;
  moveIn: string;
  moveOut: string;
  nights: number;
};

export type CancelPreview = {
  allowed: boolean;
  refund: number;
  refundPercent: number;
};

export type PolicySummary = {
  holdDays: number;
  hostelAnswerHours: number;
  noShowRefund: number;
  noShowRefundPercent: number;
  rows: PolicyRow[];
};

export type GuestBookingView = {
  cancel: CancelPreview;
  checkedInAt: string | null;
  code: string;
  confirmedAt: string | null;
  createdAt: string;
  currency: string;
  endReason: string | null;
  endedAt: string | null;
  fee: number;
  holdEndsAt: string | null;
  hostel: { address: string; id: string; name: string; phone: string; slug: string };
  hostelAnswerBy: string | null;
  id: string;
  invoiceNumber: string;
  kind: "MONTHLY" | "SHORT_STAY";
  monthlyRent: number;
  paymentDueBy: string;
  paymentRejection: { at: string | null; reason: string | null } | null;
  paymentSubmittedAt: string | null;
  paymentVerifiedAt: string | null;
  plannedMoveIn: string | null;
  policy: PolicySummary;
  receiptNumber: string | null;
  refund: {
    amount: number;
    /** The refund note's number, once sent. */
    documentNumber: string | null;
    sentAt: string | null;
    status: "DUE" | "SENT";
    transactionId: string | null;
  } | null;
  refundAccount: { holderName: string; maskedNumber: string; method: PayoutMethod; methodLabel: string };
  roomType: string;
  schedule: {
    noShow: { after: string; refund: number; refundPercent: number };
    steps: Array<PolicyRow & { until: string }>;
  } | null;
  settlement: { refund: number; refundPercent: number } | null;
  status: BookingStatus;
  statusLabel: string;
  stay: StayView | null;
  /** What the guest pays: the fee, plus a short stay's nights. */
  total: number;
};

export type HostelBookingView = {
  checkedInAt: string | null;
  code: string;
  confirmedAt: string | null;
  createdAt: string;
  endReason: string | null;
  endedAt: string | null;
  guest: { email: string; name: string; phone: string };
  holdEndsAt: string | null;
  hostelAnswerBy: string | null;
  /** What the hostel gets if the booking runs to the end. */
  hostelShareIfKept: number;
  id: string;
  kind: "MONTHLY" | "SHORT_STAY";
  monthlyRent: number;
  payout: {
    amount: number;
    /** The payout advice's number, once sent. */
    documentNumber: string | null;
    sentAt: string | null;
    status: "DUE" | "SENT";
    transactionId: string | null;
  } | null;
  plannedMoveIn: string | null;
  roomType: string;
  settlement: { hostelShare: number } | null;
  status: BookingStatus;
  statusLabel: string;
  stay: StayView | null;
  strike: boolean;
};

export type PlatformBookingView = GuestBookingView & {
  guest: { email: string; name: string; phone: string };
  hostelShareIfKept: number;
  platformSettlement: {
    hostelShare: number;
    kept: number;
    platformShare: number;
    refund: number;
  } | null;
  strike: boolean;
  transfers: Array<{
    amount: number;
    documentNumber: string | null;
    id: string;
    kind: "PAYOUT" | "REFUND";
    sentAt: string | null;
    status: "DUE" | "SENT";
    transactionId: string | null;
  }>;
  userId: string;
};

export type PayInstructions = {
  amount: number;
  checkHours: number;
  payBy: string;
  qr: { label: string; url: string } | null;
  /** What goes in the remarks box: the booking code. */
  reference: string;
};

export type GuestBookingDetail = GuestBookingView & {
  coverPhotoUrl: string | null;
  pay: PayInstructions | null;
};

export type BookingQuote = {
  available: boolean;
  fee: number | null;
  hostel: {
    address: string;
    coverPhotoUrl: string | null;
    hostelType: string | null;
    id: string;
    name: string;
    phone: string;
    slug: string;
  };
  /** The person's open booking elsewhere, which would block a new one. */
  openBooking: { code: string; hostelName: string; id: string } | null;
  payment: { checkHours: number; qrReady: boolean; unpaidWindowHours: number };
  policy: PolicySummary | null;
  policyVersion: string;
  reason: BookingUnavailableReason | null;
  reasonMessage: string | null;
  room: RoomAvailability;
  /**
   * The short-stay side of the same room. `quote` is priced once both dates are
   * given and valid; `error` says why dates were refused.
   */
  shortStay: {
    available: boolean;
    dailyRate: number | null;
    error: { code: string; message: string } | null;
    limits: { maxAdvanceDays: number; maxNights: number; minNights: number } | null;
    quote: {
      fee: number;
      holdBlocks: number;
      moveIn: string;
      moveOut: string;
      nights: number;
      stayAmount: number;
      total: number;
    } | null;
  };
  terms: { feePercent: number; holdDays: number; hostelAnswerHours: number };
};

export type GuestBookingSummary = {
  code: string;
  /** The hostel's cover, so the list is recognisable at a glance. */
  coverPhotoUrl: string | null;
  createdAt: string;
  fee: number;
  holdEndsAt: string | null;
  hostelName: string;
  id: string;
  roomType: string;
  status: GuestBookingView["status"];
  statusLabel: string;
};

export type PolicyRow = {
  fromDay: number;
  refund: number;
  refundPercent: number;
  throughDay: number;
};

export type BookingUnavailableReason =
  /** Bookings are switched off platform-wide. */
  | "BOOKINGS_OFF"
  /** The hostel is not a live, verified listing. */
  | "HOSTEL_NOT_LIVE"
  /** The hostel's plan suspension has started. */
  | "HOSTEL_SUSPENDED"
  /** Strikes, or a superadmin, paused bookings on this hostel. */
  | "BOOKINGS_PAUSED"
  /** The platform has nowhere verified to pay the hostel its share. */
  | "NO_PAYOUT_ACCOUNT"
  /** The rate card has no current rent for this room type. */
  | "NOT_PRICED"
  /** No vacant bed of this room type. */
  | "FULL"
  /** The hostel does not list this room type. */
  | "ROOM_NOT_FOUND";

export type RoomAvailability = {
  bedsPerRoom: number | null;
  bookable: boolean;
  /**
   * A night's price for a short stay: the hostel's rate, never below today's
   * floor (a rent rise since the rate was set lifts it). Null when this room
   * type takes no short stays.
   */
  dailyRate: number | null;
  fee: number | null;
  mealInclusion: string | null;
  monthlyRent: number | null;
  /**
   * Only this room type's own ROOM photos, never the hostel's exterior or
   * another room's: the checkout shows them as the room being booked.
   */
  photos: string[];
  reason: BookingUnavailableReason | null;
  roomType: string;
  vacantBeds: number;
};

/** `BOOKING_STATUSES` in `@hostel/db/models/Booking`, as the API sends it. */
export type BookingStatus =
  | "AWAITING_PAYMENT"
  | "PAYMENT_IN_REVIEW"
  | "AWAITING_HOSTEL"
  | "CONFIRMED"
  | "CHECKED_IN"
  | "EXPIRED"
  | "DECLINED"
  | "HOSTEL_NO_RESPONSE"
  | "CANCELLED_BY_USER"
  | "CANCELLED_BY_HOSTEL"
  | "CANCELLED_BY_PLATFORM"
  | "NO_SHOW";
