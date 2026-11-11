/**
 * Resident credit score (todo B, D2–D4). Pure: no I/O, no clock.
 *
 * The score is **derived** from payment events, never stored: a monthly bill
 * earns points once, by the first settled payment on it that the resident made.
 * A rejected claim never settles, and a reversed payment carries
 * `reversedByEventId` — both drop out with no bookkeeping of their own (B2).
 */
import { bsPeriodBounds, hostelDaysBetween } from "@hostel/shared/calendar/bs";

/** D2: day 1–4 = 10, 5–7 = 8, 8–15 = 5, later = 2. */
export function pointsForDay(day: number): number {
  if (day <= 4) return 10;
  if (day <= 7) return 8;
  if (day <= 15) return 5;
  return 2;
}

/** The rule line residents see on their score card. */
export const SCORE_RULES = [
  { days: "1–4", points: 10 },
  { days: "5–7", points: 8 },
  { days: "8–15", points: 5 },
  { days: "16+", points: 2 },
] as const;

/**
 * Payments a resident makes. `ADJUSTMENT` (reversal mirrors, credits) and
 * `OFFER_PROGRAM` (the platform's own fee-off) are not the resident paying.
 */
export const SCORED_SOURCES = [
  "RESIDENT_CLAIM",
  "CASH_ENTRY",
  "GATEWAY_WEBHOOK",
  "GATEWAY_POLL",
  "STATEMENT_IMPORT",
] as const;

export type ScoreEvent = {
  _id: { toString(): string };
  createdAt?: Date | null;
  direction: string;
  invoiceId?: { toString(): string } | null;
  occurredAt?: Date | null;
  reversedByEventId?: unknown;
  settledAt?: Date | null;
  source: string;
  status: string;
};

export type ScoreInvoice = {
  _id: { toString(): string };
  coversFrom?: Date | null;
  kind: string;
  period?: string | null;
};

export type ScoreEntry = {
  day: number;
  eventId: string;
  invoiceId: string;
  paidAt: Date;
  period: string;
  points: number;
  source: string;
};

/**
 * The moment that counts (B1, D3). A claim counts from when the resident sent
 * it, not when the warden got round to approving it; a desk payment from when
 * the warden recorded it; anything else from when the money moved.
 */
export function scoreMoment(event: ScoreEvent): Date | null {
  if (event.source === "RESIDENT_CLAIM") return event.createdAt ?? event.occurredAt ?? null;
  if (event.source === "CASH_ENTRY") return event.settledAt ?? event.occurredAt ?? null;
  return event.occurredAt ?? event.settledAt ?? null;
}

/** Day 1 is the bill's first day; paying before it is day 1 too. */
export function scoreDay(billStart: Date, at: Date): number {
  return Math.max(1, hostelDaysBetween(billStart, at) + 1);
}

function billStart(invoice: ScoreInvoice): Date | null {
  if (invoice.coversFrom) return invoice.coversFrom;
  try {
    return invoice.period ? bsPeriodBounds(invoice.period).start : null;
  } catch {
    return null;
  }
}

function qualifies(event: ScoreEvent): boolean {
  return (
    event.status === "SETTLED" &&
    event.direction === "CREDIT" &&
    !event.reversedByEventId &&
    (SCORED_SOURCES as readonly string[]).includes(event.source)
  );
}

/** One entry per monthly bill (B2), from its earliest qualifying payment. */
export function scoreEntries(invoices: ScoreInvoice[], events: ScoreEvent[]): ScoreEntry[] {
  const byId = new Map(
    invoices.filter((invoice) => invoice.kind === "MONTHLY_RENT").map((invoice) => [invoice._id.toString(), invoice]),
  );
  const best = new Map<string, ScoreEntry>();

  for (const event of events) {
    const invoice = event.invoiceId ? byId.get(event.invoiceId.toString()) : undefined;
    const at = scoreMoment(event);
    const start = invoice ? billStart(invoice) : null;

    if (!invoice || !at || !start || !qualifies(event)) continue;

    const key = invoice._id.toString();
    const current = best.get(key);

    if (current && current.paidAt <= at) continue;

    const day = scoreDay(start, at);

    best.set(key, {
      day,
      eventId: event._id.toString(),
      invoiceId: key,
      paidAt: at,
      period: invoice.period ?? "",
      points: pointsForDay(day),
      source: event.source,
    });
  }

  return [...best.values()].sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime());
}

/** B3: receipts shared = claims sent; approved = claims settled and standing. */
export function claimCounts(events: ScoreEvent[]): { approved: number; shared: number } {
  const claims = events.filter((event) => event.source === "RESIDENT_CLAIM" && event.direction === "CREDIT");

  return {
    approved: claims.filter((event) => event.status === "SETTLED" && !event.reversedByEventId).length,
    shared: claims.length,
  };
}
