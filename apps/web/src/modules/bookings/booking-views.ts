import type { Types } from "mongoose";

import type { BookingStatus } from "@hostel/db/models/Booking";
import { PLATFORM_NAME } from "@hostel/shared/brand/brand";

import {
  cancellationSchedule,
  policyRows,
  settleBooking,
  settlementFor,
  type BookingEnding,
  type BookingTerms,
  type PolicyRow,
} from "@/modules/bookings/booking-terms";
import { amountDue, stayDatesText, type BookingStay } from "@/modules/bookings/short-stay";
import {
  PAYOUT_METHOD_LABELS,
  maskedPayoutNumber,
  type PayoutMethod,
} from "@/modules/bookings/payout-account.validation";

/**
 * What each side is shown of a booking.
 *
 * Pure: every function takes the row and the moment, so the web, the app and
 * the tests read the same shapes. The guest never sees the platform/hostel
 * split; the hostel never sees the guest's refund account; the superadmin sees
 * both, masked.
 */

export type BookingRecord = {
  _id: Types.ObjectId;
  bedHeld?: boolean;
  checkedInAt?: Date | null;
  code: string;
  confirmedAt?: Date | null;
  createdAt: Date;
  currency?: string;
  endReason?: string | null;
  endedAt?: Date | null;
  /** Null when the clock ended it (expiry, missed answer, no-show). */
  endedBy?: Types.ObjectId | null;
  fee: number;
  guest: { email?: string; name: string; phone?: string };
  holdEndsAt?: Date | null;
  hostelAnswerBy?: Date | null;
  hostelRemindersSent?: Array<{ at: Date; hoursLeft: number }>;
  hostelId: Types.ObjectId;
  moveInRemindersSent?: Array<{ at: Date; hoursLeft: number }>;
  hostelSnapshot: { address?: string; name: string; phone?: string; slug?: string };
  hostelStrike?: boolean;
  invoiceNumber: string;
  isOpen?: boolean;
  monthlyRent: number;
  paymentDueBy: Date;
  paymentRejection?: { at?: Date | null; reason?: string | null } | null;
  paymentSubmittedAt?: Date | null;
  paymentVerifiedAt?: Date | null;
  plannedMoveIn?: Date | null;
  policy: { acceptedAt: Date; source?: string; version: string };
  receiptNumber?: string | null;
  softmatoInvoiceNo?: string | null;
  refundAccount: {
    bankName?: string;
    branch?: string;
    holderName: string;
    method: PayoutMethod;
    numberLast4: string;
  };
  residentId?: Types.ObjectId | null;
  roomType: string;
  settlement?: {
    hostelShare?: number | null;
    kept?: number | null;
    platformShare?: number | null;
    refund?: number | null;
    refundPercent?: number | null;
    stayKept?: number | null;
    stayRefund?: number | null;
  } | null;
  status: BookingStatus;
  kind?: "MONTHLY" | "SHORT_STAY";
  stay?: BookingStay | null;
  terms: BookingTerms;
  userId: Types.ObjectId;
};

export type TransferRecord = {
  _id: Types.ObjectId;
  amount: number;
  bookingId: Types.ObjectId;
  createdAt?: Date;
  destination?: { bankName?: string; holderName?: string; method?: string | null; numberLast4?: string };
  hostelId?: Types.ObjectId;
  documentNumber?: string | null;
  kind: "PAYOUT" | "REFUND";
  sentAt?: Date | null;
  status: "DUE" | "SENT";
  transactionId?: string | null;
};

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  AWAITING_HOSTEL: "Waiting for the hostel",
  AWAITING_PAYMENT: "Waiting for payment",
  CANCELLED_BY_HOSTEL: "Cancelled by the hostel",
  CANCELLED_BY_PLATFORM: `Cancelled by ${PLATFORM_NAME}`,
  CANCELLED_BY_USER: "Cancelled",
  CHECKED_IN: "Moved in",
  CONFIRMED: "Confirmed",
  DECLINED: "Declined by the hostel",
  EXPIRED: "Not paid in time",
  HOSTEL_NO_RESPONSE: "Hostel did not answer",
  NO_SHOW: "Did not move in",
  PAYMENT_IN_REVIEW: "Checking payment",
};

const iso = (value?: Date | null) => (value ? new Date(value).toISOString() : null);

type DestinationLike = {
  bankName?: string;
  holderName?: string;
  method?: string | null;
  numberLast4?: string;
};

/** An account as a screen shows it: label, masked number, holder. */
export function describeDestination(destination: DestinationLike | null | undefined) {
  if (!destination?.method) {
    return null;
  }

  const method = destination.method as PayoutMethod;

  return {
    bankName: destination.bankName ?? "",
    holderName: destination.holderName ?? "",
    maskedNumber: maskedPayoutNumber(destination.numberLast4 ?? ""),
    method,
    methodLabel: PAYOUT_METHOD_LABELS[method],
  };
}

