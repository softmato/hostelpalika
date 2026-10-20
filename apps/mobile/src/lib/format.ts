/**
 * Money and dates, formatted once so no screen invents its own.
 *
 * ## Why not `Intl`
 *
 * Hermes ships an `Intl` implementation backed by the *platform's* ICU — the
 * OS's, not the bundle's — so `en-NP` grouping and `Asia/Kathmandu` resolve
 * differently on an Android 9 handset than on the simulator, and an
 * unrecognised locale silently degrades to `en-US`. Money on an invoice is not
 * a place for "usually right", so the grouping and the timezone shift are done
 * by hand here. They are pure functions, which is also what makes them
 * testable under the repo's node-environment Vitest setup.
 *
 * ## Nepal time
 *
 * NPT is a fixed UTC+05:45 with no daylight saving, so one constant offset is
 * the whole implementation. This matters more than it looks: a payment made at
 * 00:30 Kathmandu time is still *yesterday* in UTC, and a dashboard that says
 * "today's menu" while reading UTC days serves the wrong dinner for the last
 * 5 hours 45 minutes of every day.
 */

import NepaliDate from "nepali-date-converter";

import {
  bsPeriodOf,
  formatBsDate,
  formatBsPeriod,
  formatBsPeriodMonth,
  formatBsPeriodYear,
  fromBs,
  isBsPeriod,
  periodParts as bsPeriodParts,
} from "@hostel/calendar/bs";

/**
 * Nepal is UTC+05:45 year-round, with no daylight saving.
 *
 * **Exported, and it must be imported rather than restated.** Two other modules
 * carried their own `5 * 60 + 45` — `lib/manage-dates.ts` and `lib/food-week.ts`
 * — which is three chances to fix a bug in one of them. There is one offset in
 * this app and this is it.
 */
export const NEPAL_OFFSET_MINUTES = 5 * 60 + 45;

/**
 * The Gregorian month names, and the only copies of them.
 *
 * `lib/admin-home.ts` and `lib/payment-months.ts` each held a private twelve-
 * string array plus a private `YYYY-MM` regex, so the app had three answers to
 * "what is month 08 called" and three parsers that could disagree about a
 * malformed period. Both now read these and {@link periodParts}.
 */
export const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * The era marker that ends every Bikram Sambat string this app prints.
 *
 * A bare `2083` is ambiguous in a product that shows both calendars — often on
 * the same card — and `BS` is the two characters that remove the ambiguity for
 * the cost of two characters. Never `B.S.`: the app writes `NPR`, `QR` and
 * `SOS` without stops and this is the same kind of word.
 */
const BS_ERA = "BS";

/** The long forms — `August`. Same rule as {@link MONTHS_SHORT}. */
export const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/* -------------------------------------------------------------------------- */
/* Money                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Thousands separators, three digits at a time.
 *
 * Deliberately *not* the lakh/crore grouping (`1,23,456`) some Nepali software
 * uses: every amount already rendered by `apps/web` is plain
 * `toLocaleString()`, and the two styles side by side on the same invoice —
 * one in the app, one in the emailed receipt — reads as a mismatch rather than
 * as a locale preference.
 */
function group(digits: string) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Renders paisa only when there are any.
 *
 * Rent is whole rupees, so `Rs 8,500.00` is noise on every row; a settlement
 * that genuinely lands on `1200.5` must not be shown as `1,200`, because a
 * balance that does not add up is the one thing a resident will call about.
 */
export function formatAmount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }

  const negative = value < 0;
  const absolute = Math.abs(value);
  const rounded = Math.round(absolute * 100) / 100;
  const whole = Math.floor(rounded);
  const paisa = Math.round((rounded - whole) * 100);
  const body =
    paisa === 0
      ? group(String(whole))
      : `${group(String(whole))}.${String(paisa).padStart(2, "0")}`;

  return negative ? `-${body}` : body;
}

