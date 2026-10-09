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
  COUNT: "Count",
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
