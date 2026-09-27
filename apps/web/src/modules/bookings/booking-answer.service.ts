import "server-only";

import { Types } from "mongoose";

import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { BookingModel, type BookingStatus } from "@hostel/db/models/Booking";
import { BookingTransferModel } from "@hostel/db/models/BookingTransfer";
import { HostelModel } from "@hostel/db/models/Hostel";
import {
  bookingConfirmedEmail,
  bookingEndedEmail,
  type BookingEndCause,
} from "@hostel/shared/email/templates/booking/guest";
import {
  bookingClosedForHostelEmail,
  type HostelBookingClosedCause,
} from "@hostel/shared/email/templates/booking/hostel";
import { rupees } from "@hostel/shared/email/templates/booking/parts";
import { bookingHostelFaultRefundEmail } from "@hostel/shared/email/templates/booking/platform";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { logger } from "@/lib/logger";
import { Role } from "@/lib/roles";
import { canAccessHostel } from "@/lib/tenant";
import { endBooking, moveBooking } from "@/modules/bookings/booking-lifecycle";
import {
  appUrl,
  bookingFacts,
  guestBookingPath,
  hostelBookingsPath,
  notifyGuest,
  notifyHostel,
  notifyHostelBookingPause,
  notifyPlatform,
  PLATFORM_BOOKINGS_PATH,
  when,
} from "@/modules/bookings/booking-notify";
import { cancellationSchedule, holdEndsAt } from "@/modules/bookings/booking-terms";
import { stayCheckInBy } from "@/modules/bookings/short-stay";
import {
  BOOKING_STATUS_LABELS,
  cancelPreview,
  toHostelView,
  toPlatformView,
  type BookingRecord,
  type TransferRecord,
} from "@/modules/bookings/booking-views";
import { expireUnpaidBooking, getMyBooking } from "@/modules/bookings/booking.service";
import {
  bookingPauseSchema,
  bookingReasonSchema,
  cancelMyBookingSchema,
  requiredBookingReasonSchema,
} from "@/modules/bookings/booking.validation";
import { BookingError } from "@/modules/bookings/booking.errors";
import {
  PAYOUT_METHOD_LABELS,
  maskedPayoutNumber,
} from "@/modules/bookings/payout-account.validation";
import {
  claimBedForRoomType,
  releaseBedForRoomType,
} from "@/modules/hostels/hostel-capacity.service";

/**
 * The hostel's answer to a paid booking, and every way one ends before a move-in.
 *
 * Hostel admins confirm (claims a bed, starts the hold) or decline, and may
 * cancel what they confirmed — a strike. The person cancels for whatever the
 * booking's frozen steps give at that moment. A superadmin cancels any paid
 * booking in full.
 *
 * **Every entry point reads the clock before the button.** A confirm after the
 * answer window is a missed answer; a cancel after the hold is a no-show. The
 * sweep ends bookings through the same `endForMissedAnswer` / `endAsNoShow`, so
 * pressing late and sweeping late land on the same money.
 */

const notFound = () => new BookingError("Booking not found.", "BOOKING_NOT_FOUND", 404);

const stateChanged = () =>
  new BookingError(
    "This booking has just changed. Refresh to see where it stands.",
    "BOOKING_STATE_CHANGED",
    409,
  );

function past(deadline: Date | null | undefined, now: Date) {
  return Boolean(deadline && now.getTime() >= new Date(deadline).getTime());
}

async function loadBooking(bookingId: string, filter: Record<string, unknown> = {}) {
  await connectToDatabase();

  const booking = Types.ObjectId.isValid(bookingId)
    ? await BookingModel.findOne({ _id: bookingId, ...filter }).lean<BookingRecord | null>()
    : null;

  if (!booking) {
    throw notFound();
  }

  return booking;
}

/** An admin of this booking's hostel. Anyone else gets the 404 a missing booking gets. */
async function loadHostelBooking(bookingId: string, principal: ApiPrincipal) {
  const booking = await loadBooking(bookingId);

  if (principal.role !== Role.HOSTEL_ADMIN || !canAccessHostel(principal, String(booking.hostelId))) {
    throw notFound();
  }

  return booking;
}

// ── Telling people ──────────────────────────────────────────────────────────

const GUEST_CAUSES = new Set<BookingStatus>([
  "EXPIRED",
  "DECLINED",
  "HOSTEL_NO_RESPONSE",
  "CANCELLED_BY_HOSTEL",
  "CANCELLED_BY_PLATFORM",
  "NO_SHOW",
]);