/**
 * `Rs 8,500`.
 *
 * The symbol every Nepali banking app our users already have prints — eSewa,
 * Khalti and EBL Touch all write `Rs`, and so do the payment screens' designs.
 * It was `NPR` until 2026-09-05, which is the ISO code rather than the thing
 * people read on a receipt; the server-side PDFs still say `NPR`, and that is
 * the one place the two differ.
 *
 * `<Money>` splits on this prefix to draw the currency smaller than its digits,
 * so the two have to agree on the exact string.
 */
export function formatMoney(value: number | null | undefined): string {
  const amount = formatAmount(value);

  return amount === "—" ? amount : `Rs ${amount}`;
}

/**
 * The shape a hidden amount takes on the hostel hero.
 *
 * A fixed string, not the real figure with its digits swapped: `Rs 74,000`
 * masked character for character still prints `Rs XX,XXX`, which tells anyone
 * reading over the owner's shoulder the order of magnitude — the one thing the
 * eye toggle exists to withhold. `—` stays `—`, because the absence of a figure
 * is not a secret.
 */
export function maskMoney(value: string): string {
  return value === "—" ? value : "Rs XXX.xx";
}

/**
 * The hero headline's font size, stepped down by how long the string is.
 *
 * The headline is one line by construction — a rupee figure that wraps is not a
 * figure any more, it is two — so something has to give when the number is long,
 * and the choice is between shrinking the text and ellipsing it. Ellipsing a
 * *total* is the worst possible truncation: `NPR 12,84,…` is not a smaller
 * version of the number, it is a different number.
 *
 * ## Why not `adjustsFontSizeToFit`
 *
 * React Native only implements it on iOS. On Android the prop is accepted and
 * ignored, which is the failure mode that gets shipped — it looks right on the
 * simulator the developer has open and clips on every phone in Nepal.
 *
 * So the size comes from the character count instead. Approximate by design: the
 * steps are wide enough that being a character or two out cannot push a string
 * past the edge, and the arithmetic holds for the only alphabet this string is
 * ever in (`Rs`, digits, commas, a possible minus).
 */
export function heroAmountSize(amount: string): number {
  const length = amount.length;

  /*
   * Each step is one character tighter than it was, because the prefix lost one
   * when `NPR` became `Rs`.
   *
   * The counts are a proxy for *width*, and the same rupee figure is now a
   * character shorter than the string these numbers were calibrated against —
   * so leaving them alone would have let a nine-digit total sit at 34 points
   * where the old calibration said it must step down. `Rs` renders at 0.72
   * scale, so it buys back rather less than a full digit of room; taking the
   * conservative reading keeps every existing figure at exactly the size it
   * had, and the one failure this function exists to prevent is a total that
   * clips.
   */
  if (length <= 13) {
    return 34;
  }

  if (length <= 16) {
    return 29;
  }

  if (length <= 19) {
    return 24;
  }

  return 20;
}

/* -------------------------------------------------------------------------- */
/* Dates                                                                      */
/* -------------------------------------------------------------------------- */

type NepalParts = {
  day: number;
  hour: number;
  minute: number;
  month: number;
  weekday: number;
  year: number;
};

