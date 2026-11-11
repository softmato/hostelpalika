/**
 * The reference code — `RUP-4821-K` (target §5, ADR-7).
 *
 * Principle P2: a payment is matched to its invoice because the payment
 * *carries* the invoice's code, not because software inspected it afterwards and
 * guessed. Everything downstream — statement matching, auto-settlement, the
 * whole Tier 0.5 reconciliation screen — rests on this being reliable when a
 * resident types it into a bank remarks field on a phone.
 *
 * Which is why the last character is a check character. A typo is detectable
 * **without a database lookup**, so parsing a statement of 84 free-text remarks
 * costs zero queries and a mistyped code is rejected rather than silently
 * matched to somebody else's invoice.
 *
 * Pure module: no I/O, no database, no clock. Generator, parser and validator
 * live together so they cannot drift apart.
 */

/**
 * 31 symbols, not 32 — **a deliberate deviation from literal Crockford base32,
 * and the reason the check character works.**
 *
 * Crockford's set is the digits plus 22 letters (no I, L, O or U: the first
 * three are indistinguishable from 1 and 0 in many fonts, and U makes accidental
 * obscenities more likely in a code read aloud over the phone). That is 32
 * symbols, and 32 is a power of two — so a weighted checksum modulo 32 cannot
 * detect every single-character error, because a digit change of 16 at an
 * even-weighted position cancels exactly. Dropping `Z` gives **31, which is
 * prime**, and a prime modulus with consecutive weights catches *every* single
 * -character substitution and *every* adjacent transposition. Those are the two
 * mistakes people actually make copying a code, and item 1.5 requires both.
 *
 * Cost: 31⁴ = 923,521 codes per hostel instead of 1,048,576 — still the "~1M
 * values per hostel" of target §5.1.
 */
import { BS_MONTHS, formatPeriodKey, periodParts } from "@hostel/shared/calendar/bs";

const SYMBOLS = "0123456789ABCDEFGHJKMNPQRSTVWXY";
const MODULUS = SYMBOLS.length; // 31, prime

/**
 * The prefix is a **human mnemonic, not base-31 data**, so it uses all 26
 * letters — target §5.1's own example is `RUP`, and `U` is not a Crockford
 * symbol. Its letters are still folded into the checksum, by their alphabet
 * position (0–25, comfortably under the modulus), so a typo in the hostel part
 * is caught exactly like a typo in the sequence.
 *
 * The practical consequence: `LIO` is a legal prefix. Confusable folding applies
 * only to the sequence, where the characters carry numeric value — applying it
 * to the prefix would rewrite "Lion Hostel" to `110` and the code would never
 * parse.
 */
const PREFIX_PATTERN = /^[A-Z]{3}$/;

/** Crockford's canonical input mappings, for the sequence only: I/L → 1, O → 0. */
const CONFUSABLES: Record<string, string> = { I: "1", L: "1", O: "0" };

const SEQ_LENGTH = 4;
const PREFIX_LENGTH = 3;
const CODE_LENGTH = PREFIX_LENGTH + SEQ_LENGTH + 1;

/** 31⁴ − 1 codes per hostel before the sequence wraps. */
export const MAX_SEQUENCE = MODULUS ** SEQ_LENGTH - 1;

/*
 * The month code — `RUP-482K-BHA83` (todo A1/A2, D1).
 *
 * A resident keeps one personal code for life (`RUP-482K`: hostel prefix, a
 * three-symbol resident number, a check character) and each monthly rent bill
 * appends the BS month's first three letters and the year's last two digits.
 * Same resident next month → same code, new month part, so it can be guessed.
 *
 * The check character covers prefix + number only, which is what keeps the
 * personal part fixed. It still catches every one-symbol typo and adjacent swap
 * inside the personal part (prime modulus, consecutive weights — see
 * `checkCharacter`), so a typo can never land on another resident. A month typo
 * is not a month (`BHX`) and fails to parse.
 */
const PERSONAL_SEQ_LENGTH = 3;
const PERSONAL_LENGTH = PREFIX_LENGTH + PERSONAL_SEQ_LENGTH + 1;
const MONTH_CODE_LENGTH = PERSONAL_LENGTH + 3 + 2;