/** Endings the hostel did not cause itself, so it has to be told. */
const HOSTEL_CAUSES = new Set<BookingEndCause>([
  "CANCELLED_BEFORE_CONFIRMATION",
  "CANCELLED_BY_USER",
  "CANCELLED_BY_PLATFORM",
  "DECLINED",
  "HOSTEL_NO_RESPONSE",
  "NO_SHOW",
]);

function endCause(ended: BookingRecord, previous: BookingStatus): BookingEndCause | null {
  if (ended.status === "CANCELLED_BY_USER") {
    return previous === "CONFIRMED" ? "CANCELLED_BY_USER" : "CANCELLED_BEFORE_CONFIRMATION";
  }

  return GUEST_CAUSES.has(ended.status) ? (ended.status as BookingEndCause) : null;
}

/**
 * Tells everybody a booking ended: the person (what comes back, where to),
 * the hostel when somebody else ended it (bed free, its share), and the
 * superadmins when money is now owed.
 */
export async function announceEnding(ended: BookingRecord, previous: BookingStatus) {
  const cause = endCause(ended, previous);

  if (!cause) {
    return;
  }

  const paid = Boolean(ended.paymentVerifiedAt);
  const refund = ended.settlement?.refund ?? 0;
  const hostelShare = ended.settlement?.hostelShare ?? 0;
  const account = ended.refundAccount;
  const refundTo = `${PAYOUT_METHOD_LABELS[account.method]} ${maskedPayoutNumber(account.numberLast4)} (${account.holderName})`;
  // A system ending's cause line already says why; only a person's words are worth repeating.
  const reason = ended.endedBy ? (ended.endReason ?? null) : null;
  const title = BOOKING_STATUS_LABELS[ended.status];
  const type = `BOOKING_${ended.status}`;
  const jobs: Array<Promise<unknown>> = [
    notifyGuest(ended, {
      action: `booking_${cause.toLowerCase()}`,
      body:
        paid && refund > 0
          ? `${rupees(refund)} of your booking fee for ${ended.code} is coming back to ${refundTo}.`
          : `Booking ${ended.code} at ${ended.hostelSnapshot.name} has ended.`,
      email: bookingEndedEmail({
        booking: bookingFacts(ended),
        bookingUrl: appUrl(guestBookingPath(ended)),
        cause,
        name: ended.guest.name,
        paid,
        reason,
        refund,
        refundPercent: ended.settlement?.refundPercent ?? 0,
        refundTo,
      }),
      title,
      type,
    }),
  ];

  if ((previous === "AWAITING_HOSTEL" || previous === "CONFIRMED") && HOSTEL_CAUSES.has(cause)) {
    jobs.push(
      notifyHostel(ended, {
        action: `booking_${cause.toLowerCase()}_hostel`,
        body: `${ended.code} (${ended.guest.name}, ${ended.roomType}): ${title}.${hostelShare > 0 ? ` Your share ${rupees(hostelShare)}.` : ""}`,
        email: (contact) =>
          bookingClosedForHostelEmail({
            bookingsUrl: appUrl(hostelBookingsPath(ended)),
            cause: cause as HostelBookingClosedCause,
            code: ended.code,
            guestName: ended.guest.name,
            hostelName: ended.hostelSnapshot.name,
            hostelShare,
            name: contact.name,
            reason,
            roomType: ended.roomType,
          }),
        title,
        type,
      }),
    );
  }

  if (paid && (refund > 0 || hostelShare > 0)) {
    const owed = [
      refund > 0 ? `refund ${rupees(refund)}` : "",
      hostelShare > 0 ? `payout ${rupees(hostelShare)}` : "",
    ].filter(Boolean);

    jobs.push(
      notifyPlatform(ended, {
        action: "booking_money_due",
        body: `${ended.code}: ${owed.join(", ")} to send.`,
        email:
          refund > 0 && (cause === "DECLINED" || cause === "HOSTEL_NO_RESPONSE" || cause === "CANCELLED_BY_HOSTEL")
            ? bookingHostelFaultRefundEmail({
                cause,
                code: ended.code,
                guestName: ended.guest.name,
                hostelName: ended.hostelSnapshot.name,
                queueUrl: appUrl(`${PLATFORM_BOOKINGS_PATH}?tab=refunds`),
                reason,
                refund,
                refundTo,
                roomType: ended.roomType,
              })
            : undefined,
        tab: refund > 0 ? "refunds" : "payouts",
        title: refund > 0 ? "Refund to send" : "Payout to send",
        type: "BOOKING_MONEY_DUE",
      }),
    );
  }

  await Promise.all(jobs);
}

