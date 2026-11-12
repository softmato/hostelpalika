/**
 * Month codes on the phone (todo C1): `RUP-482K-BHA83` → next month's
 * `RUP-482K-ASW83`. Same tags as the server's `reference-code.ts`, pinned by
 * `month-code.test.ts`. Returns null for an old invoice code (`RUP-4821-K`).
 */
export const MONTH_TAGS = ["BAI", "JES", "ASA", "SHR", "BHA", "ASW", "KAR", "MAN", "POU", "MAG", "FAL", "CHA"] as const;

const MONTH_CODE = /^([A-Z]{3}-[0-9A-Z]{4})-([A-Z]{3})(\d{2})$/;

export function nextMonthCode(code: string | null | undefined): string | null {
  const match = code ? MONTH_CODE.exec(code.trim().toUpperCase()) : null;
  const month = match ? MONTH_TAGS.indexOf(match[2] as (typeof MONTH_TAGS)[number]) : -1;

  if (!match || month < 0) return null;

  const year = (Number(match[3]) + (month === 11 ? 1 : 0)) % 100;

  return `${match[1]}-${MONTH_TAGS[(month + 1) % 12]}${String(year).padStart(2, "0")}`;
}