function parseDate(value: Date | string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The calendar fields as they read on a wall clock in Kathmandu.
 *
 * Shifting the instant and then using the **UTC** getters is the trick: it
 * moves the clock without the device's own timezone getting a vote, so a phone
 * left on London time shows the same dates as one in Nepal.
 */
function nepalParts(date: Date): NepalParts {
  const shifted = new Date(date.getTime() + NEPAL_OFFSET_MINUTES * 60_000);

  return {
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    month: shifted.getUTCMonth(),
    weekday: shifted.getUTCDay(),
    year: shifted.getUTCFullYear(),
  };
}

/**
 * A day identity in Nepal time — the key "is this the same day" questions use.
 *
 * Exported so callers that need a *shifted* day — `lib/night-status.ts` asks
 * which night an instant belongs to, not which calendar day — can reuse the one
 * definition of the offset instead of restating `+05:45` and drifting from it.
 */
export function nepalDayKey(date: Date): string {
  const { day, month, year } = nepalParts(date);

  return `${year}-${month}-${day}`;
}

/**
 * The month an instant belongs to, in the hostel's calendar — `2083-05`.
 *
 * **An identity, not a label.** This is the key the app sends the server — the
 * month chip on the admin Money screen becomes `adminQuery.money(...)` and then
 * a `period` on the wire — so it has to be the same string the server keys
 * invoices by, character for character. It used to assemble a Gregorian
 * `2026-08` by hand, which stopped being that string the moment billing moved
 * to Bikram Sambat: the app would have asked for a month the server has no
 * invoices in and drawn an empty screen with no error on it.
 *
 * Delegated to the shared calendar rather than reimplemented here for exactly
 * that reason. The offset is the same one `nepalDayKey` uses — a phone left on
 * UTC is 5h45m behind Kathmandu, which matters for the last quarter of every
 * day, and on a month boundary that is a different month.
 */
export function nepalPeriodKey(date: Date = new Date()): string {
  return bsPeriodOf(date);
}

/**
 * `"2026-08"` → the year and the zero-based month, or `null`.
 *
 * The one `YYYY-MM` parser. Every reader of a period key went through its own
 * copy of this regex and its own range check, and "malformed period" then meant
 * something slightly different in each of them — one returned the raw string,
 * one dropped the row, one rendered `undefined`. They now share a `null` and
 * each still decides what to do with it, which is the part that legitimately
 * differs.
 *
 * The fields are the *Nepal* calendar's year and month, because that is what
 * the server's period key already is — see {@link nepalPeriodKey}.
 */
export function periodParts(
  period: string | null | undefined,
): { monthIndex: number; year: number } | null {
  const parts = bsPeriodParts(period);

  return parts ? { monthIndex: parts.month - 1, year: parts.year } : null;
}

/**
 * The Gregorian month a Bikram Sambat period mostly falls in.
 *
 * ## The direction of this conversion is the whole change
 *
 * A period used to be a Gregorian month and the BS label was the derived,
 * approximate half. It is the other way round now: `2083-05` is Bhadra, the
 * month the hostel bills, and *Gregorian* is what has to be rounded — Bhadra
 * 2083 runs 17 August to 16 September 2026, so it is genuinely in two Gregorian
 * months and neither one names it.
 *
 * It names the one covering more of the period, which is the same rounding
 * anybody makes calling Bhadra's rent "September's rent" in English. The exact
 * span is never lost: it is on the invoice, and `formatPeriodBoth` prints both
 * calendars where there is room.
 *
 * The majority is counted day by day rather than guessed from the 1st, because
 * BS month lengths vary from 29 to 32 days per year and the boundary does not
 * sit in the same place twice.
 *
 * ## Rows written before the calendar changed
 *
 * A stored `2026-09` is a Gregorian key from before the migration, and reading
 * it as Bikram Sambat would date it to 1969. `isBsPeriod` tells them apart —
 * the two calendars are 57 years apart and nothing this product bills sits near
 * the boundary — and a legacy key is returned as the Gregorian month it always
 * was.
 */
function periodGregorianParts(
  period: string | null | undefined,
): { monthIndex: number; year: number } | null {
  const parts = bsPeriodParts(period);

  if (!parts) {
    return null;
  }

  if (!isBsPeriod(period)) {
    // A Gregorian key the migration has not reached. Already what it claims.
    return { monthIndex: parts.month - 1, year: parts.year };
  }

  try {
    const tally = new Map<string, { count: number; monthIndex: number; year: number }>();

    for (let day = 1; day <= 32; day += 1) {
      const instant = fromBs({ day, month: parts.month, year: parts.year });

      // BS months are 29 to 32 days; past the end the converter rolls into the
      // next month, and those days are not this period's to count.
      if (bsPeriodOf(instant) !== period!.trim()) {
        break;
      }

      const monthIndex = instant.getUTCMonth();
      const year = instant.getUTCFullYear();
      const key = `${year}-${monthIndex}`;
      const seen = tally.get(key);

      if (seen) {
        seen.count += 1;
      } else {
        tally.set(key, { count: 1, monthIndex, year });
      }
    }

    let winner: { count: number; monthIndex: number; year: number } | null = null;

    // Strict comparison, so a period split exactly down the middle keeps the
    // month it started in rather than flipping on a Map iteration detail.
    for (const entry of tally.values()) {
      if (!winner || entry.count > winner.count) {
        winner = entry;
      }
    }

    return winner ? { monthIndex: winner.monthIndex, year: winner.year } : null;
  } catch {
    return null;
  }
}

/**
 * A Nepal-local calendar day, converted to Bikram Sambat.
 *
 * ## The one place an AD day becomes a BS one
 *
 * Every BS string in this app comes through here, so the conversion has exactly
 * one timezone bug to get wrong rather than one per call site.
 *
 * ## Why the local constructor, and not `Date.UTC`
 *
 * `nepali-date-converter` converts with `getFullYear()` / `getMonth()` /
 * `getDate()` — the **device-local** getters (`convertToBS` in its `es5` build).
 * So the `Date` handed to it is only read correctly when its *local* fields are
 * the day we mean.
 *
 * This used to build `new Date(Date.UTC(y, m, d, 12))`. Noon UTC survives every
 * offset from -11 to +11 and breaks past that: on a phone set to Auckland
 * (UTC+12, +13 in summer) or Fiji, noon UTC is already **the next day** locally,
 * and every Nepali date in the app read one day ahead — an invoice due 1 Bhadra
 * shown as 2 Bhadra, with the Gregorian date beside it still correct. A silent
 * one-day disagreement between the two calendars on the same row is the exact
 * failure the BS support exists to prevent.
 *
 * `new Date(y, m, d, 12)` sets the local fields directly, so they read back as
 * `y`/`m`/`d` in every timezone there is. Noon rather than midnight because no
 * daylight-saving transition anywhere skips the middle of the day, while
 * several skip the start of it.
 *
 * Throws for a day outside the converter's 2000–2090 BS table — callers catch
 * and fall back to Gregorian rather than printing a guess.
 */
function toNepaliDate(year: number, monthIndex: number, day: number): NepaliDate {
  return new NepaliDate(new Date(year, monthIndex, day, 12));
}

/** `16 Aug 2026`. */
export function formatDate(value: Date | string | null | undefined): string {
  const date = parseDate(value);

  if (!date) {
    return "—";
  }

  const { day, month, year } = nepalParts(date);

  return `${day} ${MONTHS_SHORT[month]} ${year}`;
}

/**
 * The same instant in Bikram Sambat — `Bhadra 2, 2083 BS`.
 *
 * ## Why the month leads, and why the era is spelled out
 *
 * `D MMMM YYYY` (`2 Bhadra 2083`) is how the converter formats by default and
 * it is not how a Nepali date is written down. A notice board, a receipt book
 * and a government form all put the month first and the year last — `Shrawan
 * 26, 2083` — and they all say **BS**, because `2083` on its own is a number
 * that could be a Gregorian year somebody mistyped.
 *
 * The marker matters more here than it would in a Nepali-only product: this app
 * prints both calendars on the same card in several places, and a reader
 * scanning a column of dates needs to know which one they are in without
 * working it out from the magnitude of the year.
 *
 * ## Why both calendars, everywhere a date is money
 *
 * Decided 2026-08-17: **show both, side by side**, rather than choosing one.
 * Nobody in Nepal reads a rent due date in a single calendar — the hostel's
 * books run on BS and the bank's statement runs on AD — so a one-calendar date
 * makes somebody convert in their head at exactly the moment a mistake costs
 * money.
 *
 * ## The conversion is a dependency, deliberately
 *
 * BS month lengths **vary per year** and cannot be calculated; they are a
 * tabulated table of real data. Hand-copying ~30 years of it would be inventing
 * data that looks authoritative and is wrong in one cell nobody notices for a
 * year. `nepali-date-converter` (MIT) carries the table, and it was checked here
 * against five known New Year anchors — 2013-04-14, 2023-04-14, 2024-04-13,
 * 2025-04-14 and 2026-04-14 all land on Baisakh 1 — before being adopted.
 *
 * ## Nepal time first
 *
 * The conversion runs on the *Nepal* calendar day, not the device's. An invoice
 * due "1 Bhadra" must read the same on a phone left on another timezone, which
 * is the same reason `nepalParts` exists.
 */
export function formatDateBs(value: Date | string | null | undefined): string {
  const date = parseDate(value);

  if (!date) {
    return "—";
  }

  // The platform's one date format — `Baisakh · 2083-01-15` — from the shared
  // calendar. Off the table it falls back to Gregorian rather than a wrong
  // Nepali date: being silently wrong about a due date is the one outcome
  // worth avoiding here.
  return formatBsDate(date) || formatDate(date);
}

/**
 * Both calendars, BS first — `Bhadra 2, 2083 BS · 18 Aug 2026`.
 *
 * BS leads because it is the one the hostel quotes; AD follows because it is the
 * one the bank and the phone agree on. Falls back to the Gregorian date alone
 * when the conversion is unavailable, never to a doubled or a wrong one.
 */
export function formatDateBoth(
  value: Date | string | null | undefined,
): string {
  // One date format now (docs/PORTAL_POLISH_2026_10.md): the name stays for its callers.
  return formatDateBs(value);
}

/** `2:45 pm`. Lowercase meridiem — it sits next to a date, not alone. */
export function formatTime(value: Date | string | null | undefined): string {
  const date = parseDate(value);

  if (!date) {
    return "—";
  }

  const { hour, minute } = nepalParts(date);
  const meridiem = hour < 12 ? "am" : "pm";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;

  return `${twelve}:${String(minute).padStart(2, "0")} ${meridiem}`;
}

/** `16 Aug 2026, 2:45 pm`. */
export function formatDateTime(
  value: Date | string | null | undefined,
): string {
  const date = parseDate(value);

  return date ? `${formatDate(date)}, ${formatTime(date)}` : "—";
}

/** `Sunday`. */
export function formatWeekday(value: Date | string | null | undefined): string {
  const date = parseDate(value);

  return date ? WEEKDAYS[nepalParts(date).weekday] : "—";
}

/**
 * `Today` / `Yesterday` / `16 Aug 2026`.
 *
 * For notice and claim timestamps, where the exact date matters far less than
 * whether the thing is new.
 */
export function formatRelativeDay(
  value: Date | string | null | undefined,
  now: Date = new Date(),
): string {
  const date = parseDate(value);

  if (!date) {
    return "—";
  }

  if (nepalDayKey(date) === nepalDayKey(now)) {
    return "Today";
  }

  const yesterday = new Date(now.getTime() - 86_400_000);

  if (nepalDayKey(date) === nepalDayKey(yesterday)) {
    return "Yesterday";
  }

  return formatDate(date);
}

/** `"2026-08"` → `August 2026`. The invoice `month` field's format. */
export function formatPeriod(period: string | null | undefined): string {
  const parts = periodGregorianParts(period);

  return parts
    ? `${MONTHS_LONG[parts.monthIndex]} ${parts.year}`
    : period?.trim() || "—";
}

/**
 * A period in Bikram Sambat — `Bhadra 2083 BS`.
 *
 * ## One month, named after the one the period mostly is
 *
 * The two calendars do not line up: BS months begin somewhere around the middle
 * of an AD one, so `2026-09` runs from the back half of Bhadra into the front
 * half of Aswin. This used to name both ends — `Bhadra–Aswin 2083` — which is
 * literally accurate and reads, at a glance under a strip of month chips, like
 * two months are selected.
 *
 * So it names **one**: the BS month that covers more days of the period than
 * the other does. That is a rounding, and it is the same rounding a hostel
 * already makes when it calls this month's rent Bhadra's rent. The exact
 * Gregorian month is not lost — it is the chip directly above this line, and
 * `formatPeriodBoth` still prints both calendars where there is room.
 *
 * The majority is counted day by day rather than guessed from the first of the
 * month, because BS month lengths vary from 29 to 32 days per year and the
 * boundary does not sit in the same place twice.
 *
 * Returns `""` rather than a guess when the conversion table does not reach the
 * period — the caller drops the BS half of the label instead of printing a date
 * that is confidently wrong. Same rule as `formatDateBs`.
 */
export function formatPeriodBs(period: string | null | undefined): string {
  return formatBsPeriod(period);
}

/**
 * A period's month with the year left off — `August`, or `Bhadra`.
 *
 * For a row inside a section whose heading already names the year. The Payments
 * list printed `Bhadra 2083 BS` under a heading that said `2083 BS` over a
 * subtitle that said `Aswin 15, 2083 BS`, which is the year three times in one
 * row of a card — and the repetition is what made the two genuinely different
 * dates on that row look like a glitch instead of a billing month and a due
 * date.
 *
 * Never use it where the year is not already on screen: an undated month is a
 * month in some year the reader now has to guess.
 */
export function formatPeriodMonth(period: string | null | undefined): string {
  const parts = periodGregorianParts(period);

  return parts ? MONTHS_LONG[parts.monthIndex] : period?.trim() || "—";
}

/** The same, in Bikram Sambat — `Bhadra`. Read straight off the period key. */
export function formatPeriodMonthBs(period: string | null | undefined): string {
  return formatBsPeriodMonth(period);
}

/** A period's year alone — `2026`. The heading a grouped invoice list sits under. */
export function formatPeriodYear(period: string | null | undefined): string {
  const parts = periodGregorianParts(period);

  return parts ? String(parts.year) : "";
}

/**
 * The same, in Bikram Sambat — `2083 BS`.
 *
 * The two calendars do not share year boundaries: a Gregorian year straddles
 * two BS ones, so a list grouped by `2026` and then *labelled* `2083 BS` would
 * be lying about half its rows. A caller grouping for a BS reader must group by
 * this, not relabel a Gregorian grouping.
 */
export function formatPeriodYearBs(period: string | null | undefined): string {
  return formatBsPeriodYear(period);
}

/** An instant's year in Nepal time — `2026`. */
export function formatYear(value: Date | string | null | undefined): string {
  const date = parseDate(value);

  return date ? String(nepalParts(date).year) : "";
}

/** The same, in Bikram Sambat — `2083 BS`. `""` off the table. */
export function formatYearBs(value: Date | string | null | undefined): string {
  const date = parseDate(value);

  if (!date) {
    return "";
  }

  const { day, month, year } = nepalParts(date);

  try {
    return `${toNepaliDate(year, month, day).format("YYYY")} ${BS_ERA}`;
  } catch {
    return "";
  }
}

/** `16 Aug` — a day inside a section that already names the year. */
export function formatDayMonth(value: Date | string | null | undefined): string {
  const date = parseDate(value);

  if (!date) {
    return "—";
  }

  const { day, month } = nepalParts(date);

  return `${day} ${MONTHS_SHORT[month]}`;
}

/** The same, in Bikram Sambat — `Aswin 15`. Falls back to Gregorian off the table. */
export function formatDayMonthBs(value: Date | string | null | undefined): string {
  const date = parseDate(value);

  if (!date) {
    return "—";
  }

  const { day, month, year } = nepalParts(date);

  try {
    return toNepaliDate(year, month, day).format("MMMM D");
  } catch {
    return formatDayMonth(date);
  }
}

/**
 * Both calendars for a period — `August 2026 · Shrawan 2083 BS`.
 *
 * The month-picker counterpart of `formatDateBoth`, and AD-first for the
 * opposite reason that one is BS-first: this label sits under a strip of
 * Gregorian month chips, so the calendar the reader just tapped leads.
 */
export function formatPeriodBoth(period: string | null | undefined): string {
  const ad = formatPeriod(period);
  const bs = formatPeriodBs(period);

  return bs ? `${ad} · ${bs}` : ad;
}

/**
 * How long ago, in the coarsest unit that is still true — `2 hrs ago`.
 *
 * For a queue of payment claims rather than for a date column. "Today" is the
 * honest answer to *when* a claim arrived and a useless answer to *how long a
 * resident has been waiting for their money*, which is the only reason this
 * queue is sorted the way it is. Hours are the resolution that question is
 * asked at.
 *
 * Falls back to `formatDate` past a week: "23 days ago" is arithmetic the reader
 * has to undo to get to a date, and by then the date is what they want.
 */
export function formatAgo(
  value: Date | string | null | undefined,
  now: Date = new Date(),
): string {
  const date = parseDate(value);

  if (!date) {
    return "—";
  }

  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);

  // A clock skewed a few minutes into the future is common and "in 2 minutes"
  // on a claim that has already been submitted reads as a bug.
  if (seconds < 60) {
    return "just now";
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return minutes === 1 ? "1 min ago" : `${minutes} mins ago`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return hours === 1 ? "1 hr ago" : `${hours} hrs ago`;
  }

  const days = Math.floor(hours / 24);

  if (days <= 7) {
    return days === 1 ? "1 day ago" : `${days} days ago`;
  }

  return formatDate(date);
}

