/**
 * The hostel's calendar. Bikram Sambat is the primary one; Gregorian is a
 * translation of it.
 *
 * ## Why this file exists, and what it replaced
 *
 * Every month in this product was a **Gregorian** month wearing a Nepali label.
 * `hostelPeriodOf` produced `2026-09`, `periodBounds` gave that month's first
 * and last day, `computeInvoiceAmount` prorated across them — and then the
 * screens ran the answer through `formatPeriodBs`, which walks the AD month day
 * by day and prints whichever BS month covers more of it.
 *
 * That label is a rounding, and the arithmetic underneath it was never the
 * arithmetic a hostel does. Bhadra 2083 runs 17 Aug to 16 Sep 2026, 31 days. A
 * resident admitted on Bhadra 19 owes 13 of those 31 days. The old path billed
 * them 28 of September's 30 — a different month, a different denominator, a
 * different number — and printed "Bhadra" over it. The bill was wrong and the
 * word on it was right, which is the worst available combination.
 *
 * So the period key is now a **BS** month: `2083-05` is Bhadra 2083. Bounds,
 * proration, due dates and the billing cron all derive from it, and Gregorian is
 * produced for display beside it rather than being the thing underneath.
 *
 * ## Instants in, instants out
 *
 * Nothing here stores a BS string on a record. A date is persisted as the
 * instant it always was; this module is the one place that says which BS month
 * an instant falls in and which instants bound that month. A caller that starts
 * parsing a formatted BS string back into a date has reintroduced the ambiguity
 * the whole module exists to remove.
 *
 * ## A calendar day is UTC midnight of the Nepal day
 *
 * The convention `lib/hostel-day.ts` established, kept for the same reason:
 * `bsPeriodBounds` and `computeInvoiceAmount` count UTC days inclusively, so
 * normalising at the edge makes every existing reader correct without a second
 * date vocabulary running beside the first. Nepal is UTC+05:45 and has never
 * observed daylight saving, so the offset is exact arithmetic rather than a
 * timezone-database lookup on the slowest write in the portal.
 *
 * ## The table is a dependency, deliberately
 *
 * BS month lengths vary from 29 to 32 days **per year** and cannot be computed.
 * They are tabulated real data. `nepali-date-converter` (MIT) carries the table
 * for 2000-2090 BS. Off the end of it every function here throws rather than
 * guessing, and every caller falls back to Gregorian — a confidently wrong
 * Nepali due date is worse than an honest English one.
 *
 * ## One copy, two runtimes
 *
 * This file is the platform's single source for dates. The server imports it as
 * `@hostel/shared/calendar/bs`; the mobile app resolves `@hostel/calendar/bs` to
 * this exact path through Metro (see `apps/mobile/metro.config.js`). There is no
 * second implementation to drift from — that drift is precisely what produced a
 * screen whose Nepali month and Gregorian arithmetic disagreed.
 */

import NepaliDateExport from "nepali-date-converter";

/*
 * `nepali-date-converter` ships CJS with a `default` on the namespace. Bundlers
 * unwrap it, Node's ESM loader does not, and this module is loaded both ways —
 * by Metro on a phone and by Node under vitest. Unwrapping here rather than at
 * each call site keeps that one line of interop in one place.
 */
const NepaliDate = ((NepaliDateExport as unknown as { default?: typeof NepaliDateExport })
  .default ?? NepaliDateExport) as typeof NepaliDateExport;

/** Asia/Kathmandu, which has never observed daylight saving. */
export const HOSTEL_UTC_OFFSET_MINUTES = 5 * 60 + 45;

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/** The marker, because `2083` alone reads as a mistyped Gregorian year. */
export const BS_ERA = "BS";

/** Index 0 is Baisakh, matching `NepaliDate.getMonth()`. */
export const BS_MONTHS = [
  "Baisakh",
  "Jestha",
  "Asar",
  "Shrawan",
  "Bhadra",
  "Aswin",
  "Kartik",
  "Mangsir",
  "Poush",
  "Magh",
  "Falgun",
  "Chaitra",
] as const;

/** The span `nepali-date-converter`'s table actually covers. */
export const BS_YEAR_MIN = 2000;
export const BS_YEAR_MAX = 2090;

