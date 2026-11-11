import { randomBytes } from "node:crypto";

import {
  BS_ERA,
  bsMonthName,
  bsPeriodBounds,
  bsPeriodOf,
  formatPeriodKey,
  periodParts,
} from "@hostel/shared/calendar/bs";

/**
 * The Resident Offer Program's rules, pure — no database, so each one is
 * testable on its own. The service and the receipt path both read from here.
 */

/* -------------------------------------------------------------------------- */
/* Quarters                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `2083-Q2` — three Bikram Sambat months. Q1 Baisakh–Asar, Q2 Shrawan–Aswin,
 * Q3 Kartik–Poush, Q4 Magh–Chaitra: the months every hostel already keeps its
 * books in, cut into four.
 */
const QUARTER_KEY = /^(\d{4})-Q([1-4])$/;

export function isOfferQuarter(value: string | null | undefined): value is string {
  return QUARTER_KEY.test(value ?? "");
}

export function offerQuarterOf(instant: Date): string {
  const parts = periodParts(bsPeriodOf(instant))!;

  return `${parts.year}-Q${Math.ceil(parts.month / 3)}`;
}

export function shiftOfferQuarter(quarter: string, delta: number): string {
  const [, year, q] = QUARTER_KEY.exec(quarter)!;
  const index = Number(year) * 4 + (Number(q) - 1) + delta;

  return `${Math.floor(index / 4)}-Q${(index % 4) + 1}`;
}

export type OfferQuarter = {
  from: Date;
  key: string;
  /** `Shrawan – Aswin 2083 BS` */
  label: string;
  to: Date;
};

export function offerQuarterBounds(quarter: string): OfferQuarter {
  const [, yearText, q] = QUARTER_KEY.exec(quarter)!;
  const year = Number(yearText);
  const firstMonth = (Number(q) - 1) * 3 + 1;

  return {
    from: bsPeriodBounds(formatPeriodKey(year, firstMonth)).start,
    key: quarter,
    label: `${bsMonthName(firstMonth)} – ${bsMonthName(firstMonth + 2)} ${year} ${BS_ERA}`,
    to: bsPeriodBounds(formatPeriodKey(year, firstMonth + 2)).end,
  };
}

/* -------------------------------------------------------------------------- */
/* Certification                                                              */
/* -------------------------------------------------------------------------- */

type SettledEvent = {
  confirmation: string;
  invoiceId?: unknown;
  rawPayload?: { referenceNote?: string | null; transactionCode?: string | null } | null;
  /** The invoice's own code, copied onto the event when it was recorded. */
  referenceCode?: string | null;
  source?: string;
};

/**
 * Does this settled payment earn a certified receipt?
 *
 * Owner rule (todo D3, B6): any payment the resident makes that somebody other
 * than the payer verified is certified.
 *
 * - A resident's claim: it only settles once a warden or admin approved it.
 * - A desk payment (cash, or online at the desk): a warden or admin recorded it
 *   against the months they ticked, so it needs no typed code.
 * - A gateway payment: started from the invoice's own checkout, confirmed by the
 *   provider's API.
 * - A statement row: matched to the invoice by the code in the bank's remarks.
 *
 * Adjustments and HostelPalika's own fee-off (`OFFER_PROGRAM`) are not the
 * resident paying, so they are receipted but never certified.
 */
export function qualifiesForOfferProgram(event: SettledEvent): boolean {
  if (!event.invoiceId) {
    return false;
  }

  switch (event.source) {
    case "RESIDENT_CLAIM":
    case "CASH_ENTRY":
      return true;
    case "GATEWAY_POLL":
    case "GATEWAY_WEBHOOK":
      return Boolean(event.referenceCode) && event.confirmation === "GATEWAY_VERIFIED";
    case "STATEMENT_IMPORT":
      return Boolean(event.referenceCode) && event.confirmation === "STATEMENT_MATCH";
    default:
      return false;
  }
}

/** Crockford base32: no I, L, O or U to misread off a printout. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * `HP-7K2M-9QXD-4TRA` — 60 random bits. The receipt number is sequential and
 * guessable; this is not, so a forged receipt cannot carry a code that checks.
 */
export function newCertificationCode(): string {
  // 256 is a multiple of 32, so `byte & 31` is uniform.
  const chars = Array.from(randomBytes(12), (byte) => CODE_ALPHABET[byte & 31]);

  return `HP-${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8).join("")}`;
}

/**
 * What somebody typed into the verify box, as a stored code — or null.
 * Forgiving about case, spaces and dashes; strict about everything else.
 */
export function normalizeCertificationCode(input: string | null | undefined): string | null {
  const compact = (input ?? "").toUpperCase().replace(/[\s-]/g, "");
  const match = /^HP([0-9A-HJKMNP-TV-Z]{12})$/.exec(compact);

  if (!match) {
    return null;
  }

  const body = match[1];

  return `HP-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8)}`;
}

/* -------------------------------------------------------------------------- */
/* Fee off                                                                    */
/* -------------------------------------------------------------------------- */

/** Whole rupees HostelPalika pays against a monthly invoice for a `percentOff` award. */
export function feeOffAmount(invoiceTotal: number, percentOff: number): number {
  return Math.round((invoiceTotal * percentOff) / 100);
}

/** Masks a name for a stranger holding the receipt: `Sita Sharma` → `Sita S.` */
export function maskedName(fullName: string): string {
  const [first, ...rest] = fullName.trim().split(/\s+/);
  const last = rest.at(-1);

  return last ? `${first} ${last[0]}.` : (first ?? "");
}