/** 29,790 residents per hostel. */
export const MAX_PERSONAL_NUMBER = MODULUS ** PERSONAL_SEQ_LENGTH - 1;

/** `BAI JES ASA SHR BHA ASW KAR MAN POU MAG FAL CHA` — all distinct. */
const MONTH_TAGS = BS_MONTHS.map((month) => month.slice(0, 3).toUpperCase());

export type ParsedReferenceCode = {
  prefix: string;
  sequence: number;
};

/**
 * Strips formatting and normalises the characters a human is likely to get
 * wrong. Case-insensitive, hyphen-insensitive and space-insensitive, so
 * `rup 4821 k`, `RUP-4821-K` and `rup4821k` are the same code (target §5.2).
 */
function canonicalize(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Applied to the sequence and check only — see PREFIX_PATTERN. */
function foldConfusables(raw: string): string {
  return raw
    .split("")
    .map((character) => CONFUSABLES[character] ?? character)
    .join("");
}

function symbolValue(character: string): number {
  return SYMBOLS.indexOf(character);
}

/** A prefix letter's checksum value: its position in the alphabet, 0–25. */
function letterValue(character: string): number {
  const value = character.charCodeAt(0) - 65;

  return value >= 0 && value <= 25 ? value : -1;
}

function encodeSequence(sequence: number, length = SEQ_LENGTH): string {
  let remaining = sequence;
  let encoded = "";

  for (let position = 0; position < length; position += 1) {
    encoded = SYMBOLS[remaining % MODULUS] + encoded;
    remaining = Math.floor(remaining / MODULUS);
  }

  return encoded;
}

function decodeSequence(encoded: string): number | null {
  let value = 0;

  for (const character of encoded) {
    const digit = symbolValue(character);

    if (digit < 0) {
      return null;
    }

    value = value * MODULUS + digit;
  }

  return value;
}

/**
 * Weighted checksum over the prefix and sequence, modulo 31.
 *
 * Weights are consecutive (1, 2, 3…) and the modulus is prime, which is what
 * gives the two guarantees:
 *
 * - **Substitution:** changing one symbol by `d` shifts the total by `d × w`.
 *   With a prime modulus and `0 < |d| < 31`, that is never zero, so every
 *   single-character typo changes the check character.
 * - **Transposition:** swapping neighbours shifts the total by `(a − b) × 1`,
 *   also never zero unless the two symbols were identical — in which case the
 *   swap did nothing.
 *
 * Returns null for input outside the alphabet, so a caller cannot mint a code
 * whose own check character fails to validate.
 */
function checkCharacter(prefix: string, encoded: string): string | null {
  let total = 0;
  let weight = 1;

  for (const letter of prefix) {
    const value = letterValue(letter);

    if (value < 0) {
      return null;
    }

    total += value * weight;
    weight += 1;
  }

  for (const character of encoded) {
    const value = symbolValue(character);

    if (value < 0) {
      return null;
    }

    total += value * weight;
    weight += 1;
  }

  return SYMBOLS[total % MODULUS]!;
}

/**
 * A hostel's 3-letter prefix, derived from its name.
 *
 * Letters outside the code alphabet are dropped rather than substituted: a
 * hostel named "Lion Hostel" cannot use `LIO`, because canonicalisation would
 * rewrite it to `110` on the way back in and the code would never parse.
 *
 * Assignment must be collision-safe platform-wide, which this cannot guarantee
 * on its own — the caller checks the candidate against existing prefixes and
 * asks for the next attempt. The sequence is deterministic, so re-running the
 * backfill gives every hostel the same prefix it had.
 */
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function deriveHostelPrefix(hostelName: string, attempt = 0): string {
  const letters = hostelName.toUpperCase().replace(/[^A-Z]/g, "");
  const base = (letters.slice(0, PREFIX_LENGTH) || "HST").padEnd(PREFIX_LENGTH, "X");

  if (attempt === 0) {
    return base;
  }

  // Disambiguate on the last character: RUP → RUA → RUB … Two characters of the
  // name plus a varying third stays readable and gives 26 alternatives per stem.
  const replacement = LETTERS[(attempt - 1) % LETTERS.length]!;

  return `${base.slice(0, PREFIX_LENGTH - 1)}${replacement}`;
}

export function isValidPrefix(prefix: string): boolean {
  return PREFIX_PATTERN.test(prefix);
}

/**
 * Builds the code for an invoice. Generated once, at issue, and never changes
 * (target §5.2) — the resident may have written it on a bank transfer that has
 * not arrived yet.
 */
export function generateReferenceCode(prefix: string, sequence: number): string {
  if (!isValidPrefix(prefix)) {
    throw new Error(`Reference prefix must be three letters, received "${prefix}".`);
  }

  if (!Number.isInteger(sequence) || sequence < 0 || sequence > MAX_SEQUENCE) {
    throw new Error(
      `Reference sequence must be 0…${MAX_SEQUENCE}, received ${sequence}.`,
    );
  }

  const encoded = encodeSequence(sequence);
  const check = checkCharacter(prefix, encoded);

  if (!check) {
    throw new Error(`Reference prefix "${prefix}" is outside the code alphabet.`);
  }

  return `${prefix}-${encoded}-${check}`;
}

/**
 * Validates a code by its check character alone — no database, no network.
 *
 * Nothing in the matching ladder may treat a code as matched without this
 * returning true (ADR-7). A code that passes here still has to belong to the
 * right hostel and invoice; this only establishes that it was not mistyped.
 */
export function isValidReferenceCode(raw: string | null | undefined): boolean {
  return normalizeReferenceCode(raw) !== null;
}

/**
 * The printed form of any code a resident might type — an invoice code
 * (`RUP-4821-K`) or a month code (`RUP-482K-BHA83`) — or null. This is what
 * `invoice.referenceCode` is compared against.
 */
export function normalizeReferenceCode(raw: string | null | undefined): string | null {
  const old = parseReferenceCode(raw);

  if (old) {
    return formatReferenceCode(old.prefix, old.sequence);
  }

  const month = parseMonthCode(raw);

  return month ? `${month.personalCode}-${month.tag}` : null;
}

/** `RUP-482K` — a resident's fixed code. */
export function generatePersonalCode(prefix: string, residentNumber: number): string {
  if (!isValidPrefix(prefix)) {
    throw new Error(`Reference prefix must be three letters, received "${prefix}".`);
  }

  if (
    !Number.isInteger(residentNumber) ||
    residentNumber < 0 ||
    residentNumber > MAX_PERSONAL_NUMBER
  ) {
    throw new Error(
      `Resident number must be 0…${MAX_PERSONAL_NUMBER}, received ${residentNumber}.`,
    );
  }

  const encoded = encodeSequence(residentNumber, PERSONAL_SEQ_LENGTH);

  return `${prefix}-${encoded}${checkCharacter(prefix, encoded)!}`;
}

/** `RUP-482K` + `2083-05` → `RUP-482K-BHA83`. */
export function generateMonthCode(personalCode: string, period: string): string {
  const parts = periodParts(period);
  const personal = parsePersonal(canonicalize(personalCode));

  if (!parts || !personal) {
    throw new Error(`Cannot make a month code from "${personalCode}" and "${period}".`);
  }

  const yy = String(parts.year % 100).padStart(2, "0");

  return `${personal}-${MONTH_TAGS[parts.month - 1]}${yy}`;
}

/** Canonical `RUP482K` → printed `RUP-482K`, or null when the check fails. */
function parsePersonal(canonical: string): string | null {
  if (canonical.length !== PERSONAL_LENGTH) {
    return null;
  }

  const prefix = canonical.slice(0, PREFIX_LENGTH);
  const encoded = foldConfusables(canonical.slice(PREFIX_LENGTH, PERSONAL_LENGTH - 1));
  const check = foldConfusables(canonical.slice(PERSONAL_LENGTH - 1));

  if (!isValidPrefix(prefix) || checkCharacter(prefix, encoded) !== check) {
    return null;
  }

  return `${prefix}-${encoded}${check}`;
}

export type ParsedMonthCode = {
  personalCode: string;
  period: string;
  /** `BHA83` */
  tag: string;
};

export function parseMonthCode(raw: string | null | undefined): ParsedMonthCode | null {
  if (!raw) {
    return null;
  }

  const canonical = canonicalize(raw);

  if (canonical.length !== MONTH_CODE_LENGTH) {
    return null;
  }

  const personalCode = parsePersonal(canonical.slice(0, PERSONAL_LENGTH));
  const month = MONTH_TAGS.indexOf(canonical.slice(PERSONAL_LENGTH, PERSONAL_LENGTH + 3));
  const yy = foldConfusables(canonical.slice(PERSONAL_LENGTH + 3));

  if (!personalCode || month < 0 || !/^\d\d$/.test(yy)) {
    return null;
  }

  return {
    personalCode,
    period: formatPeriodKey(2000 + Number(yy), month + 1),
    tag: `${MONTH_TAGS[month]}${yy}`,
  };
}

export function parseReferenceCode(
  raw: string | null | undefined,
): ParsedReferenceCode | null {
  if (!raw) {
    return null;
  }

  const canonical = canonicalize(raw);

  if (canonical.length !== CODE_LENGTH) {
    return null;
  }

  const prefix = canonical.slice(0, PREFIX_LENGTH);
  // Confusable folding applies from here on: these characters carry value.
  const encoded = foldConfusables(
    canonical.slice(PREFIX_LENGTH, PREFIX_LENGTH + SEQ_LENGTH),
  );
  const check = foldConfusables(canonical.slice(-1));

  if (!isValidPrefix(prefix)) {
    return null;
  }

  if (checkCharacter(prefix, encoded) !== check) {
    return null;
  }

  const sequence = decodeSequence(encoded);

  return sequence === null ? null : { prefix, sequence };
}

/**
 * Pulls every valid code out of free text — a statement remark, a notification
 * body, a resident's message.
 *
 * **Tokenised, not windowed.** An earlier version slid an 8-character window
 * across the whole remark and kept anything that validated. That is wrong by
 * roughly 1-in-31: `"AUGUST RENT PAYMENT THANK YOU"` contains `STRENTPA`, which
 * passes the check character and is not a reference code. A false positive here
 * auto-settles one resident's payment against another's invoice, which is worse
 * than any number of missed matches — a missed match falls to the owner's
 * review queue, where it is meant to land anyway (target §5.3).
 *
 * So a code must be a token in its own right. Hyphens and spaces inside a token
 * are formatting and are stripped; anything else ends the token.
 */
export function extractReferenceCodes(text: string | null | undefined): string[] {
  if (!text) {
    return [];
  }

  const found = new Set<string>();

  // Split on everything that is not part of a code or its formatting. Spaces
  // are handled below rather than here, so "RUP 4821 K" survives as one run.
  for (const run of text.toUpperCase().split(/[^A-Z0-9\s_-]+/)) {
    for (const candidate of candidatesInRun(run)) {
      const code = normalizeReferenceCode(candidate);

      if (code) {
        found.add(code);
      }
    }
  }

  return [...found];
}

/**
 * Every plausible whole-token reading of a run of text: each space-separated
 * token, plus adjacent tokens joined, so both `RUP-4821-K` and the spaced
 * `RUP 4821 K` are seen — but `RENT PAYMENT THANK` never becomes a code.
 */
function candidatesInRun(run: string): string[] {
  const tokens = run.split(/[\s_]+/).filter(Boolean);
  const candidates: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const single = canonicalize(tokens[index]!);

    if (single.length === CODE_LENGTH || single.length === MONTH_CODE_LENGTH) {
      candidates.push(single);
    }

    // Join neighbours: an invoice code spaced out is three pieces, a month code
    // up to four (`RUP 482K BHA 83`). Anything longer is prose, not a reference.
    let joined = single;

    for (let span = 1; span < 4 && index + span < tokens.length; span += 1) {
      joined += canonicalize(tokens[index + span]!);

      if (
        (joined.length === CODE_LENGTH && span < 3) ||
        joined.length === MONTH_CODE_LENGTH
      ) {
        candidates.push(joined);
      }

      if (joined.length > MONTH_CODE_LENGTH) {
        break;
      }
    }
  }

  return candidates;
}

/** `RUP-4821-K` — the display form, hyphenated for readability. */
export function formatReferenceCode(prefix: string, sequence: number): string {
  return generateReferenceCode(prefix, sequence);
}