/** `eSewa ••••4321 (Sita Sharma)`, `Bank NIBL ••••7788 (Everest Hostel)`. */
export function destinationText(destination: DestinationLike | null | undefined) {
  const described = describeDestination(destination);

  return described
    ? `${[described.methodLabel, described.bankName, described.maskedNumber].filter(Boolean).join(" ")} (${described.holderName})`
    : "";
}

/** How `ending` at `at` would settle this booking: fee and, for a short stay, its nights. */
export function settleAs(booking: BookingRecord, ending: BookingEnding, at: Date) {
  return settleBooking({
    at,
    confirmedAt: booking.confirmedAt,
    ending,
    fee: booking.fee,
    stay: booking.stay,
    terms: booking.terms,
  });
}

/** What the hostel is paid once the guest checks in. */
export function hostelShareIfCheckedIn(booking: BookingRecord) {
  return settleAs(booking, "CHECKED_IN", new Date()).hostelShare;
}

/** What a guest who never comes gets back. */
export function noShowRefund(booking: BookingRecord) {
  return settleAs(booking, "NO_SHOW", booking.holdEndsAt ? new Date(booking.holdEndsAt) : new Date()).refund;
}

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

function stayView(stay: BookingStay | null | undefined): StayView | null {
  return stay
    ? {
        amount: stay.amount,
        dailyRate: stay.dailyRate,
        dates: stayDatesText(stay),
        holdBlocks: stay.holdBlocks,
        moveIn: new Date(stay.moveIn).toISOString().slice(0, 10),
        moveOut: new Date(stay.moveOut).toISOString().slice(0, 10),
        nights: stay.nights,
      }
    : null;
}

export type CancelPreview = {
  allowed: boolean;
  refund: number;
  refundPercent: number;
};

/** What pressing Cancel now would hand back. Server-computed, shown before the tap. */
export function cancelPreview(booking: BookingRecord, now = new Date()): CancelPreview {
  if (!booking.isOpen) {
    return { allowed: false, refund: 0, refundPercent: 0 };
  }

  if (booking.status === "CONFIRMED" && booking.confirmedAt) {
    const settled = settleAs(booking, "CANCELLED_BY_USER", now);

    return { allowed: true, refund: settled.refund, refundPercent: settled.refundPercent };
  }

  // While we are checking a screenshot nobody knows yet whether money arrived,
  // so there is no honest refund figure to offer. The check takes hours, and a
  // cancel right after it still hands the whole fee back.
  if (booking.status === "PAYMENT_IN_REVIEW") {
    return { allowed: false, refund: 0, refundPercent: 0 };
  }

  // Nothing is held until the hostel confirms. An unpaid booking refunds
  // nothing because nothing was paid; a paid one gets the whole fee back.
  const paid = booking.status === "AWAITING_HOSTEL";

  return { allowed: true, refund: paid ? amountDue(booking) : 0, refundPercent: paid ? 100 : 0 };
}

export type PolicySummary = {
  holdDays: number;
  hostelAnswerHours: number;
  noShowRefund: number;
  noShowRefundPercent: number;
  rows: PolicyRow[];
};

export function policySummary(terms: BookingTerms, fee: number): PolicySummary {
  return {
    holdDays: terms.holdDays,
    hostelAnswerHours: terms.hostelAnswerHours,
    noShowRefund: settlementFor(fee, terms.noShowRefundPercent, terms).refund,
    noShowRefundPercent: terms.noShowRefundPercent,
    rows: policyRows(terms, fee),
  };
}

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

