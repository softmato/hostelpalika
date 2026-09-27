/**
 * The calendar day a hostel is actually living in, and the month it bills in.
 *
 * ## What this file is now
 *
 * A thin, named re-export of `@hostel/shared/calendar/bs`, which is the one copy
 * of the platform's date rules — the server imports it from here, the mobile app
 * resolves the same file through Metro, and the web UI will follow. There is
 * deliberately no arithmetic left in this module: two implementations of "which
 * month is this" is the defect the whole change exists to remove.
 *
 * ## The bug the calendar day exists to end
 *
 * Move-in and move-out are **calendar dates**, not moments. Nobody moves in at
 * 18:15 UTC; they move in on the 3rd. But a date picker sends an instant — the
 * browser and the phone both serialise "3 September" as midnight in the user's
 * own zone, which in Nepal is `2026-09-02T18:15:00.000Z`. Every reader
 * downstream then worked in UTC, so a resident who moved in on the 3rd was
 * billed from the **2nd**: 29 of 30 days instead of 28, on every intake, in the
 * one direction that overcharges.
 *
 * ## The bug the BS period exists to end
 *
 * The month was Gregorian and only its *label* was Nepali. `hostelPeriodOf`
 * returned `2026-09`, proration ran across September's 30 days, and the screens
 * printed "Bhadra" over the answer because Bhadra is the BS month covering most
 * of September. Bhadra 2083 is a different month — 17 Aug to 16 Sep 2026, 31
 * days — so a resident admitted on Bhadra 19 owed 13 of 31 days and was billed
 * 28 of 30. Every hostel in Nepal keeps its books in Bikram Sambat, and the
 * product was quietly doing its arithmetic in the other calendar.
 *
 * So a period is now a BS month: `2083-05` is Bhadra 2083. See the shared module
 * for the conversion rules and why the table is a dependency.
 */

export {
  addBsMonths,
  bsDayOfMonth,
  bsDaysInMonth,
  bsMonthStart,
  bsPeriodBounds,
  bsPeriodOf,
  bsPeriodsBetween,
  currentBsPeriod,
  formatBsDate,
  formatBsDayMonth,
  formatBsDayRange,
  formatBsPeriod,
  formatBsPeriodMonth,
  formatBsPeriodYear,
  fromBs,
  hostelCalendarDay,
  hostelDaysBetween,
  hostelToday,
  isBsPeriod,
  periodParts,
  toBs,
  BS_ERA,
  BS_MONTHS,
  HOSTEL_UTC_OFFSET_MINUTES,
} from "@hostel/shared/calendar/bs";

export type { BsDate } from "@hostel/shared/calendar/bs";

import { bsMonthStart, bsPeriodOf } from "@hostel/shared/calendar/bs";

/**
 * `2083-05` for the BS month a calendar day belongs to.
 *
 * Kept under its old name because a hundred call sites read as "the period this
 * date is in" and that is still exactly what it answers — only the calendar
 * underneath changed. Takes the *instant* and normalises it itself, because the
 * callers that get this wrong are exactly the ones passing `new Date()`: between
 * 18:15 and 24:00 UTC, Nepal is already on the next day, and near a BS month
 * boundary that is a different month.
 */
export function hostelPeriodOf(instant: Date): string {
  return bsPeriodOf(instant);
}

/**
 * The first day of the **BS** month an instant falls in, as UTC midnight.
 *
 * Rates change on the first of a month and never mid-month: a rate card that
 * starts on the 17th splits that month across two prices, which the billing run
 * refuses to do (`getEffectiveSchedule` gives a whole month to one card) and
 * which no resident can be shown a straight answer about.
 *
 * The month it normalises to is now Bikram Sambat, which is the month an owner
 * means when they say rates change next month. A card set to start "1 Aswin"
 * used to be pulled back to 1 September — a fortnight into Bhadra — and then
 * governed a Gregorian month that straddled both.
 */
export function hostelMonthStart(instant: Date): Date {
  return bsMonthStart(instant);
}
