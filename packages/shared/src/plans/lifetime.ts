/**
 * The lifetime deal's arithmetic, shared by the website, the server and the app.
 *
 * The deal itself is the `lifetime` site-config section — kept apart from the
 * `plans` catalogue so the ordinary tiers never read it. What lives here is
 * what *reads* it: is the window open today, which tier an offer sells, and how
 * many seats are left once the sold ones are counted.
 *
 * Like `catalog.ts` next door, **this file imports nothing**: it is bundled
 * into a phone, and the types are structural so the server's zod-inferred
 * config satisfies them without either side importing the other.
 */

export type LifetimeOfferLike = {
  planId: string;
  /** Whole rupees, paid once. */
  price: number;
  /** How many hostels may buy it. */
  seats: number;
};

export type LifetimeDealLike = {
  enabled: boolean;
  /** Nepal calendar day, `YYYY-MM-DD`, inclusive. Blank means no end. */
  endsOn: string;
  offers: LifetimeOfferLike[];
  /** Nepal calendar day, `YYYY-MM-DD`, inclusive. Blank means from now. */
  startsOn: string;
};

/** `off` — switched off; `upcoming` / `ended` — outside its days; `open` — on sale. */
export type LifetimeWindow = "off" | "upcoming" | "open" | "ended";

/** Nepal is UTC+5:45 all year round. */
const NEPAL_OFFSET_MS = (5 * 60 + 45) * 60_000;

/**
 * Today's date in Nepal, as `YYYY-MM-DD`.
 *
 * The window is a pair of calendar days in Kathmandu, so "ends on the 7th"
 * means the whole of the 7th there — not midnight UTC, which would close it at
 * 5:45 in the morning. Comparing day strings keeps this free of a date library.
 */
export function nepalDay(now: Date = new Date()) {
  return new Date(now.getTime() + NEPAL_OFFSET_MS).toISOString().slice(0, 10);
}

export function lifetimeWindow(deal: LifetimeDealLike, now: Date = new Date()): LifetimeWindow {
  if (!deal.enabled) return "off";

  const today = nepalDay(now);

  if (deal.startsOn && today < deal.startsOn) return "upcoming";
  if (deal.endsOn && today > deal.endsOn) return "ended";

  return "open";
}

/** The offer on this tier, or null when it has none (or no price set). */
export function lifetimeOfferFor(deal: LifetimeDealLike, planId: string) {
  return deal.offers.find((offer) => offer.planId === planId && offer.price > 0) ?? null;
}

/** Seats still for sale on an offer, never below zero. */
export function lifetimeSeatsLeft(offer: Pick<LifetimeOfferLike, "seats">, sold: number) {
  return Math.max(0, offer.seats - Math.max(0, sold));
}

/** Every seat across every priced offer — "the first 50 hostels". */
export function lifetimeTotalSeats(deal: LifetimeDealLike) {
  return deal.offers
    .filter((offer) => offer.price > 0)
    .reduce((total, offer) => total + offer.seats, 0);
}

/**
 * How many months of the monthly price one lifetime payment equals — the
 * honest comparison for a card ("the price of 10 months"). Null when the tier
 * has no monthly price to compare against.
 */
export function lifetimeMonthsEquivalent(price: number, monthly: number) {
  if (!(monthly > 0) || !(price > 0)) return null;

  return Math.round((price / monthly) * 10) / 10;
}

/**
 * The instant the sale closes: the end of `endsOn` in Kathmandu — the same
 * moment {@link lifetimeWindow} turns "ended". `null` for a day it cannot read.
 */
export function lifetimeEndsAt(endsOn: string): number | null {
  const start = Date.parse(`${endsOn}T00:00:00Z`);

  return Number.isNaN(start) ? null : start + 24 * 60 * 60 * 1000 - NEPAL_OFFSET_MS;
}

/** `7 Nov 2026`, from a `YYYY-MM-DD` day, read as the calendar day it names. */
export function formatLifetimeDay(day: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);

  if (!match) return "";

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[Number(match[2]) - 1];

  return month ? `${Number(match[3])} ${month} ${match[1]}` : "";
}