export function toGuestView(
  booking: BookingRecord,
  options: { now?: Date; refundTransfer?: TransferRecord | null } = {},
): GuestBookingView {
  const now = options.now ?? new Date();
  const schedule = booking.confirmedAt
    ? cancellationSchedule(booking.terms, booking.fee, booking.confirmedAt)
    : null;
  const refund = options.refundTransfer ?? null;

  return {
    cancel: cancelPreview(booking, now),
    checkedInAt: iso(booking.checkedInAt),
    code: booking.code,
    confirmedAt: iso(booking.confirmedAt),
    createdAt: iso(booking.createdAt) ?? now.toISOString(),
    currency: booking.currency ?? "NPR",
    endReason: booking.endReason ?? null,
    endedAt: iso(booking.endedAt),
    fee: booking.fee,
    holdEndsAt: iso(booking.holdEndsAt),
    hostel: {
      address: booking.hostelSnapshot.address ?? "",
      id: String(booking.hostelId),
      name: booking.hostelSnapshot.name,
      phone: booking.hostelSnapshot.phone ?? "",
      slug: booking.hostelSnapshot.slug ?? "",
    },
    hostelAnswerBy: iso(booking.hostelAnswerBy),
    id: String(booking._id),
    invoiceNumber: booking.invoiceNumber,
    kind: booking.kind ?? "MONTHLY",
    monthlyRent: booking.monthlyRent,
    paymentDueBy: iso(booking.paymentDueBy) ?? now.toISOString(),
    paymentRejection: booking.paymentRejection?.reason
      ? { at: iso(booking.paymentRejection.at), reason: booking.paymentRejection.reason }
      : null,
    paymentSubmittedAt: iso(booking.paymentSubmittedAt),
    paymentVerifiedAt: iso(booking.paymentVerifiedAt),
    plannedMoveIn: booking.plannedMoveIn ? iso(booking.plannedMoveIn)!.slice(0, 10) : null,
    policy: policySummary(booking.terms, booking.fee),
    receiptNumber: booking.receiptNumber ?? null,
    refund: refund
      ? {
          amount: refund.amount,
          documentNumber: refund.status === "SENT" ? (refund.documentNumber ?? null) : null,
          sentAt: iso(refund.sentAt),
          status: refund.status,
          transactionId: refund.status === "SENT" ? (refund.transactionId ?? null) : null,
        }
      : null,
    refundAccount: {
      holderName: booking.refundAccount.holderName,
      maskedNumber: maskedPayoutNumber(booking.refundAccount.numberLast4),
      method: booking.refundAccount.method,
      methodLabel: PAYOUT_METHOD_LABELS[booking.refundAccount.method],
    },
    roomType: booking.roomType,
    schedule: schedule
      ? {
          noShow: {
            after: schedule.noShow.after.toISOString(),
            refund: schedule.noShow.refund,
            refundPercent: schedule.noShow.refundPercent,
          },
          steps: schedule.steps.map((step) => ({ ...step, until: step.until.toISOString() })),
        }
      : null,
    settlement:
      booking.settlement && typeof booking.settlement.refund === "number"
        ? { refund: booking.settlement.refund, refundPercent: booking.settlement.refundPercent ?? 0 }
        : null,
    status: booking.status,
    statusLabel: BOOKING_STATUS_LABELS[booking.status],
    stay: stayView(booking.stay),
    total: amountDue(booking),
  };
}

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

/**
 * The hostel's view. The guest's name and phone are shown only once the fee is
 * paid — before that there is nothing for the hostel to act on — and the guest's
 * refund account never.
 */
export function toHostelView(
  booking: BookingRecord,
  options: { payoutTransfer?: TransferRecord | null } = {},
): HostelBookingView {
  const payout = options.payoutTransfer ?? null;

  return {
    checkedInAt: iso(booking.checkedInAt),
    code: booking.code,
    confirmedAt: iso(booking.confirmedAt),
    createdAt: iso(booking.createdAt) ?? new Date().toISOString(),
    endReason: booking.endReason ?? null,
    endedAt: iso(booking.endedAt),
    guest: {
      email: booking.guest.email ?? "",
      name: booking.guest.name,
      phone: booking.guest.phone ?? "",
    },
    holdEndsAt: iso(booking.holdEndsAt),
    hostelAnswerBy: iso(booking.hostelAnswerBy),
    hostelShareIfKept: hostelShareIfCheckedIn(booking),
    id: String(booking._id),
    kind: booking.kind ?? "MONTHLY",
    monthlyRent: booking.monthlyRent,
    payout: payout
      ? {
          amount: payout.amount,
          documentNumber: payout.status === "SENT" ? (payout.documentNumber ?? null) : null,
          sentAt: iso(payout.sentAt),
          status: payout.status,
          transactionId: payout.status === "SENT" ? (payout.transactionId ?? null) : null,
        }
      : null,
    plannedMoveIn: booking.plannedMoveIn ? iso(booking.plannedMoveIn)!.slice(0, 10) : null,
    roomType: booking.roomType,
    settlement:
      booking.settlement && typeof booking.settlement.hostelShare === "number"
        ? { hostelShare: booking.settlement.hostelShare }
        : null,
    status: booking.status,
    statusLabel: BOOKING_STATUS_LABELS[booking.status],
    stay: stayView(booking.stay),
    strike: Boolean(booking.hostelStrike),
  };
}

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

export function toPlatformView(
  booking: BookingRecord,
  transfers: TransferRecord[] = [],
  now = new Date(),
): PlatformBookingView {
  const refundTransfer = transfers.find((transfer) => transfer.kind === "REFUND") ?? null;
  const settlement = booking.settlement;

  return {
    ...toGuestView(booking, { now, refundTransfer }),
    guest: {
      email: booking.guest.email ?? "",
      name: booking.guest.name,
      phone: booking.guest.phone ?? "",
    },
    hostelShareIfKept: hostelShareIfCheckedIn(booking),
    platformSettlement:
      settlement && typeof settlement.refund === "number"
        ? {
            hostelShare: settlement.hostelShare ?? 0,
            kept: settlement.kept ?? 0,
            platformShare: settlement.platformShare ?? 0,
            refund: settlement.refund,
          }
        : null,
    strike: Boolean(booking.hostelStrike),
    transfers: transfers.map((transfer) => ({
      amount: transfer.amount,
      documentNumber: transfer.documentNumber ?? null,
      id: String(transfer._id),
      kind: transfer.kind,
      sentAt: iso(transfer.sentAt),
      status: transfer.status,
      transactionId: transfer.transactionId ?? null,
    })),
    userId: String(booking.userId),
  };
}
