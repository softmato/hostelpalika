/**
 * Room booking — docs/BOOKINGS.md items 21–24.
 *
 * Typed from `apps/web/src/modules/bookings/booking.service.ts`,
 * `booking-views.ts` and `booking-policy.service.ts`, not from the route names.
 * The person pays HostelPalika a booking fee; the hostel confirms; the booking
 * closes when the hostel scans their ID card.
 *
 * Availability, the quote for a signed-out visitor and the policy use
 * `publicApi`: a browsing visitor must never be bounced to a login by an
 * unrelated token expiry. Everything about a booking itself is the account's.
 */

import { API_BASE_URL, api, publicApi } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";

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

export const OPEN_BOOKING_STATUSES: readonly BookingStatus[] = [
  "AWAITING_PAYMENT",
  "PAYMENT_IN_REVIEW",
  "AWAITING_HOSTEL",
  "CONFIRMED",
];

export type BookingAvailability = {
  hostelReason: string | null;
  rooms: { bookable: boolean; fee: number | null; photos: string[]; reason: string | null; roomType: string }[];
};

export type PolicyRow = { fromDay: number; refund: number; refundPercent: number; throughDay: number };

export type PolicySummary = {
  holdDays: number;
  hostelAnswerHours: number;
  noShowRefund: number;
  noShowRefundPercent: number;
  rows: PolicyRow[];
};

