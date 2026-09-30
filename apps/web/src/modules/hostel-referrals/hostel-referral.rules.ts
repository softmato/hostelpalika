import { bsMonthsEnd } from "@hostel/shared/calendar/bs";

export type PlanBonus = { days: number; months: number };

const DAY_MS = 24 * 60 * 60 * 1000;

/** A plan end pushed out by a bonus: whole BS months first, then days. */
export function extendByBonus(end: Date, bonus: PlanBonus): Date {
  const afterMonths =
    bonus.months > 0 ? bsMonthsEnd(new Date(end.getTime() + 1), bonus.months) : end;

  return new Date(afterMonths.getTime() + bonus.days * DAY_MS);
}

export function hasBonus(bonus: PlanBonus | null | undefined): bonus is PlanBonus {
  return Boolean(bonus && (bonus.months > 0 || bonus.days > 0));
}

/** "1 month and 10 days", "15 days", "" for nothing. */
export function describeBonus(bonus: PlanBonus | null | undefined): string {
  if (!hasBonus(bonus)) {
    return "";
  }

  const parts = [
    bonus.months > 0 ? `${bonus.months} ${bonus.months === 1 ? "month" : "months"}` : "",
    bonus.days > 0 ? `${bonus.days} ${bonus.days === 1 ? "day" : "days"}` : "",
  ].filter(Boolean);

  return parts.join(" and ");
}

/**
 * A partner's commission for one hostel that went live. A percent is of the
 * plan price the hostel signed up for (one billing cycle), rounded to rupees.
 */
export function commissionFor(
  terms: { type: "AMOUNT" | "PERCENT"; value: number },
  cycleTotal: number | null | undefined,
): number {
  if (terms.type === "AMOUNT") {
    return Math.max(0, Math.round(terms.value));
  }

  return Math.max(0, Math.round(((cycleTotal ?? 0) * terms.value) / 100));
}

export function normalizeHostelReferralCode(raw: string): string {
  return raw.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

/**
 * A hostel's code: four letters of its name, then the tail of its id. The tail
 * grows only when a shorter one is already taken.
 */
export function hostelCodeCandidates(name: string, hostelId: string): string[] {
  const letters = normalizeHostelReferralCode(name).replace(/[0-9]/g, "").slice(0, 4) || "HP";
  const id = hostelId.toUpperCase();

  return [5, 7, 10, 24].map((length) => `${letters}${id.slice(-length)}`);
}