/**
 * Days until a due date, in Nepal days — negative once it is overdue.
 *
 * Compared as whole days rather than as instants, so an invoice due "today"
 * reads as due today all day instead of flipping to overdue at noon.
 */
export function daysUntil(
  value: Date | string | null | undefined,
  now: Date = new Date(),
): number | null {
  const date = parseDate(value);

  if (!date) {
    return null;
  }

  const startOfNepalDay = (input: Date) => {
    const { day, month, year } = nepalParts(input);

    return Date.UTC(year, month, day);
  };

  return Math.round(
    (startOfNepalDay(date) - startOfNepalDay(now)) / 86_400_000,
  );
}

/** `Due in 3 days` / `Due today` / `4 days overdue`. */
export function formatDueLabel(
  value: Date | string | null | undefined,
  now: Date = new Date(),
): string | null {
  const days = daysUntil(value, now);

  if (days === null) {
    return null;
  }

  if (days === 0) {
    return "Due today";
  }

  if (days > 0) {
    return days === 1 ? "Due tomorrow" : `Due in ${days} days`;
  }

  const overdue = Math.abs(days);

  return overdue === 1 ? "1 day overdue" : `${overdue} days overdue`;
}

/**
 * `Good morning` / `Good afternoon` / `Good evening`, on Kathmandu's clock.
 *
 * The device clock is the wrong one to ask: a resident whose phone is still on
 * roaming time gets greeted for the wrong half of the day on a screen that is
 * otherwise entirely about Nepali dates.
 */
export function greetingFor(now: Date = new Date()): string {
  const { hour } = nepalParts(now);

  if (hour < 12) {
    return "Good morning";
  }

  return hour < 17 ? "Good afternoon" : "Good evening";
}

/** `PENDING_PROOF` → `Pending proof`. Server enums are shouted; screens are not. */
export function humanizeEnum(value: string | null | undefined): string {
  if (!value) {
    return "—";
  }

  const words = value
    .trim()
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean);

  if (words.length === 0) {
    return "—";
  }

  return `${words[0].charAt(0).toUpperCase()}${words[0].slice(1)}${
    words.length > 1 ? ` ${words.slice(1).join(" ")}` : ""
  }`;
}
