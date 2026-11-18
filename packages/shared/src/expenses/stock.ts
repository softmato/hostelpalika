/**
 * Kitchen and store stock — the words both sides share (docs/INVENTORY_PLAN.md).
 *
 * Lives beside the expense categories because a Bought *is* Money Out, and
 * because this directory is already aliased into Metro (`@hostel/expenses/*`):
 * a new alias would change the app's native fingerprint for a list of units.
 *
 * Imports nothing, like its neighbour.
 */

/** Long use (counted, keeps a Left) or daily (used the day it comes). */
export const STOCK_KINDS = ["STORE", "DAILY"] as const;

export type StockKind = (typeof STOCK_KINDS)[number];

export const STOCK_KIND_LABELS: Record<StockKind, string> = {
  DAILY: "Daily",
  STORE: "Store",
};

/** Tile order: what a hostel buys most first. */
export const STOCK_UNITS = [
  "KG",
  "LITRE",
  "SACK",
  "PACKET",
  "PIECE",
  "DOZEN",
  "BOTTLE",
  "TIN",
  "CYLINDER",
] as const;

export type StockUnit = (typeof STOCK_UNITS)[number];

/** As printed after a number: `25 kg`, `2 sacks`. */
export const STOCK_UNIT_LABELS: Record<StockUnit, { one: string; many: string }> = {
  BOTTLE: { many: "bottles", one: "bottle" },
  CYLINDER: { many: "cylinders", one: "cylinder" },
  DOZEN: { many: "dozen", one: "dozen" },
  KG: { many: "kg", one: "kg" },
  LITRE: { many: "L", one: "L" },
  PACKET: { many: "packets", one: "packet" },
  PIECE: { many: "pcs", one: "pc" },
  SACK: { many: "sacks", one: "sack" },
  TIN: { many: "tins", one: "tin" },
};

/**
 * Every change to stock is one of these movements, and the stock is their sum.
 *
 * - In: **BUY** (a bill), **OPENING** (what was already on the shelf on day one)
 * - Out: **USE** (kitchen, staff, a student), **WASTE** (spoiled, damaged, expired)
 * - Move: **SEND** (to another building of the group)
 * - Correct: **COUNT** (a physical count; the gap from the book is the adjustment)
 */
export const STOCK_ENTRY_KINDS = ["BUY", "OPENING", "USE", "WASTE", "SEND", "COUNT"] as const;

export type StockEntryKind = (typeof STOCK_ENTRY_KINDS)[number];

export const STOCK_ENTRY_LABELS: Record<StockEntryKind, string> = {
  BUY: "Bought",
  COUNT: "Stock check",
  OPENING: "Opening stock",
  SEND: "Send",
  USE: "Used",
  WASTE: "Wasted",
};

/**
 * `DONE` for most; a Send is `PENDING` until the other side taps Got it, and a
 * warden's Count is `PENDING` until the owner (or a warden allowed to) approves it.
 */
export type StockEntryStatus = "CANCELLED" | "DONE" | "PENDING" | "RECEIVED";

/** Who or what a Use was for. */
export const STOCK_USE_FOR = ["KITCHEN", "STAFF", "RESIDENT", "OTHER"] as const;

export type StockUseFor = (typeof STOCK_USE_FOR)[number];

export const STOCK_USE_FOR_LABELS: Record<StockUseFor, string> = {
  KITCHEN: "Kitchen",
  OTHER: "Other",
  RESIDENT: "Student",
  STAFF: "Staff",
};

/** Why it was thrown away. */
export const STOCK_WASTE_REASONS = ["SPOILED", "EXPIRED", "DAMAGED", "OTHER"] as const;

export type StockWasteReason = (typeof STOCK_WASTE_REASONS)[number];

export const STOCK_WASTE_LABELS: Record<StockWasteReason, string> = {
  DAMAGED: "Damaged",
  EXPIRED: "Expired",
  OTHER: "Other",
  SPOILED: "Spoiled",
};

/**
 * Used the day it comes, read from the name: green vegetables, meat, fish, milk,
 * fruit, bread. Everything else is kept in the store. Adding stock never asks
 * which — the person standing with the sack should only have to say what it is.
 */
const DAILY_WORDS =
  /veg|tarkari|sabji|saag|spinach|cauli|cabbage|bandagobi|carrot|gajar|radish|mula|tomato|golbheda|chilli|chili|khursani|chicken|kukhura|fish|machha|meat|masu|mutton|khasi|buff|pork|milk|dudh|curd|dahi|paneer|fruit|banana|apple|orange|suntala|bread|pauroti/i;