export type BookingQuote = {
  available: boolean;
  fee: number | null;
  hostel: { address: string; coverPhotoUrl: string | null; id: string; name: string; phone: string; slug: string };
  openBooking: { code: string; hostelName: string; id: string } | null;
  payment: { checkHours: number; qrReady: boolean; unpaidWindowHours: number };
  policy: PolicySummary | null;
  policyVersion: string;
  reason: string | null;
  reasonMessage: string | null;
  room: {
    bedsPerRoom: number | null;
    mealInclusion: string | null;
    monthlyRent: number | null;
    /** This room type's own photos — never the hostel's exterior. */
    photos: string[];
    roomType: string;
  };
  /** The short-stay side of the same room; `quote` is priced once both dates are valid. */
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

export type BookingDetail = {
  cancel: { allowed: boolean; refund: number; refundPercent: number };
  checkedInAt: string | null;
  code: string;
  confirmedAt: string | null;
  coverPhotoUrl: string | null;
  createdAt: string;
  endReason: string | null;
  endedAt: string | null;
  fee: number;
  holdEndsAt: string | null;
  hostel: { address: string; id: string; name: string; phone: string; slug: string };
  hostelAnswerBy: string | null;
  id: string;
  invoiceNumber: string;
  monthlyRent: number;
  pay: {
    amount: number;
    checkHours: number;
    payBy: string;
    qr: { label: string; url: string } | null;
    reference: string;
  } | null;
  paymentDueBy: string;
  paymentRejection: { at: string | null; reason: string | null } | null;
  paymentSubmittedAt: string | null;
  paymentVerifiedAt: string | null;
  plannedMoveIn: string | null;
  policy: PolicySummary;
  receiptNumber: string | null;
  refund: {
    amount: number;
    documentNumber: string | null;
    sentAt: string | null;
    status: "DUE" | "SENT";
    transactionId: string | null;
  } | null;
  refundAccount: { holderName: string; maskedNumber: string; method: RefundMethod; methodLabel: string };
  roomType: string;
  schedule: {
    noShow: { after: string; refund: number; refundPercent: number };
    steps: (PolicyRow & { until: string })[];
  } | null;
  settlement: { refund: number; refundPercent: number } | null;
  status: BookingStatus;
  statusLabel: string;
  stay: { amount: number; dailyRate: number; dates: string; nights: number } | null;
  /** The fee, plus a short stay's nights. */
  total: number;
};

export type BookingSummary = {
  code: string;
  coverPhotoUrl: string | null;
  createdAt: string;
  fee: number;
  holdEndsAt: string | null;
  hostelName: string;
  id: string;
  roomType: string;
  status: BookingStatus;
  statusLabel: string;
};

export type RefundMethod = "BANK" | "ESEWA" | "KHALTI";

export type RefundAccountInput = {
  bankName: string;
  branch: string;
  holderName: string;
  method: RefundMethod;
  number: string;
};

export type RefundPolicy = {
  customBody: string | null;
  intro: string[];
  sections: { body: string[]; icon: string; title: string }[];
  /** The short-stay limits, for a form that shows a daily rate's floor before sending it. */
  shortStay: { hostelSharePercent: number; maxAdvanceDays: number; maxNights: number; minMarkupPercent: number };
  updatedAt: string;
  version: string;
};

/** How booking works, from `booking-guide.service.ts`. */
export type BookingGuide = {
  enabled: boolean;
  intro: string[];
  sections: { body: string[]; icon: string; title: string }[];
};

export async function getBookingAvailability(slug: string) {
  const response = await publicApi.get<ApiEnvelope<{ availability: BookingAvailability }>>(
    "/bookings/availability",
    { params: { hostel: slug } },
  );

  return unwrap(response).availability;
}

/** `signedIn` adds the one fact that depends on who is looking: an open booking that would block this one. */
export async function getBookingQuote(
  slug: string,
  roomType: string,
  signedIn: boolean,
  stay?: { moveIn: string; moveOut: string } | null,
) {
  const response = await (signedIn ? api : publicApi).get<ApiEnvelope<{ quote: BookingQuote }>>(
    "/bookings/quote",
    { params: { hostel: slug, roomType, ...(stay ?? {}) } },
  );

  return unwrap(response).quote;
}

export async function createBooking(input: {
  hostel: string;
  kind?: "MONTHLY" | "SHORT_STAY";
  moveIn?: string;
  moveOut?: string;
  plannedMoveIn?: string | null;
  policyVersion: string;
  refundAccount: RefundAccountInput;
  roomType: string;
}) {
  const response = await api.post<ApiEnvelope<{ booking: BookingDetail }>>("/bookings", {
    ...input,
    acceptPolicy: true,
  });

  return unwrap(response).booking;
}

export async function listMyBookings() {
  const response = await api.get<ApiEnvelope<{ bookings: BookingSummary[] }>>("/bookings");

  return unwrap(response).bookings;
}

export async function getMyBooking(id: string) {
  const response = await api.get<ApiEnvelope<{ booking: BookingDetail }>>(`/bookings/${encodeURIComponent(id)}`);

  return unwrap(response).booking;
}

/** A Softmato checkout for the fee; its return page hands back through the app's deep link. */
export async function openBookingCheckout(id: string) {
  const response = await api.post<ApiEnvelope<{ checkoutUrl: string }>>(
    `/bookings/${encodeURIComponent(id)}/checkout?via=app`,
  );

  return unwrap(response).checkoutUrl;
}

/** What happened to the fee, read from Softmato by the server — never from the deep link. */
export async function confirmBookingReturn(id: string) {
  const response = await api.get<ApiEnvelope<{ state: { kind: string } }>>(
    `/bookings/${encodeURIComponent(id)}/return`,
  );

  return unwrap(response).state;
}

/** `expectedRefund` is the figure on screen; if the clock moved it the server answers 409 `REFUND_CHANGED`. */
export async function cancelMyBooking(id: string, expectedRefund: number) {
  const response = await api.post<ApiEnvelope<{ booking: BookingDetail }>>(
    `/bookings/${encodeURIComponent(id)}/cancel`,
    { expectedRefund },
  );

  return unwrap(response).booking;
}

export async function getRefundPolicy() {
  const response = await publicApi.get<ApiEnvelope<{ policy: RefundPolicy }>>("/bookings/policy");

  return unwrap(response).policy;
}

export async function getBookingGuide() {
  const response = await publicApi.get<ApiEnvelope<{ guide: BookingGuide }>>("/bookings/guide");

  return unwrap(response).guide;
}

export function bookingDocumentUrl(kind: "invoice" | "receipt" | "refund", number: string) {
  return `${API_BASE_URL}/api/v1/bookings/documents/${kind}/${encodeURIComponent(number)}`;
}

export function isOpenBooking(status: BookingStatus) {
  return OPEN_BOOKING_STATUSES.includes(status);
}