/**
 * The year at which a period key can only be Bikram Sambat.
 *
 * 2070 BS is 2013 AD, comfortably before this product existed, and 2070 AD is
 * comfortably after any invoice it will ever write. Anything below is read as
 * Gregorian history.
 */
export const BS_PERIOD_YEAR_FLOOR = 2070;

/** A Bikram Sambat date. `month` is 1-12, so `2083-05` is Bhadra. */
export type BsDate = { day: number; month: number; year: number };

/* -------------------------------------------------------------------------- */
/* The Nepal calendar day                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The hostel-local calendar day an instant falls on, as UTC midnight.
 *
 * Idempotent on a value it has already produced, which is what makes it safe to
 * apply at a validation edge and again in a service without shifting the date a
 * second time: UTC midnight is 05:45 local, still the same day, so it maps back
 * to itself.
 */
export function hostelCalendarDay(instant: Date): Date {
  const local = instant.getTime() + HOSTEL_UTC_OFFSET_MINUTES * MS_PER_MINUTE;

  return new Date(Math.floor(local / MS_PER_DAY) * MS_PER_DAY);
}

/** Today in the hostel's own reckoning, as UTC midnight. */
export function hostelToday(now: Date = new Date()): Date {
  return hostelCalendarDay(now);
}

/**
 * The last instant of the Nepal day `plusDays` after the one `instant` falls on.
 *
 * A due, or the end of a plan, is a **day** rather than a timestamp: "pay by
 * Bhadra 29" means all of Bhadra 29, so the instant is the final millisecond of
 * that day in Kathmandu — 18:14:59.999 UTC. A negative `plusDays` reaches back,
 * which is how a period that renews on a day ends the moment before it opens.
 */
export function hostelDayEnd(instant: Date, plusDays = 0): Date {
  const day = hostelCalendarDay(instant).getTime();

  return new Date(
    day + (plusDays + 1) * MS_PER_DAY - HOSTEL_UTC_OFFSET_MINUTES * MS_PER_MINUTE - 1,
  );
}

/**
 * Whole Nepal calendar days from the day `from` falls on to the day `to` falls
 * on — negative when `to` is the earlier.
 *
 * Counted between days, never between instants, so a count built on it moves
 * at midnight in Kathmandu and at no other time. Flooring milliseconds instead
 * moves it at whatever minute the deadline happens to carry, and a "3 days
 * left" read at breakfast becomes "2" at lunch on the same calendar day.
 */
export function hostelDaysBetween(from: Date, to: Date): number {
  return Math.round(
    (hostelCalendarDay(to).getTime() - hostelCalendarDay(from).getTime()) / MS_PER_DAY,
  );
}

/** The Gregorian year/month/day of the Nepal calendar day an instant falls on. */
export function hostelDayParts(instant: Date): {
  day: number;
  month: number;
  year: number;
} {
  const day = hostelCalendarDay(instant);

  return {
    day: day.getUTCDate(),
    month: day.getUTCMonth() + 1,
    year: day.getUTCFullYear(),
  };
}

/* -------------------------------------------------------------------------- */
/* AD to BS, and back                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The converter reads **device-local** getters (`getFullYear` / `getMonth` /
 * `getDate`), so the `Date` handed to it is only read correctly when its local
 * fields are the day we mean.
 *
 * Noon rather than midnight because no daylight-saving transition anywhere skips
 * the middle of a day, while several skip the start of one. Building with
 * `Date.UTC` instead would read a day ahead on any phone east of UTC+12 — an
 * invoice due 1 Bhadra shown as 2 Bhadra, with the Gregorian date beside it
 * still correct.
 */
function nepaliDateOf(year: number, month: number, day: number) {
  return new NepaliDate(new Date(year, month - 1, day, 12));
}

/** The reverse: BS fields to the Gregorian day, read back off local getters. */
function gregorianOf(bs: BsDate): { day: number; month: number; year: number } {
  const converted = new NepaliDate(bs.year, bs.month - 1, bs.day).toJsDate();

  return {
    day: converted.getDate(),
    month: converted.getMonth() + 1,
    year: converted.getFullYear(),
  };
}

