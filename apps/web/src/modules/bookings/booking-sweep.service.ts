import "server-only";

import type { Types } from "mongoose";

import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { BookingModel } from "@hostel/db/models/Booking";
import { ResidentModel } from "@hostel/db/models/Resident";
import { HostelModel } from "@hostel/db/models/Hostel";
import { bookingMoveInReminderEmail } from "@hostel/shared/email/templates/booking/guest";
import { bookingAnswerReminderEmail } from "@hostel/shared/email/templates/booking/hostel";
import { hoursWord } from "@hostel/shared/email/templates/booking/parts";

import { connectToDatabase } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  directionsUrl,
  endAsNoShow,
  endForMissedAnswer,
  endUnpaid,
  type HostelPlace,
} from "@/modules/bookings/booking-answer.service";
import { getBookingConfig } from "@/modules/bookings/booking-config";
import {
  appUrl,
  bookingFacts,
  guestBookingPath,
  hostelBookingsPath,
  notifyGuest,
  notifyHostel,
  when,
} from "@/modules/bookings/booking-notify";
import { HOUR_MS } from "@/modules/bookings/booking-terms";
import { releaseBedForRoomType } from "@/modules/hostels/hostel-capacity.service";
import { settleBookingFromSoftmato } from "@/modules/bookings/booking-softmato.service";
import { hostelShareIfCheckedIn, noShowRefund, type BookingRecord } from "@/modules/bookings/booking-views";

/**
 * The booking clock, run on the every-minute `platform-push` tick.
 *
 * Nothing here decides anything new: each ending goes through the same function
 * a late button press would, and each of those is a conditional write on the
 * status it leaves. A sweep that runs twice, late, or beside a person pressing
 * Cancel ends a booking once and raises its money once.
 *
 * Runs whether or not bookings are switched on — the switch stops new bookings,
 * never the ones already paid for.
 */

const BATCH = 100;

type Reminder = { at: Date; hoursLeft: number };

export type BookingSweepResult = {
  expired: number;
  /** Short-stay guests moved out at the end of their stay. */
  staysEnded: number;
  hostelReminders: number;
  missedAnswers: number;
  moveInReminders: number;
  noShows: number;
};

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Ends every due booking in deadline order. One at a time: bed counts are read-modify-write. */
async function endEach(
  filter: Record<string, unknown>,
  deadlineField: string,
  end: (booking: BookingRecord) => Promise<unknown>,
) {
  const due = await BookingModel.find(filter)
    .sort({ [deadlineField]: 1 })
    .limit(BATCH)
    .lean<BookingRecord[]>();
  let ended = 0;

  for (const booking of due) {
    try {
      if (await end(booking)) {
        ended += 1;
      }
    } catch (error) {
      logger.error("Booking sweep could not end a booking.", {
        bookingId: String(booking._id),
        error: message(error),
      });
    }
  }

  return ended;
}

/**
 * Which reminder, if any, is due now: the smallest threshold already crossed,
 * unless a reminder at or below it has gone. A sweep that missed the 12-hour
 * mark and wakes at 90 minutes sends the 2-hour one only, and never goes back
 * for the 12.
 */
export function dueReminder(
  deadline: Date,
  now: Date,
  thresholds: readonly number[],
  sent: readonly Reminder[] = [],
): number | null {
  const hoursLeft = (deadline.getTime() - now.getTime()) / HOUR_MS;

  if (hoursLeft <= 0) {
    return null;
  }

  const crossed = thresholds.filter((threshold) => hoursLeft <= threshold);

  if (crossed.length === 0) {
    return null;
  }

  const smallest = Math.min(...crossed);

  return sent.some((reminder) => reminder.hoursLeft <= smallest) ? null : smallest;
}

async function remindEach(input: {
  deadlineField: "holdEndsAt" | "hostelAnswerBy";
  now: Date;
  send: (booking: BookingRecord, hoursLeft: number) => Promise<void>;
  sentField: "hostelRemindersSent" | "moveInRemindersSent";
  status: "AWAITING_HOSTEL" | "CONFIRMED";
  thresholds: readonly number[];
}) {
  if (input.thresholds.length === 0) {
    return 0;
  }

  const horizon = new Date(input.now.getTime() + Math.max(...input.thresholds) * HOUR_MS);
  const candidates = await BookingModel.find({
    [input.deadlineField]: { $gt: input.now, $lte: horizon },
    status: input.status,
  })
    .sort({ [input.deadlineField]: 1 })
    .limit(BATCH * 5)
    .lean<BookingRecord[]>();
  let sent = 0;

  for (const booking of candidates) {
    const deadline = booking[input.deadlineField];
    const hoursLeft = deadline
      ? dueReminder(new Date(deadline), input.now, input.thresholds, booking[input.sentField])
      : null;

    if (hoursLeft === null) {
      continue;
    }

    // Claim before sending: two sweeps at once, one email.
    const claimed = await BookingModel.findOneAndUpdate(
      { _id: booking._id, status: input.status, [`${input.sentField}.hoursLeft`]: { $nin: [hoursLeft] } },
      { $push: { [input.sentField]: { at: input.now, hoursLeft } } },
      { new: true },
    ).lean<BookingRecord | null>();

    if (!claimed) {
      continue;
    }

    try {
      await input.send(claimed, hoursLeft);
      sent += 1;
    } catch (error) {
      logger.error("Booking sweep could not send a reminder.", {
        bookingId: String(booking._id),
        error: message(error),
      });
    }
  }

  return sent;
}

