import { formatPeriodKey, fromBs } from "@hostel/shared/calendar/bs";

/**
 * Reading one cell the way people write it — rupees, Nepali months and dates,
 * "months due", phones. No spreadsheet library here, so the browser sheet
 * reads a typed or pasted cell exactly as the server reads a file
 * (`existing-residents-file.ts`).
 */

const DEVANAGARI_DIGITS = "०१२३४५६७८९";

/** `१२०००` → `12000`. Leaves every other character alone. */
export function westernDigits(text: string): string {
  return text.replace(/[०-९]/g, (digit) => String(DEVANAGARI_DIGITS.indexOf(digit)));
}

/**
 * Rupees as a whole number, or `undefined` when the cell has something that is
 * not an amount. Empty is `null` — "not given", which each column reads its own
 * way.
 */
export function readRupees(text: string): number | null | undefined {
  const cleaned = westernDigits(text)
    .replace(/rs\.?|npr|रु\.?|रू\.?|,|\s/gi, "")
    .trim();

  if (!cleaned) {
    return null;
  }

  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    return undefined;
  }

  return Math.round(Number(cleaned));
}

/**
 * Every spelling of each BS month we have seen people write, index 0 = Baisakh.
 * Compared after lower-casing and dropping everything that is not a letter.
 */
const MONTH_SPELLINGS: string[][] = [
  ["baisakh", "baishakh", "baisakha", "baishak", "vaisakh", "वैशाख", "बैशाख", "बैसाख"],
  ["jestha", "jeth", "jeshtha", "jyestha", "जेठ", "जेष्ठ", "ज्येष्ठ"],
  ["asar", "asadh", "ashadh", "ashar", "asad", "असार", "आषाढ", "आषाढ़"],
  ["shrawan", "saun", "sawan", "srawan", "shravan", "sharwan", "साउन", "श्रावण"],
  ["bhadra", "bhadau", "bhado", "भदौ", "भाद्र"],
  ["aswin", "asoj", "ashwin", "asoj", "ashoj", "असोज", "आश्विन"],
  ["kartik", "kattik", "kartika", "कात्तिक", "कार्तिक"],
  ["mangsir", "mangshir", "marga", "mansir", "मंसिर", "मङ्सिर", "मार्ग"],
  ["poush", "push", "paush", "pus", "पुस", "पौष", "पुष"],
  ["magh", "माघ"],
  ["falgun", "fagun", "phalgun", "phagun", "फागुन", "फाल्गुन"],
  ["chaitra", "chait", "chaita", "चैत", "चैत्र"],
];

function monthFromWord(word: string): number | null {
  const key = word.toLowerCase().replace(/[^a-zऀ-ॿ]/g, "");

  if (!key) {
    return null;
  }

  const index = MONTH_SPELLINGS.findIndex((spellings) =>
    spellings.some((spelling) => spelling === key),
  );

  return index === -1 ? null : index + 1;
}

function fullYear(text: string): number | null {
  const value = Number(text);

  if (!Number.isInteger(value)) {
    return null;
  }

  // "Bhadra 83" is Bhadra 2083 — nobody in a hostel today means 1983.
  const year = text.length === 2 ? 2000 + value : value;

  return year >= 2070 && year <= 2090 ? year : null;
}

/**
 * A BS month key (`2083-05`) from how a person writes a month, or `undefined`
 * when it cannot be read. Empty is `null`.
 *
 * Takes `Bhadra 2083`, `2083 Bhadra`, `भदौ २०८३`, `2083-05`, `2083/5` and
 * `2083-05-01` — the last because Excel turns a typed `2083-05` into a date and
 * hands it back that way.
 */
export function readBsMonth(text: string): string | null | undefined {
  const cleaned = westernDigits(text).trim();

  if (!cleaned) {
    return null;
  }

  const numeric = /^(\d{4})\s*[-/.]\s*(\d{1,2})(?:\s*[-/.]\s*\d{1,2})?$/.exec(cleaned);

  if (numeric) {
    const year = fullYear(numeric[1]!);
    const month = Number(numeric[2]);

    return year && month >= 1 && month <= 12 ? formatPeriodKey(year, month) : undefined;
  }

  const parts = cleaned.split(/[\s,\-/]+/).filter(Boolean);

  if (parts.length !== 2) {
    return undefined;
  }

  const [first, second] = parts as [string, string];
  const month = monthFromWord(first) ?? monthFromWord(second);
  const year = /^\d+$/.test(first) ? fullYear(first) : fullYear(second);

  return month && year ? formatPeriodKey(year, month) : undefined;
}

/**
 * How many months of rent are not paid, counting this month: `0` means this
 * month is paid. Empty is `null`; anything that is not a whole number is
 * `undefined`.
 */
export function readMonthsDue(text: string): number | null | undefined {
  const cleaned = westernDigits(text).trim().replace(/\.0+$/, "");

  if (!cleaned) {
    return null;
  }

  return /^\d{1,2}$/.test(cleaned) ? Number(cleaned) : undefined;
}

/**
 * A joined date. A year from 2060 is a Nepali date, 2000-2040 an English one —
 * the two calendars are 57 years apart, so there is no year both could mean.
 */
export function readJoinedDate(text: string): Date | null | undefined {
  const cleaned = westernDigits(text).trim();

  if (!cleaned) {
    return null;
  }

  const match = /^(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})/.exec(cleaned);

  if (!match) {
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12 || day < 1 || day > 32) {
    return undefined;
  }

  if (year >= 2060 && year <= 2090) {
    try {
      return fromBs({ day, month, year });
    } catch {
      return undefined;
    }
  }

  if (year >= 2000 && year <= 2040) {
    const date = new Date(Date.UTC(year, month - 1, day));

    return date.getUTCMonth() === month - 1 ? date : undefined;
  }

  return undefined;
}

/**
 * The joined date when none is written: the 1st of the month rent is paid till,
 * or of this month when paid ahead. Never later than the first unpaid month, so
 * no due month is billed short.
 */
export function defaultJoinedDate(paidTill: string, currentPeriod: string): Date {
  const [year, month] = (paidTill < currentPeriod ? paidTill : currentPeriod).split("-").map(Number);

  return fromBs({ day: 1, month: month!, year: year! });
}

/** Digits, with a leading `+` kept. Excel sometimes appends `.0` to a number. */
export function readPhone(text: string): string {
  const cleaned = westernDigits(text).trim().replace(/\.0+$/, "");
  const plus = cleaned.startsWith("+") ? "+" : "";

  return plus + cleaned.replace(/\D/g, "");
}
