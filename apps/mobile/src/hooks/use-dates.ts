import { useMemo } from "react";

import {
  type CalendarSystem,
  formatAgoIn,
  formatDateIn,
  formatDateLongIn,
  formatDateTimeIn,
  formatDayMonthIn,
  formatPeriodIn,
  formatPeriodMonthIn,
  formatPeriodYearIn,
  formatRelativeDayIn,
  formatYearIn,
} from "@/lib/calendar";

/**
 * Every date in the app, already in the calendar the reader chose.
 *
 * ## Why a hook rather than a module-level switch
 *
 * The tempting shortcut is a mutable `activeCalendar` inside `lib/format.ts`,
 * set once at boot, so no call site has to change. It does not work: React
 * re-renders on state, and a module variable is not state — the owner would flip
 * the setting, walk back to Money, and find August still spelled in English
 * until the screen happened to remount for some other reason. Reading the
 * preference through `useAppSelector` is what makes the change land everywhere
 * on the same frame.
 *
 * ## The names are short on purpose
 *
 * `dates.date(row.createdAt)` rather than `formatDateIn(calendar, …)` at a
 * hundred call sites. The bundle is memoised on the preference, so the identity is
 * stable across renders and it is safe in a `useMemo` dependency list — which
 * matters, because several admin screens build their row text inside one.
 *
 * ## Scope: every screen, every role
 *
 * This started as an admin-only hook, on the argument that the calendar was the
 * hostel's bookkeeping choice and a resident should not inherit it. That was
 * backwards. The preference is **stored on this phone**, not on the hostel — it
 * describes the person holding it, the same way the theme does — so there was
 * never a resident inheriting an owner's setting to worry about. What actually
 * happened was that a resident opened Payments and read a rent month in a
 * calendar they do not keep, in a country where Bikram Sambat is the civil one.
 *
 * So the rule now: **any screen that draws a date calls `useDates()`.** Resident,
 * guardian, cook, service provider, store, admin and the shared screens all go
 * through here, and `lib/calendar-single-source.test.ts` fails the build for a
 * screen under `app/` that reaches past it into `lib/format`.
 *
 * The exceptions are listed in that test, and each is a date that genuinely has
 * no calendar to choose: a `YYYY-MM-DD` field someone types into, a chart axis
 * whose labels only need to differ from each other, and the statement export,
 * which prints both calendars because it leaves the app.
 */
export type PortalDates = {
  /** `2 hrs ago`, falling back to a date past a week. */
  ago: (value: Date | string | null | undefined, now?: Date) => string;
  /** Which calendar is in force, for the rare screen that needs to branch. */
  calendar: CalendarSystem;
  /** `18 Aug 2026` / `Bhadra 2, 2083 BS`. */
  date: (value: Date | string | null | undefined) => string;
  /**
   * Both calendars at once — `Bhadra 2, 2083 BS (18 Aug 2026)`.
   *
   * For the few dates an owner has to act on rather than merely read. A rate
   * card that said "Effective from 17 Aswin 2083" gave no clue that it had not
   * started yet, because working out where 17 Aswin falls against today is
   * arithmetic nobody does at a desk. Anything that decides *when money changes*
   * prints both; ordinary row timestamps stay in the one calendar the owner
   * chose, or every list turns into a parenthesis.
   */
  dateBoth: (value: Date | string | null | undefined) => string;
  /**
   * The date with its weekday — `Bhadra 2, 2083 BS · Tuesday`.
   *
   * Only for a date that is the *subject* of what is on screen: the day an
   * attendance row is about, the day a roll call covers, the heading over a
   * day's meal photos. See `formatDateLongIn` for why it is not the default.
   */
  dateLong: (value: Date | string | null | undefined) => string;
  /** `18 Aug 2026, 2:45 pm` / `Bhadra 2, 2083 BS, 2:45 pm`. */
  dateTime: (value: Date | string | null | undefined) => string;
  /**
   * A day with the year left off — `18 Aug` / `Bhadra 2`.
   *
   * For a row inside a section whose heading already carries the year, and
   * nowhere else. The invoice list is the case it exists for: under a `2083 BS`
   * heading, a row reading `Bhadra 2083 BS` over `Aswin 15, 2083 BS` prints the
   * year three times, and the repetition is what made two genuinely different
   * dates on one row read as a glitch.
   */
  dayMonth: (value: Date | string | null | undefined) => string;
  /** `"2026-08"` → `August 2026` / `Shrawan 2083 BS`. */
  period: (period: string | null | undefined) => string;
  /** `"2026-08"` → `August` / `Shrawan`. The year-less form of {@link period}. */
  periodMonth: (period: string | null | undefined) => string;
  /**
   * `"2026-08"` → `2026` / `2083 BS`.
   *
   * The heading a list of months groups under. Group **by this**, never by the
   * first four characters of the period key: a Gregorian year spans two BS ones.
   */
  periodYear: (period: string | null | undefined) => string;
  /** `Today` / `Yesterday` / the date. */
  relativeDay: (value: Date | string | null | undefined, now?: Date) => string;
  /** An instant's year — `2026` / `2083 BS`. The {@link periodYear} of a date. */
  year: (value: Date | string | null | undefined) => string;
};

/**
 * Fixed to Bikram Sambat: the platform prints one date format everywhere —
 * `Baisakh · 2083-01-15` (docs/PORTAL_POLISH_2026_10.md). The stored
 * preference is no longer read and its picker is gone.
 */
const calendar: CalendarSystem = "BS";

export function useDates(): PortalDates {
  return useMemo(
    () => ({
      ago: (value, now) => formatAgoIn(calendar, value, now),
      calendar,
      date: (value) => formatDateIn(calendar, value),
      dateBoth: (value) => formatDateIn(calendar, value),
      dateLong: (value) => formatDateLongIn(calendar, value),
      dateTime: (value) => formatDateTimeIn(calendar, value),
      dayMonth: (value) => formatDayMonthIn(calendar, value),
      period: (value) => formatPeriodIn(calendar, value),
      periodMonth: (value) => formatPeriodMonthIn(calendar, value),
      periodYear: (value) => formatPeriodYearIn(calendar, value),
      relativeDay: (value, now) => formatRelativeDayIn(calendar, value, now),
      year: (value) => formatYearIn(calendar, value),
    }),
    [],
  );
}