/** The Bikram Sambat date an instant falls on, in Nepal's own day. */
export function toBs(instant: Date): BsDate {
  const { day, month, year } = hostelDayParts(instant);
  const nepali = nepaliDateOf(year, month, day);

  return {
    day: nepali.getDate(),
    month: nepali.getMonth() + 1,
    year: nepali.getYear(),
  };
}

/** A BS date as the instant that opens it — UTC midnight of its Gregorian day. */
export function fromBs(bs: BsDate): Date {
  const { day, month, year } = gregorianOf(bs);

  return new Date(Date.UTC(year, month - 1, day));
}

/* -------------------------------------------------------------------------- */
/* Periods                                                                    */
/* -------------------------------------------------------------------------- */

/** `2083-05` from its two numbers, with the padding rule in one place. */
export function formatPeriodKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * `2083-05` — the BS month an instant belongs to. The billing period key.
 *
 * Zero-padded so the key sorts lexically in the order the months run, which is
 * what every `sort()` and every Mongo range query on `period` already assumes.
 */
export function bsPeriodOf(instant: Date): string {
  const bs = toBs(instant);

  return formatPeriodKey(bs.year, bs.month);
}

/**
 * A period key split back into numbers, or `null` if it is not one.
 *
 * Deliberately tolerant of both calendars — see {@link isBsPeriod}. Callers that
 * need to know which one they were handed ask that; callers that only need the
 * two integers use this.
 */
export function periodParts(
  period: string | null | undefined,
): { month: number; year: number } | null {
  if (!period) {
    return null;
  }

  const match = /^(\d{4})-(\d{2})$/.exec(period.trim());

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);

  return month >= 1 && month <= 12 ? { month, year } : null;
}

/**
 * Whether a stored period key is Bikram Sambat.
 *
 * Both calendars write a period the same way, so the year is the only thing that
 * distinguishes them — and it distinguishes them completely. Gregorian years in
 * this product are in the 2000s; Bikram Sambat runs 57 years ahead. Nothing this
 * product will ever bill sits near the boundary.
 *
 * This exists because rows written before the calendar changed carry AD keys,
 * and a formatter that converted one of those a second time would print a month
 * 57 years out. The migration rewrites them; this is what keeps the readers
 * honest until it has, and honest afterwards if one is ever missed.
 */
export function isBsPeriod(period: string | null | undefined): boolean {
  const parts = periodParts(period);

  return parts !== null && parts.year >= BS_PERIOD_YEAR_FLOOR;
}

/** How many days that BS month runs to — 29 to 32, and never guessable. */
export function bsDaysInMonth(year: number, month: number): number {
  const start = fromBs({ day: 1, month, year });
  const next =
    month === 12
      ? fromBs({ day: 1, month: 1, year: year + 1 })
      : fromBs({ day: 1, month: month + 1, year });

  return Math.round((next.getTime() - start.getTime()) / MS_PER_DAY);
}

/**
 * The Gregorian instants a BS month opens and closes on, plus its length.
 *
 * The same shape the Gregorian `periodBounds` returned, so every reader — the
 * billing plan, the proration, the billable-residents query — works against a BS
 * month without learning a new type. `end` is the last millisecond of the
 * closing day, which is what a `$lte` range on an instant needs.
 *
 * ## `lastDay` is the one a due date may use, and `end` is not
 *
 * `end` is 23:59:59.999 **UTC**, and Nepal is 5h45m ahead of UTC — so that
 * instant is already 05:44 the following morning in Kathmandu. Billing used to
 * take the period's `end` as the invoice's due date verbatim, which meant a
 * Bhadra invoice was stamped due on a moment that every BS reader in the product
 * correctly named **Aswin 1**: the month on the invoice and the month in its due
 * date were one apart, on every invoice, in the direction that reads as a
 * missing deadline.
 *
 * So the closing *day* is returned separately, in the same UTC-midnight-of-the-
 * Nepal-day form as `start` and as everything `hostelCalendarDay` produces. A
 * due date is a calendar day and takes `lastDay`; a range query over instants
 * takes `end`.
 *
 * Throws rather than clamping. A Gregorian key reaching here is a row the
 * migration missed, and reading `2026-09` as a BS month would silently date it
 * to 1969 — so the calendar floor is checked, not just the table's own span.
 */
