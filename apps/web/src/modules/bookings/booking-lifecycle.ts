import "server-only";

import { Types } from "mongoose";

import { AuditLogModel } from "@hostel/db/models/AuditLog";
import {
  BookingModel,
  isOpenBookingStatus,
  type BookingStatus,
} from "@hostel/db/models/Booking";
import { BookingTransferModel } from "@hostel/db/models/BookingTransfer";
import { HostelModel } from "@hostel/db/models/Hostel";

import { logger } from "@/lib/logger";
import { fileBookingRefund } from "@/modules/bookings/booking-refund.service";
import { getBookingConfig } from "@/modules/bookings/booking-config";
import { announceBookingsPaused } from "@/modules/bookings/booking-notify";
import { DAY_MS, settleBooking, type BookingEnding } from "@/modules/bookings/booking-terms";
import type { BookingRecord } from "@/modules/bookings/booking-views";
import { releaseBedForRoomType } from "@/modules/hostels/hostel-capacity.service";

/**
 * The two writes every booking step is made of: move the status, and end it.
 *
 * Both are conditional on the status being left, so the sweep and a person
 * pressing a button at the same second cannot both act — the loser gets `null`
 * and does nothing. Everything with a side effect (money owed, a bed released,
 * a strike) happens only after the winning write, and is itself idempotent.
 */

export async function moveBooking(
  bookingId: Types.ObjectId | string,
  from: BookingStatus | readonly BookingStatus[],
  set: Record<string, unknown> & { status: BookingStatus },
  extra: { push?: Record<string, unknown> } = {},
): Promise<BookingRecord | null> {
  const statuses = Array.isArray(from) ? from : [from];

  return BookingModel.findOneAndUpdate(
    { _id: bookingId, status: { $in: statuses } },
    {
      $set: { ...set, isOpen: isOpenBookingStatus(set.status) },
      ...(extra.push ? { $push: extra.push } : {}),
    },
    { new: true },
  ).lean<BookingRecord | null>();
}

/** Which money ending a final status is, for `settleBooking`. */
const ENDING_FOR_STATUS: Partial<Record<BookingStatus, BookingEnding>> = {
  CANCELLED_BY_HOSTEL: "CANCELLED_BY_HOSTEL",
  CANCELLED_BY_PLATFORM: "CANCELLED_BY_PLATFORM",
  CHECKED_IN: "CHECKED_IN",
  DECLINED: "DECLINED",
  HOSTEL_NO_RESPONSE: "HOSTEL_NO_RESPONSE",
  NO_SHOW: "NO_SHOW",
};

function endingFor(booking: BookingRecord, status: BookingStatus): BookingEnding | null {
  if (status === "CANCELLED_BY_USER") {
    return booking.status === "CONFIRMED" ? "CANCELLED_BY_USER" : "CANCELLED_BEFORE_CONFIRMATION";
  }

  return ENDING_FOR_STATUS[status] ?? null;
}

export type EndBookingInput = {
  actorId: string | null;
  from: readonly BookingStatus[];
  now?: Date;
  reason?: string | null;
  /** Counted against the hostel: a missed answer or a hostel cancellation. */
  strike?: boolean;
  status: BookingStatus;
  /** Extra fields written with the ending — check-in details, say. */
  set?: Record<string, unknown>;
  /** `false` when the held bed becomes a resident's bed instead of going back. */
  releaseBed?: boolean;
};

/**
 * Ends a booking and raises whatever money it owes.
 *
 * A booking that was never paid owes nothing and settles nothing. A paid one
 * is settled from its own frozen terms at `now`, and each non-zero part becomes
 * a `DUE` transfer — one refund, one payout, never two of either, whatever runs
 * this twice.
 */