async function remindHostel(booking: BookingRecord, hoursLeft: number) {
  const answerBy = when(booking.hostelAnswerBy);

  await notifyHostel(booking, {
    action: "booking_answer_reminder",
    body: `${booking.guest.name}'s ${booking.roomType} booking (${booking.code}) needs your answer by ${answerBy}.`,
    email: (contact) =>
      bookingAnswerReminderEmail({
        answerBy,
        bookingsUrl: appUrl(hostelBookingsPath(booking)),
        code: booking.code,
        guestName: booking.guest.name,
        guestPhone: booking.guest.phone || null,
        hostelName: booking.hostelSnapshot.name,
        hostelShare: hostelShareIfCheckedIn(booking),
        hoursLeft,
        name: contact.name,
        roomType: booking.roomType,
      }),
    priority: "HIGH",
    title: `Less than ${hoursWord(hoursLeft)} to answer`,
    type: "BOOKING_ANSWER_REMINDER",
  });
}

async function remindMoveIn(booking: BookingRecord, hoursLeft: number) {
  const hostel = await HostelModel.findById(booking.hostelId)
    .select("contact location")
    .lean<HostelPlace | null>()
    .catch(() => null);
  const holdEnds = when(booking.holdEndsAt);

  await notifyGuest(booking, {
    action: "booking_move_in_reminder",
    body: `Move in at ${booking.hostelSnapshot.name} by ${holdEnds}, or the bed held for you is released.`,
    email: bookingMoveInReminderEmail({
      address: booking.hostelSnapshot.address,
      booking: bookingFacts(booking),
      bookingUrl: appUrl(guestBookingPath(booking)),
      directionsUrl: directionsUrl(hostel?.location),
      holdEndsAt: holdEnds,
      hostelPhone: hostel?.contact?.phone || booking.hostelSnapshot.phone,
      hoursLeft,
      name: booking.guest.name,
      noShowRefund: noShowRefund(booking),
    }),
    title: `Less than ${hoursWord(hoursLeft)} to move in`,
    type: "BOOKING_MOVE_IN_REMINDER",
  });
}

export async function sweepBookings(now = new Date()): Promise<BookingSweepResult> {
  await connectToDatabase();

  const config = await getBookingConfig();

  // Endings first, so a booking past its deadline is never reminded about it.
  const expired = await endEach(
    { paymentDueBy: { $lte: now }, status: "AWAITING_PAYMENT" },
    "paymentDueBy",
    async (booking) => {
      // Paid at the last minute, and the webhook not in yet: ask before expiring.
      const settled = booking.softmatoInvoiceNo
        ? await settleBookingFromSoftmato(booking).catch(() => "unpaid")
        : "unpaid";

      return settled === "paid" ? null : endUnpaid(booking, now);
    },
  );
  const missedAnswers = await endEach(
    { hostelAnswerBy: { $lte: now }, status: "AWAITING_HOSTEL" },
    "hostelAnswerBy",
    (booking) => endForMissedAnswer(booking, now),
  );
  const noShows = await endEach(
    { holdEndsAt: { $lte: now }, status: "CONFIRMED" },
    "holdEndsAt",
    (booking) => endAsNoShow(booking, now),
  );

  const hostelReminders = await remindEach({
    deadlineField: "hostelAnswerBy",
    now,
    send: remindHostel,
    sentField: "hostelRemindersSent",
    status: "AWAITING_HOSTEL",
    thresholds: config.hostelReminderHoursLeft,
  });
  const moveInReminders = await remindEach({
    deadlineField: "holdEndsAt",
    now,
    send: remindMoveIn,
    sentField: "moveInRemindersSent",
    status: "CONFIRMED",
    thresholds: config.moveInReminderHoursLeft,
  });

  const staysEnded = await endShortStays(now);

  return { expired, hostelReminders, missedAnswers, moveInReminders, noShows, staysEnded };
}

/**
 * Moves out every short-stay guest whose move-out day has ended and hands the
 * bed back. Conditional on the status, so a hostel that moved them out by hand
 * first frees no second bed.
 */
async function endShortStays(now: Date) {
  const due = await ResidentModel.find({
    isDeleted: { $ne: true },
    status: { $in: ["ACTIVE", "PENDING", "SUSPENDED"] },
    stayEndsAt: { $lte: now },
  })
    .select("_id hostelId roomType stayEndsAt")
    .limit(100)
    .lean<Array<{ _id: Types.ObjectId; hostelId: Types.ObjectId; roomType: string; stayEndsAt: Date }>>();
  let ended = 0;

  for (const resident of due) {
    try {
      const moved = await ResidentModel.updateOne(
        { _id: resident._id, status: { $ne: "MOVED_OUT" } },
        { $set: { moveOutDate: resident.stayEndsAt, status: "MOVED_OUT" } },
      );

      if (!moved.modifiedCount) continue;

      await releaseBedForRoomType(resident.hostelId, resident.roomType);
      await AuditLogModel.create({
        action: "SHORT_STAY_ENDED",
        actorType: "SYSTEM",
        entityId: String(resident._id),
        entityType: "Resident",
        hostelId: resident.hostelId,
        metadata: { stayEndsAt: resident.stayEndsAt },
      }).catch(() => undefined);
      ended += 1;
    } catch (error) {
      logger.error("A short stay could not be ended.", { error: message(error), residentId: String(resident._id) });
    }
  }

  return ended;
}