export type HostelPlace = {
  contact?: { phone?: string };
  location?: {
    address?: string;
    area?: string;
    city?: string;
    landmark?: string;
    lat?: number;
    lng?: number;
    mapLink?: string;
  };
};

/** The owner's own map link first, then the pin, then the address as a search. */
export function directionsUrl(location: HostelPlace["location"]) {
  if (location?.mapLink && /^https:\/\//i.test(location.mapLink)) {
    return location.mapLink;
  }

  if (typeof location?.lat === "number" && typeof location?.lng === "number") {
    return `https://www.google.com/maps/search/?api=1&query=${location.lat},${location.lng}`;
  }

  const text = [location?.address, location?.area, location?.city].filter(Boolean).join(", ");

  return text ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(text)}` : null;
}

async function announceConfirmed(booking: BookingRecord) {
  const hostel = await HostelModel.findById(booking.hostelId)
    .select("contact location")
    .lean<HostelPlace | null>()
    .catch(() => null);
  const schedule = cancellationSchedule(booking.terms, booking.fee, booking.confirmedAt!);
  const holdEnds = when(booking.holdEndsAt);

  await notifyGuest(booking, {
    action: "booking_confirmed",
    body: `${booking.hostelSnapshot.name} confirmed ${booking.code}. Move in by ${holdEnds}.`,
    email: bookingConfirmedEmail({
      address: booking.hostelSnapshot.address,
      booking: bookingFacts(booking),
      bookingUrl: appUrl(guestBookingPath(booking)),
      directionsUrl: directionsUrl(hostel?.location),
      holdEndsAt: holdEnds,
      hostelPhone: hostel?.contact?.phone || booking.hostelSnapshot.phone,
      landmark: hostel?.location?.landmark,
      name: booking.guest.name,
      noShowRefund: schedule.noShow.refund,
      schedule: schedule.steps.map((step) => ({
        refund: step.refund,
        refundPercent: step.refundPercent,
        until: when(step.until),
      })),
    }),
    title: "Booking confirmed",
    type: "BOOKING_CONFIRMED",
  });
}

// ── Endings the clock decides (shared with the sweep) ───────────────────────

/** The hostel let its answer window pass: full refund, and a strike. */
export async function endForMissedAnswer(booking: BookingRecord, now = new Date()) {
  const ended = await endBooking(booking, {
    actorId: null,
    from: ["AWAITING_HOSTEL"],
    now,
    status: "HOSTEL_NO_RESPONSE",
    strike: true,
  });

  if (ended) {
    await announceEnding(ended, booking.status);
  }

  return ended;
}

/** The hold ran out with nobody moved in: the bed goes back, the no-show share is kept. */
export async function endAsNoShow(booking: BookingRecord, now = new Date()) {
  const ended = await endBooking(booking, {
    actorId: null,
    from: ["CONFIRMED"],
    now,
    status: "NO_SHOW",
  });

  if (ended) {
    await announceEnding(ended, booking.status);
  }

  return ended;
}

/** Closes an unpaid booking whose time to pay has run out, and tells the person. */
export async function endUnpaid(booking: BookingRecord, now = new Date()) {
  const ended = await expireUnpaidBooking(booking, now);

  if (ended) {
    await announceEnding(ended, booking.status);
  }

  return ended;
}

async function assertAwaitingAnswer(booking: BookingRecord, now: Date) {
  if (booking.status !== "AWAITING_HOSTEL") {
    throw new BookingError("This booking is not waiting for your answer.", "BOOKING_NOT_AWAITING_HOSTEL", 409);
  }

  if (past(booking.hostelAnswerBy, now)) {
    await endForMissedAnswer(booking, now);

    throw new BookingError(
      "The time to answer this booking has passed. The guest is refunded in full.",
      "ANSWER_WINDOW_CLOSED",
      409,
    );
  }
}

// ── The hostel ──────────────────────────────────────────────────────────────

export async function confirmBooking(bookingId: string, principal: ApiPrincipal, now = new Date()) {
  const booking = await loadHostelBooking(bookingId, principal);

  await assertAwaitingAnswer(booking, now);

  try {
    await claimBedForRoomType(booking.hostelId, booking.roomType);
  } catch (error) {
    const code = (error as { errorCode?: string }).errorCode;

    if (code === "ROOM_TYPE_FULL" || code === "ROOM_TYPE_NOT_FOUND") {
      throw new BookingError(
        `No vacant ${booking.roomType} bed is left to hold. Free one, or decline this booking.`,
        "ROOM_TYPE_FULL",
        409,
      );
    }

    throw error;
  }

  const confirmed = await moveBooking(booking._id, "AWAITING_HOSTEL", {
    bedHeld: true,
    confirmedAt: now,
    confirmedBy: principal.userId,
    // A short stay's bed waits for the guest until the day after move-in; a monthly one for the hold.
    holdEndsAt: booking.stay ? stayCheckInBy(booking.stay) : holdEndsAt(booking.terms, now),
    status: "CONFIRMED",
  });

  if (!confirmed) {
    // Somebody else moved it first. The bed claimed a moment ago belongs to nobody.
    await releaseBedForRoomType(booking.hostelId, booking.roomType).catch((error: unknown) => {
      logger.error("Booking confirm lost a race and its bed could not be released.", {
        bookingId: String(booking._id),
        error: error instanceof Error ? error.message : String(error),
      });
    });

    throw stateChanged();
  }

  await AuditLogModel.create({
    action: "BOOKING_CONFIRMED",
    actorId: principal.userId,
    actorType: "USER",
    entityId: String(booking._id),
    entityType: "Booking",
    hostelId: booking.hostelId,
    metadata: { code: booking.code, holdEndsAt: confirmed.holdEndsAt },
  }).catch(() => undefined);

  await announceConfirmed(confirmed);

  return toHostelView(confirmed);
}

/** Declining in time is the hostel's right: full refund, no strike. */
export async function declineBooking(
  bookingId: string,
  rawInput: unknown,
  principal: ApiPrincipal,
  now = new Date(),
) {
  const input = bookingReasonSchema.parse(rawInput ?? {});
  const booking = await loadHostelBooking(bookingId, principal);

  await assertAwaitingAnswer(booking, now);

  const ended = await endBooking(booking, {
    actorId: principal.userId,
    from: ["AWAITING_HOSTEL"],
    now,
    reason: input.reason,
    status: "DECLINED",
  });

  if (!ended) {
    throw stateChanged();
  }

  await announceEnding(ended, booking.status);

  return toHostelView(ended);
}

/** Going back on a confirmation: full refund, the bed released, and a strike. */
export async function cancelBookingByHostel(
  bookingId: string,
  rawInput: unknown,
  principal: ApiPrincipal,
  now = new Date(),
) {
  const booking = await loadHostelBooking(bookingId, principal);
  const input = requiredBookingReasonSchema.parse(rawInput ?? {});

  if (booking.status !== "CONFIRMED") {
    throw new BookingError(
      "Only a booking you confirmed can be cancelled. Decline one that is waiting for your answer.",
      "BOOKING_NOT_CONFIRMED",
      409,
    );
  }

  if (past(booking.holdEndsAt, now)) {
    await endAsNoShow(booking, now);

    throw new BookingError("The hold on this booking has already ended.", "HOLD_ENDED", 409);
  }

  const ended = await endBooking(booking, {
    actorId: principal.userId,
    from: ["CONFIRMED"],
    now,
    reason: input.reason,
    status: "CANCELLED_BY_HOSTEL",
    strike: true,
  });

  if (!ended) {
    throw stateChanged();
  }

  await announceEnding(ended, booking.status);

  return toHostelView(ended);
}

// ── The person who booked ───────────────────────────────────────────────────

export async function cancelMyBooking(
  bookingId: string,
  rawInput: unknown,
  principal: ApiPrincipal,
  now = new Date(),
) {
  const input = cancelMyBookingSchema.parse(rawInput ?? {});
  const booking = await loadBooking(bookingId, { userId: principal.userId });

  if (!booking.isOpen) {
    throw new BookingError("This booking has already ended.", "BOOKING_CLOSED", 409);
  }

  if (booking.status === "PAYMENT_IN_REVIEW") {
    throw new BookingError(
      "We are checking your payment. You can cancel as soon as it is checked.",
      "BOOKING_PAYMENT_IN_REVIEW",
      409,
    );
  }

  // The clock first. Late for these two, the money is what cancelling gives anyway.
  if (booking.status === "AWAITING_PAYMENT" && past(booking.paymentDueBy, now)) {
    await endUnpaid(booking, now);

    return getMyBooking(bookingId, principal);
  }

  if (booking.status === "AWAITING_HOSTEL" && past(booking.hostelAnswerBy, now)) {
    await endForMissedAnswer(booking, now);

    return getMyBooking(bookingId, principal);
  }

  // Not this one: past the hold, the no-show share applies, which is less than the screen said.
  if (booking.status === "CONFIRMED" && past(booking.holdEndsAt, now)) {
    await endAsNoShow(booking, now);

    throw new BookingError(
      "The time to move in has passed, so this booking has ended as not moved in.",
      "HOLD_ENDED",
      409,
    );
  }

  const preview = cancelPreview(booking, now);

  if (input.expectedRefund !== undefined && input.expectedRefund !== preview.refund) {
    throw new BookingError(
      `Cancelling now gives back ${rupees(preview.refund)}, not ${rupees(input.expectedRefund)}. Check the new figure and cancel again.`,
      "REFUND_CHANGED",
      409,
      { cancel: preview },
    );
  }

  const ended = await endBooking(booking, {
    actorId: principal.userId,
    from: [booking.status],
    now,
    status: "CANCELLED_BY_USER",
  });

  if (!ended) {
    throw stateChanged();
  }

  await announceEnding(ended, booking.status);

  return getMyBooking(bookingId, principal);
}

// ── HostelPalika ────────────────────────────────────────────────────────────

/** Disputes, fraud, mistakes: any paid open booking, refunded in full. */
export async function cancelBookingByPlatform(
  bookingId: string,
  rawInput: unknown,
  principal: ApiPrincipal,
  now = new Date(),
) {
  if (principal.role !== Role.SUPERADMIN) {
    throw new BookingError("Only a superadmin can cancel a booking for the platform.", "FORBIDDEN", 403);
  }

  const input = requiredBookingReasonSchema.parse(rawInput ?? {});
  const booking = await loadBooking(bookingId);

  if (booking.status !== "AWAITING_HOSTEL" && booking.status !== "CONFIRMED") {
    throw new BookingError(
      "Only a paid booking that is still open can be cancelled. Reject an unchecked payment instead.",
      "BOOKING_NOT_PAID_OPEN",
      409,
    );
  }

  const ended = await endBooking(booking, {
    actorId: principal.userId,
    from: [booking.status],
    now,
    reason: input.reason,
    status: "CANCELLED_BY_PLATFORM",
  });

  if (!ended) {
    throw stateChanged();
  }

  await announceEnding(ended, booking.status);

  const transfers = await BookingTransferModel.find({ bookingId: ended._id }).lean<TransferRecord[]>();

  return toPlatformView(ended, transfers, now);
}

export type HostelBookingPause = {
  pausedAt: string | null;
  reason: string | null;
  resumedAt: string | null;
};

/**
 * A superadmin switching a hostel's Book button off or back on. Resuming
 * forgives the strikes so far (`resumedAt`); pausing needs a reason the hostel
 * can be shown.
 */
export async function setHostelBookingPause(
  hostelId: string,
  rawInput: unknown,
  principal: ApiPrincipal,
): Promise<HostelBookingPause> {
  if (principal.role !== Role.SUPERADMIN) {
    throw new BookingError("Only a superadmin can pause or resume bookings on a hostel.", "FORBIDDEN", 403);
  }

  const input = bookingPauseSchema.parse(rawInput);
  const reason = input.reason?.trim() || null;

  if (input.paused && !reason) {
    throw new BookingError("Say why, so the hostel knows.", "VALIDATION_ERROR", 422);
  }

  await connectToDatabase();

  const now = new Date();
  type PauseRow = { bookingPause?: { pausedAt?: Date | null; reason?: string | null; resumedAt?: Date | null } };
  const hostel = Types.ObjectId.isValid(hostelId)
    ? await HostelModel.findOneAndUpdate(
        { _id: hostelId, isDeleted: { $ne: true } },
        {
          $set: input.paused
            ? {
                "bookingPause.pausedAt": now,
                "bookingPause.pausedBy": principal.userId,
                "bookingPause.reason": reason,
              }
            : {
                "bookingPause.pausedAt": null,
                "bookingPause.pausedBy": null,
                "bookingPause.reason": null,
                "bookingPause.resumedAt": now,
              },
        },
        { new: true },
      ).lean<PauseRow | null>()
    : null;

  if (!hostel) {
    throw new BookingError("Hostel not found.", "HOSTEL_NOT_FOUND", 404);
  }

  await AuditLogModel.create({
    action: input.paused ? "HOSTEL_BOOKINGS_PAUSED" : "HOSTEL_BOOKINGS_RESUMED",
    actorId: principal.userId,
    actorType: "USER",
    entityId: hostelId,
    entityType: "Hostel",
    hostelId,
    metadata: { reason },
  }).catch(() => undefined);

  await notifyHostelBookingPause(hostelId, { paused: input.paused, reason });

  const pause = hostel.bookingPause ?? {};

  return {
    pausedAt: pause.pausedAt ? new Date(pause.pausedAt).toISOString() : null,
    reason: pause.reason ?? null,
    resumedAt: pause.resumedAt ? new Date(pause.resumedAt).toISOString() : null,
  };
}