export async function endBooking(
  booking: BookingRecord,
  input: EndBookingInput,
): Promise<BookingRecord | null> {
  const now = input.now ?? new Date();
  const ending = endingFor(booking, input.status);
  const paid = Boolean(booking.paymentVerifiedAt);
  const settlement =
    paid && ending
      ? settleBooking({
          at: now,
          confirmedAt: booking.confirmedAt,
          ending,
          fee: booking.fee,
          stay: booking.stay,
          terms: booking.terms,
        })
      : null;

  const ended = await moveBooking(booking._id, input.from, {
    ...(input.set ?? {}),
    bedHeld: false,
    endReason: input.reason?.trim().slice(0, 500) || null,
    endedAt: now,
    endedBy: input.actorId,
    hostelStrike: Boolean(input.strike),
    settlement: settlement ?? {
      hostelShare: null,
      kept: null,
      platformShare: null,
      refund: null,
      refundPercent: null,
    },
    status: input.status,
  });

  if (!ended) {
    return null;
  }

  if (booking.bedHeld && input.releaseBed !== false) {
    await releaseBedForRoomType(booking.hostelId, booking.roomType).catch((error: unknown) => {
      logger.error("Booking ended but its held bed could not be released.", {
        bookingId: String(booking._id),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  if (settlement) {
    await raiseTransfers(ended, settlement);
    // The refund is tracked where the fee was taken: filed with Softmato too.
    if (settlement.refund > 0) await fileBookingRefund(ended, settlement.refund);
  }

  await AuditLogModel.create({
    action: "BOOKING_ENDED",
    actorId: input.actorId ?? undefined,
    actorType: input.actorId ? "USER" : "SYSTEM",
    entityId: String(booking._id),
    entityType: "Booking",
    hostelId: booking.hostelId,
    metadata: {
      code: booking.code,
      from: booking.status,
      reason: input.reason ?? null,
      settlement,
      status: input.status,
      strike: Boolean(input.strike),
    },
  }).catch(() => undefined);

  if (input.strike) {
    const rule = await applyStrikeRule(booking.hostelId, now);

    if (rule.paused) {
      await announceBookingsPaused(ended, rule);
    }
  }

  return ended;
}

async function raiseTransfers(
  booking: BookingRecord,
  settlement: { hostelShare: number; refund: number },
) {
  const base = { bookingId: booking._id, hostelId: booking.hostelId, userId: booking.userId };
  const writes: Array<Promise<unknown>> = [];

  if (settlement.refund > 0) {
    writes.push(
      BookingTransferModel.updateOne(
        { bookingId: booking._id, kind: "REFUND" },
        { $setOnInsert: { ...base, amount: settlement.refund, kind: "REFUND", status: "DUE" } },
        { upsert: true },
      ),
    );
  }

  if (settlement.hostelShare > 0) {
    writes.push(
      BookingTransferModel.updateOne(
        { bookingId: booking._id, kind: "PAYOUT" },
        { $setOnInsert: { ...base, amount: settlement.hostelShare, kind: "PAYOUT", status: "DUE" } },
        { upsert: true },
      ),
    );
  }

  await Promise.all(writes);
}

/**
 * Pauses bookings on a hostel that has missed or cancelled too many.
 *
 * Counted from the bookings themselves (`hostelStrike` inside the window), so
 * there is no counter to drift. The window never reaches back past the last
 * resume — otherwise the strikes a superadmin just forgave would pause the
 * hostel again on the very next one. Only ever sets the pause; lifting it is a
 * superadmin's decision. Returns whether this call paused the hostel, so the
 * caller can tell people exactly once.
 */
export async function applyStrikeRule(hostelId: Types.ObjectId, now = new Date()) {
  const config = await getBookingConfig();
  const hostel = await HostelModel.findById(hostelId)
    .select("bookingPause")
    .lean<{ bookingPause?: { resumedAt?: Date | null } } | null>();
  const windowStart = now.getTime() - config.strikeWindowDays * DAY_MS;
  const resumedAt = hostel?.bookingPause?.resumedAt ? new Date(hostel.bookingPause.resumedAt).getTime() : 0;
  const since = new Date(Math.max(windowStart, resumedAt));
  const windowDays = config.strikeWindowDays;

  const strikes = await BookingModel.countDocuments({
    endedAt: { $gt: since },
    hostelId,
    hostelStrike: true,
  });

  if (strikes < config.strikeLimit) {
    return { paused: false, strikes, windowDays };
  }

  const paused = await HostelModel.updateOne(
    { _id: hostelId, "bookingPause.pausedAt": null },
    {
      $set: {
        "bookingPause.pausedAt": now,
        "bookingPause.pausedBy": null,
        "bookingPause.reason": `${strikes} missed or cancelled bookings in ${config.strikeWindowDays} days`,
      },
    },
  );

  const didPause = (paused.modifiedCount ?? 0) > 0;

  if (didPause) {
    await AuditLogModel.create({
      action: "HOSTEL_BOOKINGS_PAUSED",
      actorType: "SYSTEM",
      entityId: String(hostelId),
      entityType: "Hostel",
      hostelId,
      metadata: { strikeLimit: config.strikeLimit, strikes, windowDays: config.strikeWindowDays },
    }).catch(() => undefined);
  }

  return { paused: didPause, strikes, windowDays };
}
