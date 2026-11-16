import { bsDaysInMonth, BS_YEAR_MIN, fromBs, toBs } from "@hostel/calendar/bs";

/**
 * A date of birth as the person gave it, in AD or BS. `dateOfBirth` is always
 * stored in AD (age, ID card and scans read it); the calendar and the date as
 * typed are stored beside it, so the original is never lost (owner, 2026-11-16).
 */
export type BirthCalendar = "AD" | "BS";

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (value: number) => String(value).padStart(2, "0");

export function isoOf(year: number, month: number, day: number) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function partsOf(iso: string): { day: number; month: number; year: number } | null {
  const match = ISO.exec(iso.trim());

  return match ? { day: Number(match[3]), month: Number(match[2]), year: Number(match[1]) } : null;
}

/** `2001-07-27` (AD) → `2058-04-12` (BS); null when it cannot be converted. */
export function adToBs(iso: string): string | null {
  const parts = partsOf(iso);
  if (!parts) return null;

  try {
    const bs = toBs(new Date(Date.UTC(parts.year, parts.month - 1, parts.day)));
    return isoOf(bs.year, bs.month, bs.day);
  } catch {
    return null;
  }
}

/** `2058-04-12` (BS) → `2001-07-27` (AD); null when it is not a real BS day. */
export function bsToAd(iso: string): string | null {
  const parts = partsOf(iso);
  if (!parts || parts.year < BS_YEAR_MIN || parts.month < 1 || parts.month > 12) return null;

  try {
    if (parts.day < 1 || parts.day > bsDaysInMonth(parts.year, parts.month)) return null;
    return fromBs(parts).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

/** Days in a month of either calendar. */
export function daysIn(calendar: BirthCalendar, year: number, month: number) {
  if (calendar === "AD") return new Date(Date.UTC(year, month, 0)).getUTCDate();

  try {
    return bsDaysInMonth(year, month);
  } catch {
    return 30;
  }
}
