/**
 * Reading what someone typed on Add expense — shared by the app and the web
 * page, so a Nepali date or an amount means the same thing on both.
 *
 * Every date in Money Out is Bikram Sambat on screen, and a Gregorian calendar
 * day (`2026-10-01`) on the wire. These are the conversions between the two.
 */
import { bsDaysInMonth, fromBs, hostelToday, toBs } from "../calendar/bs";

/** `2026-10-01` from a UTC-midnight day. */
export function dayKey(day: Date): string {
  return day.toISOString().slice(0, 10);
}

/** A key back to its day, or `null` for one that does not exist (`2026-02-30`). */
export function dayFromKey(key: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;

  const day = new Date(`${key}T00:00:00.000Z`);

  return Number.isNaN(day.getTime()) || dayKey(day) !== key ? null : day;
}

/** Today in Nepal, as the key the API takes. */
export function todayKey(now: Date = new Date()): string {
  return dayKey(hostelToday(now));
}

/** `2083-06-15` for the BS day a key falls on — the typed field's format. */
export function toBsDayInput(key: string): string {
  const day = dayFromKey(key);

  if (!day) return "";

  const bs = toBs(day);

  return `${bs.year}-${String(bs.month).padStart(2, "0")}-${String(bs.day).padStart(2, "0")}`;
}

/**
 * A BS date someone typed (`2083-06-15`, or `2083/6/15`) as the Gregorian key
 * the API takes. `null` for anything that is not a real BS day — the 32nd of a
 * 31-day month included, rather than rolling it into the next month.
 */
export function parseBsDayInput(value: string): string | null {
  const match = /^\s*(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*$/.exec(value);

  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12 || day < 1) return null;

  try {
    if (day > bsDaysInMonth(year, month)) return null;

    return dayKey(fromBs({ day, month, year }));
  } catch {
    return null;
  }
}

/**
 * What someone typed into the amount field, as whole rupees — or `null`.
 *
 * Commas and spaces are forgiven (`2,400`); anything with a decimal point is
 * not, because there are no paisa in this product (ADR-1) and silently rounding
 * `2400.5` would record an amount nobody entered.
 */
export function parseAmountInput(value: string): number | null {
  const cleaned = value.replace(/[,\s]/g, "").replace(/^(rs\.?|npr)/i, "");

  if (!/^\d+$/.test(cleaned)) return null;

  const amount = Number(cleaned);

  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}