export function guessStockKind(name: string): StockKind {
  return DAILY_WORDS.test(name) ? "DAILY" : "STORE";
}

/** A bill is paid, part paid or not paid — read from its total and what was paid on it. */
export type StockBillStatus = "DUE" | "PAID" | "PARTIAL";

export const STOCK_BILL_STATUS_LABELS: Record<StockBillStatus, string> = {
  DUE: "Not paid",
  PAID: "Paid",
  PARTIAL: "Part paid",
};

export function billStatus(total: number, paid: number): StockBillStatus {
  if (paid >= total) return "PAID";

  return paid > 0 ? "PARTIAL" : "DUE";
}

/**
 * What each line of a bill cost, when the bill total is known but not every
 * item's price.
 *
 * Typed prices stay as typed. What the bill total leaves over is shared by the
 * lines with no price, in proportion to `weight` (quantity × the item's usual
 * cost); when any of them has no usual cost yet, equally. Whole rupees, and the
 * shares always add up to exactly what was left over. A line with no price gets
 * `null` when there is no total, or nothing is left over for it.
 *
 * ponytail: a new item with no usual cost gets an equal share — an estimate the
 * Buy screen shows before Save; typing that item's price makes it exact.
 */
export function splitBill(total: number | null, lines: readonly { amount: number | null; weight: number | null }[]) {
  const amounts = lines.map((line) => line.amount);
  const open = lines.flatMap((line, index) => (line.amount === null ? [index] : []));
  const left = total === null ? 0 : total - lines.reduce((sum, line) => sum + (line.amount ?? 0), 0);

  if (open.length === 0 || left <= 0) return amounts;

  const weighted = open.every((index) => (lines[index]!.weight ?? 0) > 0);
  const weights = open.map((index) => (weighted ? lines[index]!.weight! : 1));
  const sum = weights.reduce((total, weight) => total + weight, 0);
  const exact = weights.map((weight) => (left * weight) / sum);
  const shares = exact.map(Math.floor);
  // Largest remainder: the rupees lost to rounding go to the lines that lost most.
  const order = exact.map((value, index) => ({ index, rest: value - shares[index]! })).sort((a, b) => b.rest - a.rest);

  const lost = left - shares.reduce((total, share) => total + share, 0);

  for (let index = 0; index < lost; index += 1) shares[order[index]!.index]! += 1;

  open.forEach((line, index) => {
    amounts[line] = shares[index]!;
  });

  return amounts;
}

export const STOCK_SUPPLIER_NAME_MAX = 60;
export const STOCK_SUPPLIER_LIMIT = 200;

export const STOCK_ITEM_NAME_MAX = 40;
/** A group may keep this many items. */
export const STOCK_ITEM_LIMIT = 200;
/** One entry carries at most this many lines. */
export const STOCK_LINES_MAX = 60;
/** Largest quantity on one line, in the item's own unit. */
export const STOCK_QTY_MAX = 100_000;

/** Two decimals: half a kilo is real, a thousandth is a typo. */
export function roundQty(value: number) {
  return Math.round(value * 100) / 100;
}

/** `25 kg`, `1 sack`, `2.5 L`. */
export function formatQty(qty: number, unit: StockUnit) {
  const rounded = roundQty(qty);
  const label = STOCK_UNIT_LABELS[unit] ?? { many: unit.toLowerCase(), one: unit.toLowerCase() };
  const number = rounded.toLocaleString("en-IN", { maximumFractionDigits: 2 });

  return `${number} ${Math.abs(rounded) === 1 ? label.one : label.many}`;
}

/**
 * `2 sacks (50 kg)` when the line was entered in the item's pack, else `50 kg`.
 * Stock is always stored in the item's own unit; the pack is how it was bought.
 */
export function formatPackQty(
  qty: number,
  unit: StockUnit,
  pack?: { packQty?: number | null; packUnit?: StockUnit | null } | null,
) {
  if (pack?.packUnit && pack.packQty) return `${formatQty(pack.packQty, pack.packUnit)} (${formatQty(qty, unit)})`;

  return formatQty(qty, unit);
}

export function isStockUnit(value: unknown): value is StockUnit {
  return typeof value === "string" && (STOCK_UNITS as readonly string[]).includes(value);
}
