/**
 * A hostel's side of bookings — docs/BOOKINGS.md items 25–27.
 *
 * Typed from `apps/web/src/modules/bookings/booking-views.ts` (`toHostelView`),
 * `booking-queries.service.ts`, `booking-checkin.service.ts` and
 * `payout-account.service.ts`. Owner-only on the server except the card lookup,
 * which anyone allowed to register residents may make.
 */

import { api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";
import type { BookingStatus, RefundAccountInput } from "@/lib/booking-api";

export type HostelBooking = {
  checkedInAt: string | null;
  code: string;
  confirmedAt: string | null;
  createdAt: string;
  endReason: string | null;
  endedAt: string | null;
  guest: { email: string; name: string; phone: string };
  holdEndsAt: string | null;
  hostelAnswerBy: string | null;
  hostelShareIfKept: number;
  id: string;
  monthlyRent: number;
  payout: {
    amount: number;
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
  strike: boolean;
};

export type HostelBookingsTab = "confirmed" | "history" | "requests";

export type HostelBookings = {
  bookings: HostelBooking[];
  counts: { confirmed: number; requests: number };
  owed: { due: number; sent: number };
  pause: { pausedAt: string | null; reason: string | null };
};

export async function listHostelBookings(tab: HostelBookingsTab) {
  const response = await api.get<ApiEnvelope<HostelBookings>>("/hostel-admin/bookings", { params: { tab } });

  return unwrap(response);
}

/** `decline` takes an optional reason; `cancel` requires one and counts against the hostel. */
export async function answerHostelBooking(id: string, action: "cancel" | "confirm" | "decline", reason?: string) {
  const response = await api.post<ApiEnvelope<{ booking: HostelBooking }>>(
    `/hostel-admin/bookings/${encodeURIComponent(id)}/${action}`,
    reason ? { reason } : {},
  );

  return unwrap(response).booking;
}

export type CardBooking = { code: string; guestName: string; holdEndsAt: string | null; roomType: string };

/** The booking a scanned ID card holds at this hostel, for the intake banner. */
export async function findCardBooking(card: string) {
  const response = await api.get<ApiEnvelope<{ booking: CardBooking | null }>>("/hostel-admin/bookings/card", {
    params: { card },
  });

  return unwrap(response).booking;
}

export type PayoutAccount = {
  bankName: string;
  branch: string;
  holderName: string;
  maskedNumber: string;
  method: RefundAccountInput["method"];
  methodLabel: string;
  reviewNote: string | null;
  reviewedAt: string | null;
  status: "PENDING_REVIEW" | "REJECTED" | "VERIFIED";
  submittedAt: string;
};

export async function getPayoutAccount() {
  const response = await api.get<ApiEnvelope<{ account: PayoutAccount | null }>>("/hostel-admin/payout-account");

  return unwrap(response).account;
}

/** Any change goes back to the platform's check; nothing is paid out until it passes. */
export async function savePayoutAccount(input: RefundAccountInput) {
  const response = await api.put<ApiEnvelope<{ account: PayoutAccount }>>("/hostel-admin/payout-account", input);

  return unwrap(response).account;
}

export type ShortStayRoom = {
  dailyRate: number | null;
  /** The lowest daily rate allowed. Null until the room type has a monthly rent. */
  floor: number | null;
  monthlyRent: number | null;
  roomType: string;
};

export type ShortStaySettings = {
  enabled: boolean;
  limits: { hostelSharePercent: number; maxNights: number; minMarkupPercent: number };
  minNights: number;
  rooms: ShortStayRoom[];
};

export async function getShortStaySettings() {
  const response = await api.get<ApiEnvelope<ShortStaySettings>>("/hostel-admin/bookings/short-stays");

  return unwrap(response);
}

/** A daily rate below its room's floor is refused with the floor in the message. */
export async function saveShortStaySettings(input: {
  enabled: boolean;
  minNights: number;
  rates: { dailyRate: number; roomType: string }[];
}) {
  const response = await api.put<ApiEnvelope<ShortStaySettings>>("/hostel-admin/bookings/short-stays", input);

  return unwrap(response);
}
