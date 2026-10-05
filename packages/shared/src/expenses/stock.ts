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

export const STOCK_ENTRY_KINDS = ["BUY", "SEND", "COUNT"] as const;

export type StockEntryKind = (typeof STOCK_ENTRY_KINDS)[number];

export const STOCK_ENTRY_LABELS: Record<StockEntryKind, string> = {
  BUY: "Bought",
  COUNT: "Count",
  SEND: "Send",
};

/** `DONE` for Bought and Count; a Send is `PENDING` until the other side taps Got it. */
export type StockEntryStatus = "CANCELLED" | "DONE" | "PENDING" | "RECEIVED";

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

export function isStockUnit(value: unknown): value is StockUnit {
  return typeof value === "string" && (STOCK_UNITS as readonly string[]).includes(value);
}