export function bsPeriodBounds(period: string): {
  daysInMonth: number;
  end: Date;
  lastDay: Date;
  start: Date;
} {
  const parts = periodParts(period);

  if (!parts) {
    throw new RangeError(`Period must be YYYY-MM, received ${String(period)}.`);
  }

  const { month, year } = parts;

  if (year < BS_PERIOD_YEAR_FLOOR || year > BS_YEAR_MAX) {
    throw new RangeError(
      `${period} is not a Bikram Sambat period this product can bill (${BS_PERIOD_YEAR_FLOOR}-${BS_YEAR_MAX} BS).`,
    );
  }

  const start = fromBs({ day: 1, month, year });
  const daysInMonth = bsDaysInMonth(year, month);
  const lastDay = new Date(start.getTime() + (daysInMonth - 1) * MS_PER_DAY);
  const end = new Date(start.getTime() + daysInMonth * MS_PER_DAY - 1);

  return { daysInMonth, end, lastDay, start };
}

/** The first day of the BS month an instant falls in, as UTC midnight. */
export function bsMonthStart(instant: Date): Date {
  const bs = toBs(instant);

  return fromBs({ day: 1, month: bs.month, year: bs.year });
}

/** The day of the BS month an instant falls on — 1 through 32. */
export function bsDayOfMonth(instant: Date): number {
  return toBs(instant).day;
}

/** `2083-05` plus or minus whole BS months, carrying the year. */
export function addBsMonths(period: string, delta: number): string {
  const parts = periodParts(period);

  if (!parts) {
    throw new RangeError(`Period must be YYYY-MM, received ${String(period)}.`);
  }

  const index = parts.year * 12 + (parts.month - 1) + delta;

  return formatPeriodKey(Math.floor(index / 12), (index % 12) + 1);
}

/**
 * The last instant a plan of `months` BS months, starting on `start`'s Nepal
 * day, covers.
 *
 * The same day of the month, `months` later, is the day it renews on, and the
 * period ends the moment before that day opens: a monthly plan taken on Bhadra
 * 26 runs through Aswin 25. Counted in the owner's own calendar because that is
 * the calendar they will check it against — Bhadra 2083 has 31 days, and a
 * Gregorian `setMonth` from 11 September gives 30 of them.
 *
 * A start on a day the target month does not have (Bhadra 32, into a 30-day
 * Aswin) renews on that month's last day rather than spilling into the next.
 */
