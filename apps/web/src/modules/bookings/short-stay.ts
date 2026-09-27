import { z } from "zod";

import {
  formatBsDayRange,
  hostelCalendarDay,
  hostelDayEnd,
  hostelDaysBetween,
  hostelToday,
} from "@hostel/shared/calendar/bs";

import { BookingError } from "@/modules/bookings/booking.errors";
import type { BookingEnding } from "@/modules/bookings/booking-terms";

/**
 * The arithmetic of a short stay: a few nights, booked and paid upfront.
 *
 * Pure — no I/O and no clock of its own — so the quote, the create call, the
 * settings form and the endings all answer from the same numbers.
 * docs/PLANS_BRANCHES_SHORT_STAYS.md, Phase D.
 */

/**
 * The lowest daily rate a room type may be sold at: monthly ÷ 30, plus the
 * platform's minimum markup, rounded up to the rupee. A month of nights must
 * always cost more than a month's rent, or short stays undercut the hostel's
 * own residents.
 */
export function dailyFloor(monthlyRent: number, minMarkupPercent: number): number {
  return Math.max(1, Math.ceil((monthlyRent * (100 + minMarkupPercent)) / 3000));
}

/** What the hostel's settings and both registration forms send. */
export const shortStaysInputSchema = z.object({
  enabled: z.boolean(),
  minNights: z.coerce.number().int().min(1).max(29),
  rates: z
    .array(
      z.object({
        dailyRate: z.coerce.number().int("Use whole rupees.").min(1),
        roomType: z.string().trim().min(1).max(80),
      }),
    )
    .max(30),
});

export type ShortStaysInput = z.infer<typeof shortStaysInputSchema>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A short stay as it is frozen on its booking. Dates are Nepal days, stored as UTC midnight. */
export type BookingStay = {
  /** `nights × dailyRate`, paid upfront with the booking fee. */
  amount: number;
  dailyRate: number;
  /** How many booking fees the hold from booking to move-in cost. */
  holdBlocks: number;
  /** The hostel's part of the nights kept. HostelPalika keeps the rest. */
  hostelSharePercent: number;
  moveIn: Date;
  moveOut: Date;
  nights: number;
};

/**
 * One booking fee per started block of `holdDays` from today to move-in. A
 * move-in inside the first block pays one fee, as a monthly booking does.
 */
export function holdBlocks(today: Date, moveIn: Date, holdDays: number): number {
  return Math.max(1, Math.ceil(Math.max(0, hostelDaysBetween(today, moveIn)) / holdDays));
}

function nepalDay(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);

  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(date.getTime()) ? date : null;
}

/**
 * Checks a stay's dates against the hostel's minimum and the platform's limits
 * and prices it. Throws a `BookingError` the checkout words as it is.
 */
export function quoteStay(input: {
  dailyRate: number;
  holdDays: number;
  hostelSharePercent: number;
  maxAdvanceDays: number;
  maxNights: number;
  minNights: number;
  moveIn: string;
  moveOut: string;
  now: Date;
}): BookingStay {
  const moveIn = nepalDay(input.moveIn);
  const moveOut = nepalDay(input.moveOut);
  const today = hostelToday(input.now);

  if (!moveIn || !moveOut || moveOut.getTime() <= moveIn.getTime()) {
    throw new BookingError("Pick a move-in date and a later move-out date.", "SHORT_STAY_DATES_INVALID", 422);
  }

  if (moveIn.getTime() < today.getTime() || moveIn.getTime() > today.getTime() + input.maxAdvanceDays * DAY_MS) {
    throw new BookingError(
      `Pick a move-in date between today and ${input.maxAdvanceDays} days from now.`,
      "SHORT_STAY_DATES_INVALID",
      422,
    );
  }

  const nights = Math.round((moveOut.getTime() - moveIn.getTime()) / DAY_MS);

  if (nights < input.minNights) {
    throw new BookingError(
      `This hostel takes stays of at least ${input.minNights} nights.`,
      "SHORT_STAY_TOO_SHORT",
      422,
    );
  }

  if (nights > input.maxNights) {
    throw new BookingError(
      `A short stay is at most ${input.maxNights} nights. Book monthly for longer.`,
      "SHORT_STAY_TOO_LONG",
      422,
    );
  }

  return {
    amount: nights * input.dailyRate,
    dailyRate: input.dailyRate,
    holdBlocks: holdBlocks(today, moveIn, input.holdDays),
    hostelSharePercent: input.hostelSharePercent,
    moveIn,
    moveOut,
    nights,
  };
}

/** The last moment to check in: the end of the day after move-in, so a late bus or flight is not a no-show. */
export function stayCheckInBy(stay: Pick<BookingStay, "moveIn">): Date {
  return hostelDayEnd(stay.moveIn, 1);
}

/** When the stay is over and the bed goes back: the end of the move-out day. */
export function stayEndsAt(stay: Pick<BookingStay, "moveOut">): Date {
  return hostelDayEnd(stay.moveOut);
}

/**
 * What of the nights goes back to the guest.
 *
 * In full for every ending before the move-in day. A no-show keeps one night.
 * So does a cancel on or after the move-in day, or cancelling would be a free
 * way out of the no-show rule. After check-in nothing: leaving early is not
 * refunded.
 */
export function stayRefund(
  stay: Pick<BookingStay, "amount" | "dailyRate" | "moveIn">,
  ending: BookingEnding,
  at: Date,
): number {
  const oneNight = Math.min(stay.dailyRate, stay.amount);

  if (ending === "CHECKED_IN") return 0;
  if (ending === "NO_SHOW") return stay.amount - oneNight;

  if (ending === "CANCELLED_BY_USER" && hostelToday(at).getTime() >= hostelCalendarDay(stay.moveIn).getTime()) {
    return stay.amount - oneNight;
  }

  return stay.amount;
}

/** What the guest pays: the booking fee, plus the nights for a short stay. */
export function amountDue(booking: { fee: number; stay?: { amount: number } | null }): number {
  return booking.fee + (booking.stay?.amount ?? 0);
}

const AD_DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC", year: "numeric" });

/**
 * `4 Oct 2026 – 7 Oct 2026 (Asoj 18 – Asoj 21)`: AD first, because short-stay
 * guests are often from abroad, with the hostel's own BS days beside it.
 */
export function stayDatesText(stay: Pick<BookingStay, "moveIn" | "moveOut">): string {
  const moveIn = new Date(stay.moveIn);
  const moveOut = new Date(stay.moveOut);
  const bs = formatBsDayRange(moveIn, moveOut);

  return `${AD_DAY.format(moveIn)} – ${AD_DAY.format(moveOut)}${bs ? ` (${bs})` : ""}`;
}
