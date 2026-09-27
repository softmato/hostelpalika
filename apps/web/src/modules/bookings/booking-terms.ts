import type { BookingCancelStep, BookingConfig } from "@/modules/bookings/booking-config";
import { BookingError } from "@/modules/bookings/booking.errors";
import { assertWholeRupees, roundToRupee } from "@/modules/finance/money";
import { stayRefund, type BookingStay } from "@/modules/bookings/short-stay";

/**
 * The money of a booking: the fee, and who gets how much of it back.
 *
 * Pure module — no I/O and no clock of its own. Every function takes the
 * moment it is asked about, so the checkout, the cancel button, the sweep and
 * the documents all answer from the same arithmetic and a test can stand on any
 * hour of the hold.
 *
 * ## Days are 24-hour blocks from the confirmation
 *
 * Not Nepal calendar days. A hostel that confirms at 11 PM would otherwise
 * spend the person's whole "day 1" in the hour before midnight. Counting from
 * the confirmation gives everybody the same seven days, and lets every screen
 * print an exact time ("75% back until Thu 17 Sep, 3:40 PM") instead of a
 * day number somebody has to interpret.
 *
 * ## Every ending sums back to the fee
 *
 * The refund is rounded once; whatever is left is kept; the hostel's share of
 * that is rounded once and HostelPalika takes the remainder. No rupee is ever
 * created or lost between the three.
 */

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/** What a booking is sold under. Copied onto the booking when it is created. */
export type BookingTerms = {
  cancelSteps: BookingCancelStep[];
  feePercent: number;
  holdDays: number;
  hostelAnswerHours: number;
  hostelSharePercent: number;
  noShowRefundPercent: number;
};

export function termsFromConfig(config: BookingConfig): BookingTerms {
  return {
    cancelSteps: config.cancelSteps.map((step) => ({ ...step })),
    feePercent: config.feePercent,
    holdDays: config.holdDays,
    hostelAnswerHours: config.hostelAnswerHours,
    hostelSharePercent: config.hostelSharePercent,
    noShowRefundPercent: config.noShowRefundPercent,
  };
}

/** The booking fee for a room type's monthly rent. Never less than one rupee. */
export function bookingFee(monthlyRent: number, feePercent: number): number {
  assertWholeRupees(monthlyRent, "monthly rent");

  if (monthlyRent <= 0) {
    throw new BookingError(
      "This room type has no rent set, so it cannot be booked yet.",
      "ROOM_NOT_PRICED",
      422,
    );
  }

  return Math.max(1, roundToRupee((monthlyRent * feePercent) / 100));
}

/** Which day of the hold `at` falls on. Day 1 is the first 24 hours. */
export function holdDayAt(confirmedAt: Date, at: Date): number {
  const elapsed = at.getTime() - confirmedAt.getTime();

  return elapsed < 0 ? 1 : Math.floor(elapsed / DAY_MS) + 1;
}

export function holdEndsAt(terms: Pick<BookingTerms, "holdDays">, confirmedAt: Date): Date {
  return new Date(confirmedAt.getTime() + terms.holdDays * DAY_MS);
}

export function hostelAnswerDeadline(
  terms: Pick<BookingTerms, "hostelAnswerHours">,
  paymentVerifiedAt: Date,
): Date {
  return new Date(paymentVerifiedAt.getTime() + terms.hostelAnswerHours * HOUR_MS);
}

/**
 * What cancelling at `at` hands back, for a booking the hostel has confirmed.
 *
 * Past the end of the hold there is no step left, and the answer is the no-show
 * share — so a cancel that races the sweep gets exactly what the sweep would
 * have given, never a better deal for having been a second faster.
 */
export function cancelRefundPercent(
  terms: Pick<BookingTerms, "cancelSteps" | "noShowRefundPercent">,
  confirmedAt: Date,
  at: Date,
): number {
  const day = holdDayAt(confirmedAt, at);
  const step = terms.cancelSteps.find((candidate) => day <= candidate.throughDay);

  return step ? step.refundPercent : terms.noShowRefundPercent;
}

/** How a booking ended, as far as the money is concerned. */
export type BookingEnding =
  /** The person cancelled before the hostel confirmed. Nothing was held. */
  | "CANCELLED_BEFORE_CONFIRMATION"
  | "DECLINED"
  | "HOSTEL_NO_RESPONSE"
  | "CANCELLED_BY_HOSTEL"
  | "CANCELLED_BY_PLATFORM"
  /** The person cancelled a confirmed booking. The ladder decides. */
  | "CANCELLED_BY_USER"
  | "NO_SHOW"
  | "CHECKED_IN";