export function bsMonthsEnd(start: Date, months: number): Date {
  const bs = toBs(start);
  const index = bs.year * 12 + (bs.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const renews = fromBs({
    day: Math.min(bs.day, bsDaysInMonth(year, month)),
    month,
    year,
  });

  return hostelDayEnd(renews, -1);
}

/** The BS month this instant is in — what a billing run wakes up to bill. */
export function currentBsPeriod(now: Date = new Date()): string {
  return bsPeriodOf(now);
}

/* -------------------------------------------------------------------------- */
/* Display                                                                    */
/* -------------------------------------------------------------------------- */

/** `Bhadra`, from a 1-12 month number. Empty for anything else. */
export function bsMonthName(month: number): string {
  return BS_MONTHS[month - 1] ?? "";
}

/**
 * `Bhadra 2083 BS` — a period named the way a notice board names it.
 *
 * Month first, year last, era spelled out. That is how a Nepali date is written
 * on a receipt book and a government form, and the era matters more here than it
 * would in a Nepali-only product because several screens print both calendars on
 * the same card.
 *
 * Returns `""` for a key this cannot name, which is every caller's cue to fall
 * back to the Gregorian label rather than print a guess.
 */
export function formatBsPeriod(period: string | null | undefined): string {
  const parts = periodParts(period);

  if (!parts || !isBsPeriod(period)) {
    return "";
  }

  const name = bsMonthName(parts.month);

  return name ? `${name} ${parts.year} ${BS_ERA}` : "";
}

/** `Bhadra` — inside a list whose heading already names the year. */
export function formatBsPeriodMonth(period: string | null | undefined): string {
  const parts = periodParts(period);

  return parts && isBsPeriod(period) ? bsMonthName(parts.month) : "";
}

/** `2083 BS` — the heading a list of months is grouped under. */
export function formatBsPeriodYear(period: string | null | undefined): string {
  const parts = periodParts(period);

  return parts && isBsPeriod(period) ? `${parts.year} ${BS_ERA}` : "";
}

/**
 * **The platform's one date format: `Baisakh · 2083-01-15`.**
 *
 * Every screen on the web and in the app, every CSV and every PDF prints a day
 * this way — the month by name so it reads at a glance, then the full BS date
 * in numbers so it sorts and copies cleanly (docs/PORTAL_POLISH_2026_10.md).
 * There is no second format: a page that writes `14 Nov 2026` beside one that
 * writes `Kartik 28, 2083` makes the reader convert, and that is exactly when
 * a due date gets misread.
 *
 * Empty off the table, never a guess.
 */
export function formatBsDate(instant: Date | null | undefined): string {
  if (!instant || Number.isNaN(instant.getTime())) {
    return "";
  }

  try {
    const bs = toBs(instant);
    const name = bsMonthName(bs.month);

    return name ? `${name} ${DATE_SEPARATOR} ${formatBsNumeric(bs)}` : "";
  } catch {
    return "";
  }
}

/** The dot between the month name and the numbers, for a caller that splits the two. */
export const DATE_SEPARATOR = "·";

/** `2083-01-15` — the numeric half of the one format. */
function formatBsNumeric(bs: BsDate): string {
  return `${bs.year}-${String(bs.month).padStart(2, "0")}-${String(bs.day).padStart(2, "0")}`;
}

/** Kept for its callers; the AD half is gone — there is one date format. */
export const formatBsAdDate = formatBsDate;

/** Whatever a record or an API hands over — an instant, an ISO string, epoch ms. */
export type DateInput = Date | string | number | null | undefined;

function toInstant(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;

  const instant = value instanceof Date ? value : new Date(value);

  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * {@link formatBsDate} for any stored value, with a stand-in for an empty or
 * unreadable one — the function screens and exports call.
 */
export function formatHostelDate(value: DateInput, empty = "—"): string {
  return formatBsDate(toInstant(value)) || empty;
}

/** `2:45 pm`, on Nepal's clock whatever the device or server is set to. */
export function formatHostelTime(value: DateInput, empty = "—"): string {
  const instant = toInstant(value);

  if (!instant) return empty;

  const local = new Date(instant.getTime() + HOSTEL_UTC_OFFSET_MINUTES * 60_000);
  const hour = local.getUTCHours();
  const minute = local.getUTCMinutes();

  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "am" : "pm"}`;
}

/** `Baisakh · 2083-01-15, 2:45 pm` — the one format with Nepal's clock after it. */
export function formatHostelDateTime(value: DateInput, empty = "—"): string {
  const date = formatHostelDate(value, "");

  return date ? `${date}, ${formatHostelTime(value)}` : empty;
}

/** `Bhadra 19` — inside a section whose heading already names the year. */
export function formatBsDayMonth(instant: Date | null | undefined): string {
  if (!instant) {
    return "";
  }

  try {
    const bs = toBs(instant);
    const name = bsMonthName(bs.month);

    return name ? `${name} ${bs.day}` : "";
  } catch {
    return "";
  }
}

/**
 * `Bhadra 19-31` — the span of a BS month a part-month charge actually covers.
 *
 * The sentence a resident needs on a prorated row, and the one `"13/31 days"`
 * could not give them: a fraction says how much was charged and says nothing
 * about *which* days, so a resident checking a mid-month move-in against their
 * own memory had nothing to check it against.
 *
 * An en dash, not a hyphen: this is a range, and the two read differently at the
 * size a list row renders at.
 */
export function formatBsDayRange(from: Date, to: Date): string {
  const start = toBs(from);
  const end = toBs(to);
  const name = bsMonthName(start.month);

  if (!name) {
    return "";
  }

  if (start.year === end.year && start.month === end.month) {
    return start.day === end.day
      ? `${name} ${start.day}`
      : `${name} ${start.day}–${end.day}`;
  }

  const endName = bsMonthName(end.month);

  return endName ? `${name} ${start.day} – ${endName} ${end.day}` : "";
}

/**
 * Every BS period from `from` to `to` inclusive, oldest first.
 *
 * ## Why this is here and not walked by each caller
 *
 * Two services need "a row per month between these two months" — the payments
 * month picker and a resident's own ledger — and both walked it with
 * `cursor.setUTCMonth(cursor.getUTCMonth() + 1)`, which steps a *Gregorian*
 * month. After the cutover those walks produced `2026-09` while the invoices
 * they were joined against were keyed `2083-05`, so every lookup missed: a
 * resident's ledger showed twelve months of `NOT_BILLED` over real invoices, and
 * the picker offered a hundred months the hostel has never billed in.
 *
 * The step that carries a year correctly is `addBsMonths`, and the reason to put
 * the loop beside it rather than in each service is that a second walker is
 * exactly what produced the defect the first time.
 *
 * ## Both ends are period keys, not instants
 *
 * A caller holding a `Date` converts with {@link bsPeriodOf} first. Taking
 * instants here would invite the same call site to pass a Gregorian month start
 * it built by hand, which is the shape of the bug this replaces.
 *
 * `cap` bounds the result because both callers derive `from` from stored data —
 * a resident's `moveInDate`, a hostel's `createdAt` — and one bad year in one
 * document would otherwise build a table with six hundred rows in it. Reaching
 * the cap truncates the *old* end, keeping the months nearest `to`, because a
 * screen that can only show a hundred months should show the recent ones.
 *
 * An empty array when `from` is after `to`: a hostel approved this month has no
 * history, and that is not an error.
 */
export function bsPeriodsBetween(from: string, to: string, cap = 120): string[] {
  const start = periodParts(from);
  const end = periodParts(to);

  if (!start || !end) {
    throw new RangeError(
      `Periods must be YYYY-MM, received ${String(from)} and ${String(to)}.`,
    );
  }

  const span =
    (end.year * 12 + (end.month - 1) - (start.year * 12 + (start.month - 1))) + 1;

  if (span <= 0) {
    return [];
  }

  const length = Math.min(span, cap);
  // Counted back from `to` so the cap drops the oldest months rather than the
  // newest — the truncated end is the one nobody is looking for.
  const first = addBsMonths(to, -(length - 1));

  return Array.from({ length }, (_, offset) => addBsMonths(first, offset));
}

/* -------------------------------------------------------------------------- */
/* Fiscal year                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The BS month the fiscal year opens on. Shrawan — the fourth, 1-indexed.
 *
 * Nepal's fiscal year runs Shrawan 1 to the last day of Asar, so it straddles
 * two Bikram Sambat years and is named after both. It is not the calendar year
 * and it is not derivable from a Gregorian one either: Shrawan 1 lands in
 * mid-July, which is neither an AD year boundary nor an AD quarter boundary.
 */
const FISCAL_YEAR_START_MONTH = 4;

/**
 * `2083/84` — the fiscal year an instant falls in, as it is printed.
 *
 * Every statutory document numbered in this codebase carries it, because a
 * document sequence restarts each fiscal year and a bare sequence number is
 * therefore ambiguous across years. `INV-2083/84-000012` says which run of the
 * counter produced it; `INV-000012` does not.
 *
 * The second half is the last two digits of the closing year, which is the form
 * used on Nepali tax paperwork — `2083/84`, never `2083/2084`. That is a
 * convention rather than a shortening we chose, so it is applied here rather
 * than left to each caller to remember.
 *
 * Returns `""` off the end of the conversion table, matching every other
 * formatter in this file: a caller that cannot get a Nepali fiscal year prints
 * nothing rather than a confidently wrong one.
 */
export function bsFiscalYear(instant: Date | null | undefined): string {
  if (!instant) {
    return "";
  }

  try {
    const bs = toBs(instant);
    const opening =
      bs.month >= FISCAL_YEAR_START_MONTH ? bs.year : bs.year - 1;

    return `${opening}/${String(opening + 1).slice(-2)}`;
  } catch {
    return "";
  }
}
