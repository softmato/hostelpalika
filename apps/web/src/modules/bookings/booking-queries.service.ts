import "server-only";

import { Types } from "mongoose";

import {
  BOOKING_STATUSES,
  BookingModel,
  type BookingStatus,
} from "@hostel/db/models/Booking";
import { BookingPaymentModel } from "@hostel/db/models/BookingPayment";
import { BookingTransferModel } from "@hostel/db/models/BookingTransfer";
import { HostelModel } from "@hostel/db/models/Hostel";

import { connectToDatabase } from "@/lib/db";
import {
  toHostelView,
  toPlatformView,
  type BookingRecord,
  type TransferRecord,
} from "@/modules/bookings/booking-views";
import { BookingError } from "@/modules/bookings/booking.errors";

/**
 * The lists the hostel and the platform work from. Reads only.
 *
 * A hostel sees a booking only once its fee is checked — before that there is
 * nothing for it to answer, and no name it needs.
 */

const iso = (value?: Date | null) => (value ? new Date(value).toISOString() : null);

const ENDED: BookingStatus[] = [
  "CHECKED_IN",
  "DECLINED",
  "HOSTEL_NO_RESPONSE",
  "CANCELLED_BY_USER",
  "CANCELLED_BY_HOSTEL",
  "CANCELLED_BY_PLATFORM",
  "NO_SHOW",
];

export const HOSTEL_BOOKING_TABS = {
  confirmed: { sort: { holdEndsAt: 1 }, statuses: ["CONFIRMED"] as BookingStatus[] },
  history: { sort: { endedAt: -1 }, statuses: ENDED },
  requests: { sort: { hostelAnswerBy: 1 }, statuses: ["AWAITING_HOSTEL"] as BookingStatus[] },
} as const;

export type HostelBookingTab = keyof typeof HOSTEL_BOOKING_TABS;

async function transfersByBooking(bookings: BookingRecord[]) {
  const transfers = bookings.length
    ? await BookingTransferModel.find({ bookingId: { $in: bookings.map((booking) => booking._id) } })
        .lean<TransferRecord[]>()
    : [];
  const grouped = new Map<string, TransferRecord[]>();

  for (const transfer of transfers) {
    const key = String(transfer.bookingId);

    grouped.set(key, [...(grouped.get(key) ?? []), transfer]);
  }

  return grouped;
}

export async function listHostelBookings(hostelId: Types.ObjectId | string, tab: string | null) {
  await connectToDatabase();

  const chosen = HOSTEL_BOOKING_TABS[(tab ?? "requests") as HostelBookingTab] ?? HOSTEL_BOOKING_TABS.requests;
  const paid = { hostelId, paymentVerifiedAt: { $ne: null } };

  const [bookings, requests, confirmed, payouts, hostel] = await Promise.all([
    BookingModel.find({ ...paid, status: { $in: chosen.statuses } })
      .sort(chosen.sort)
      .limit(200)
      .lean<BookingRecord[]>(),
    BookingModel.countDocuments({ ...paid, status: "AWAITING_HOSTEL" }),
    BookingModel.countDocuments({ ...paid, status: "CONFIRMED" }),
    BookingTransferModel.find({ hostelId, kind: "PAYOUT" })
      .select("amount bookingId documentNumber sentAt status transactionId")
      .lean<TransferRecord[]>(),
    HostelModel.findById(hostelId)
      .select("bookingPause")
      .lean<{ bookingPause?: { pausedAt?: Date | null; reason?: string | null } } | null>(),
  ]);
  const payoutByBooking = new Map(payouts.map((payout) => [String(payout.bookingId), payout]));
  const total = (status: "DUE" | "SENT") =>
    payouts.filter((payout) => payout.status === status).reduce((sum, payout) => sum + payout.amount, 0);

  return {
    bookings: bookings.map((booking) =>
      toHostelView(booking, { payoutTransfer: payoutByBooking.get(String(booking._id)) ?? null }),
    ),
    counts: { confirmed, requests },
    owed: { due: total("DUE"), sent: total("SENT") },
    pause: {
      pausedAt: iso(hostel?.bookingPause?.pausedAt),
      reason: hostel?.bookingPause?.reason ?? null,
    },
  };
}

export const PLATFORM_BOOKING_TABS = ["waiting", "holds", "all"] as const;

export async function listPlatformBookings(input: { hostelId?: string | null; status?: string | null; tab?: string | null }) {
  await connectToDatabase();

  const tab = (PLATFORM_BOOKING_TABS as readonly string[]).includes(input.tab ?? "") ? input.tab : "all";
  const filter: Record<string, unknown> = {};
  let sort: Record<string, 1 | -1> = { createdAt: -1 };

  if (tab === "waiting") {
    filter.status = "AWAITING_HOSTEL";
    sort = { hostelAnswerBy: 1 };
  } else if (tab === "holds") {
    filter.status = "CONFIRMED";
    sort = { holdEndsAt: 1 };
  } else if (input.status && (BOOKING_STATUSES as readonly string[]).includes(input.status)) {
    filter.status = input.status;
  }

  if (input.hostelId && Types.ObjectId.isValid(input.hostelId)) {
    filter.hostelId = new Types.ObjectId(input.hostelId);
  }

  const [bookings, payments, waiting, holds, refundsDue, payoutsDue] = await Promise.all([
    BookingModel.find(filter).sort(sort).limit(200).lean<BookingRecord[]>(),
    BookingPaymentModel.countDocuments({ status: "IN_REVIEW" }),
    BookingModel.countDocuments({ status: "AWAITING_HOSTEL" }),
    BookingModel.countDocuments({ status: "CONFIRMED" }),
    BookingTransferModel.countDocuments({ kind: "REFUND", status: "DUE" }),
    BookingTransferModel.countDocuments({ kind: "PAYOUT", status: "DUE" }),
  ]);
  const transfers = await transfersByBooking(bookings);
  const now = new Date();

  return {
    bookings: bookings.map((booking) => toPlatformView(booking, transfers.get(String(booking._id)) ?? [], now)),
    counts: { holds, payments, payoutsDue, refundsDue, waiting },
  };
}

export async function getPlatformBooking(bookingId: string) {
  await connectToDatabase();

  const booking = Types.ObjectId.isValid(bookingId)
    ? await BookingModel.findById(bookingId).lean<BookingRecord | null>()
    : null;

  if (!booking) {
    throw new BookingError("Booking not found.", "BOOKING_NOT_FOUND", 404);
  }

  const transfers = await transfersByBooking([booking]);

  return toPlatformView(booking, transfers.get(String(booking._id)) ?? []);
}

/** Hostels whose Book button is off, newest pause first. */
export async function listPausedHostels() {
  await connectToDatabase();

  const hostels = await HostelModel.find({ "bookingPause.pausedAt": { $ne: null }, isDeleted: { $ne: true } })
    .select("_id bookingPause name slug")
    .sort({ "bookingPause.pausedAt": -1 })
    .limit(200)
    .lean<Array<{
      _id: Types.ObjectId;
      bookingPause: { pausedAt: Date; pausedBy?: Types.ObjectId | null; reason?: string | null };
      name: string;
      slug?: string;
    }>>();

  return hostels.map((hostel) => ({
    automatic: !hostel.bookingPause.pausedBy,
    id: String(hostel._id),
    name: hostel.name,
    pausedAt: iso(hostel.bookingPause.pausedAt),
    reason: hostel.bookingPause.reason ?? null,
    slug: hostel.slug ?? "",
  }));
}