/** Endings where the person did nothing wrong, or nothing was held for them. */
const FULL_REFUND_ENDINGS = new Set<BookingEnding>([
  "CANCELLED_BEFORE_CONFIRMATION",
  "DECLINED",
  "HOSTEL_NO_RESPONSE",
  "CANCELLED_BY_HOSTEL",
  "CANCELLED_BY_PLATFORM",
]);

export type BookingSettlement = {
  /** HostelPalika's part of what is kept. */
  platformShare: number;
  /** What goes back to the person. */
  refund: number;
  refundPercent: number;
  /** The hostel's part of what is kept. */
  hostelShare: number;
  kept: number;
  /** A short stay's nights kept and handed back, inside the totals above. */
  stayKept?: number;
  stayRefund?: number;
};

export function splitKept(kept: number, hostelSharePercent: number) {
  assertWholeRupees(kept, "kept amount");

  const hostelShare = roundToRupee((kept * hostelSharePercent) / 100);

  return { hostelShare, platformShare: kept - hostelShare };
}

export function settlementFor(fee: number, refundPercent: number, terms: Pick<BookingTerms, "hostelSharePercent">): BookingSettlement {
  assertWholeRupees(fee, "booking fee");

  const refund = roundToRupee((fee * refundPercent) / 100);
  const kept = fee - refund;

  return { kept, refund, refundPercent, ...splitKept(kept, terms.hostelSharePercent) };
}

/**
 * Who gets what when a booking ends.
 *
 * `confirmedAt` is required only for a person's cancellation of a confirmed
 * booking — it is the one ending whose answer depends on when it happened.
 */
export function settleBooking(input: {
  at: Date;
  confirmedAt?: Date | null;
  ending: BookingEnding;
  fee: number;
  /** A short stay's nights, settled beside the fee and added into the totals. */
  stay?: Pick<BookingStay, "amount" | "dailyRate" | "hostelSharePercent" | "moveIn"> | null;
  terms: BookingTerms;
}): BookingSettlement {
  const fee = settleFee(input);

  if (!input.stay) {
    return fee;
  }

  const refund = stayRefund(input.stay, input.ending, input.at);
  const kept = input.stay.amount - refund;
  const split = splitKept(kept, input.stay.hostelSharePercent);

  return {
    hostelShare: fee.hostelShare + split.hostelShare,
    kept: fee.kept + kept,
    platformShare: fee.platformShare + split.platformShare,
    refund: fee.refund + refund,
    refundPercent: fee.refundPercent,
    stayKept: kept,
    stayRefund: refund,
  };
}

function settleFee(input: {
  at: Date;
  confirmedAt?: Date | null;
  ending: BookingEnding;
  fee: number;
  terms: BookingTerms;
}): BookingSettlement {
  const { ending, fee, terms } = input;

  if (FULL_REFUND_ENDINGS.has(ending)) {
    return settlementFor(fee, 100, terms);
  }

  if (ending === "CHECKED_IN") {
    return settlementFor(fee, 0, terms);
  }

  if (ending === "NO_SHOW") {
    return settlementFor(fee, terms.noShowRefundPercent, terms);
  }

  if (!input.confirmedAt) {
    throw new BookingError(
      "A confirmed booking has no confirmation time, so its refund cannot be worked out.",
      "BOOKING_STATE_INVALID",
      409,
    );
  }

  return settlementFor(fee, cancelRefundPercent(terms, input.confirmedAt, input.at), terms);
}

export type PolicyRow = {
  fromDay: number;
  refund: number;
  refundPercent: number;
  throughDay: number;
};

/**
 * The ladder in days, for a booking nobody has confirmed yet — the checkout and
 * the refund policy page, where there is no confirmation time to print.
 */
export function policyRows(terms: BookingTerms, fee: number): PolicyRow[] {
  let fromDay = 1;

  return terms.cancelSteps.map((step) => {
    const row = {
      fromDay,
      refund: settlementFor(fee, step.refundPercent, terms).refund,
      refundPercent: step.refundPercent,
      throughDay: step.throughDay,
    };

    fromDay = step.throughDay + 1;

    return row;
  });
}

export type ScheduleRow = PolicyRow & {
  /** The step applies to a cancellation made before this instant. */
  until: Date;
};

/** The same ladder with real times on it, once the hostel has confirmed. */
export function cancellationSchedule(
  terms: BookingTerms,
  fee: number,
  confirmedAt: Date,
): { noShow: { after: Date; refund: number; refundPercent: number }; steps: ScheduleRow[] } {
  return {
    noShow: {
      after: holdEndsAt(terms, confirmedAt),
      refund: settlementFor(fee, terms.noShowRefundPercent, terms).refund,
      refundPercent: terms.noShowRefundPercent,
    },
    steps: policyRows(terms, fee).map((row) => ({
      ...row,
      until: new Date(confirmedAt.getTime() + row.throughDay * DAY_MS),
    })),
  };
}
