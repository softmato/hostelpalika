import type { Ionicons } from "@expo/vector-icons";

import { palette } from "@/constants/theme";
import { REALTIME_TOPIC } from "@/constants/topics";
import { isOverall } from "@/lib/active-hostel";
import { api } from "@/lib/api";
import { type ApiEnvelope, readApiError, readApiErrorCode, unwrap } from "@/lib/api-contract";
import type { ExpensePaidBy } from "@/lib/expenses";
import { defineQuery, type Query } from "@/lib/query-cache";
import {
  formatQty,
  STOCK_USE_FOR_LABELS,
  STOCK_WASTE_LABELS,
  type StockBillStatus,
  type StockEntryKind,
  type StockEntryStatus,
  type StockKind,
  type StockUnit,
  type StockUseFor,
  type StockWasteReason,
} from "@hostel/expenses/stock";

export {
  billStatus,
  formatPackQty,
  formatQty,
  roundQty,
  STOCK_BILL_STATUS_LABELS,
  STOCK_ENTRY_LABELS,
  STOCK_ITEM_NAME_MAX,
  STOCK_KIND_LABELS,
  STOCK_QTY_MAX,
  STOCK_SUPPLIER_NAME_MAX,
  STOCK_UNIT_LABELS,
  STOCK_UNITS,
  STOCK_USE_FOR,
  STOCK_USE_FOR_LABELS,
  STOCK_WASTE_LABELS,
  STOCK_WASTE_REASONS,
} from "@hostel/expenses/stock";
export type { StockBillStatus, StockEntryKind, StockEntryStatus, StockKind, StockUnit, StockUseFor, StockWasteReason };

/**
 * Stock over the wire (docs/INVENTORY_PLAN.md). Shapes mirror
 * `apps/web/src/modules/stock/stock.service.ts` — read the service, not this
 * file, when they disagree.
 */

export type StockPlace = {
  id: string;
  isMain: boolean;
  /** This person acts for it. A warden sees only their own; the owner all. */
  mine: boolean;
  name: string;
  residents: number | null;
};

/** One item in one building. Values are whole rupees, and 0 for someone who does not see money. */
export type StockAt = {
  /** This month: signed — found extra (+) or missing (−) at Counts. */
  adjusted: number;
  adjustedValue: number;
  bought: number;
  boughtValue: number;
  /** End of the month on screen. */
  closing: number;
  counted: number | null;
  countedAt: string | null;
  hostelId: string;
  in: number;
  left: number;
  low: boolean;
  onWay: number;
  /** Start of the month on screen. */
  opening: number;
  out: number;
  short: number;
  used: number;
  usedValue: number;
  wasted: number;
  wastedValue: number;
};

export type StockItem = {
  active: boolean;
  at: StockAt[];
  /** Weighted average cost per unit; `null` without money rights or a priced Bought. */
  avgCost: number | null;
  category: string;
  id: string;
  kind: StockKind;
  location: string;
  lowAt: number | null;
  name: string;
  packSize: number | null;
  packUnit: StockUnit | null;
  unit: StockUnit;
  /** Left now at the average cost; `null` without money rights. */
  value: number | null;
};

export type StockLine = {
  /** Bought: the line's price. */
  amount: number | null;
  itemId: string;
  name: string;
  packQty: number | null;
  packUnit: StockUnit | null;
  qty: number;
  /** Bought only: rupees per unit, if the bill showed it. */
  rate: number | null;
  receivedQty: number | null;
  /** Count: what the book said then. */
  systemQty: number | null;
  unit: StockUnit;
};

export type StockBill = {
  billNo: string;
  discount: number | null;
  due: number | null;
  paid: number | null;
  photoAssetId: string | null;
  status: StockBillStatus | null;
  supplierId: string | null;
  tax: number | null;
  total: number | null;
};

export type StockEntry = {
  amount: number | null;
  approvedByName: string | null;
  bill: StockBill | null;
  canApprove: boolean;
  canCancel: boolean;
  canReceive: boolean;
  cancelReason: string | null;
  createdAt: string;
  hostelId: string;
  hostelName: string;
  id: string;
  kind: StockEntryKind;
  lines: StockLine[];
  mine: boolean;
  note: string;
  on: string;
  receivedAt: string | null;
  /** Bought only: the shop or person it came from. */
  supplier: string;
  receivedByName: string | null;
  recordedByName: string;
  status: StockEntryStatus;
  toHostelId: string | null;
  toHostelName: string | null;
  useFor: StockUseFor | null;
  wasteReason: StockWasteReason | null;
};

export type StockSupplier = {
  active: boolean;
  bills: number;
  billed: number | null;
  /** Owed now; negative is paid ahead. `null` without money rights. */
  due: number | null;
  id: string;
  lastBillOn: string | null;
  name: string;
  note: string;
  openingDue: number | null;
  phone: string;
};

export type StockSummary = {
  boughtValue: number | null;
  byCategory: { category: string; stockValue: number; usedValue: number }[];
  bySupplier: { bills: number; billed: number; name: string; paid: number; supplierId: string | null }[];
  costPerResidentDay: number | null;
  days: number;
  dueTotal: number | null;
  low: number;
  missingValue: number | null;
  residents: number;
  spentValue: number | null;
  stockValue: number | null;
  usedValue: number | null;
  wastedValue: number | null;
};

export type StockHome = {
  /** May approve someone else's Count. */
  canApprove: boolean;
  /** May put prices on a bill and pay suppliers. */
  canSpend: boolean;
  currentPeriod: string;
  entries: StockEntry[];
  items: StockItem[];
  /** Sees prices, values and dues. */
  money: boolean;
  owner: boolean;
  period: string;
  places: StockPlace[];
  proofRequired: boolean;
  /** Store item ids, most used lately first. */
  recentUse: string[];
  sentWaiting: StockEntry[];
  summary: StockSummary;
  suppliers: StockSupplier[];
  toApprove: StockEntry[];
  waiting: StockEntry[];
};

/** A refusal is an answer: a warden without Stock gets a sentence, not an empty store. */
export type StockLoad = { home: StockHome; kind: "ok" } | { kind: "denied"; message: string };

const DENIED_CODES = new Set(["CAPABILITY_DENIED", "FORBIDDEN"]);

/** `null` is this month — the entry the add screen shares. On the food topic: the kitchen's. */
export function stockQuery(period: string | null): Query<StockLoad> {
  return defineQuery(`stock:${period ?? "current"}`, [REALTIME_TOPIC.FOOD], async () => {
    try {
      const home = unwrap(
        await api.get<ApiEnvelope<StockHome>>("/hostel-admin/stock", {
          // Overall reads every building; the cache is already scoped per switcher choice.
          params: { ...(period ? { period } : {}), ...(isOverall() ? { scope: "all" } : {}) },
        }),
      );

      return { home, kind: "ok" as const };
    } catch (error) {
      const code = readApiErrorCode(error);

      if (code && DENIED_CODES.has(code)) return { kind: "denied" as const, message: readApiError(error) };

      throw error;
    }
  });
}

export type NewStockEntry = {
  amount?: number;
  billNo?: string;
  clientRequestId: string;
  discount?: number;
  hostelId?: string;
  kind: StockEntryKind;
  lines: { amount?: number; itemId: string; packQty?: number; qty: number; rate?: number }[];
  note?: string;
  /** Bought: paid on the day. Absent: all of it. */
  paid?: number;
  supplier?: string;
  supplierId?: string;
  tax?: number;
  useFor?: StockUseFor;
  wasteReason?: StockWasteReason;
  /** Gregorian `YYYY-MM-DD`. */
  on?: string;
  paidBy?: ExpensePaidBy;
  photoAssetId?: string;
  toHostelId?: string;
};

export async function addStockEntry(input: NewStockEntry) {
  return unwrap(await api.post<ApiEnvelope<StockEntry>>("/hostel-admin/stock", input));
}

/** Got it. Lines left out arrived in full. */
export async function receiveStock(id: string, lines?: { itemId: string; receivedQty: number }[]) {
  return unwrap(
    await api.post<ApiEnvelope<StockEntry>>(`/hostel-admin/stock/entries/${id}/receive`, { lines }),
  );
}

/** Approve a warden's Count. Turning it down is `cancelStockEntry` with a reason. */
export async function approveStockCount(id: string) {
  return unwrap(await api.post<ApiEnvelope<StockEntry>>(`/hostel-admin/stock/entries/${id}/approve`, {}));
}

export async function cancelStockEntry(id: string, reason: string) {
  return unwrap(
    await api.post<ApiEnvelope<StockEntry>>(`/hostel-admin/stock/entries/${id}/cancel`, { reason }),
  );
}

export type StockItemInput = {
  active?: boolean;
  category?: string;
  kind: StockKind;
  location?: string;
  lowAt?: number | null;
  name: string;
  packSize?: number | null;
  packUnit?: StockUnit | null;
  unit: StockUnit;
};

type StockItemOnly = Omit<StockItem, "at" | "avgCost" | "value">;

export async function addStockItem(input: StockItemInput) {
  return unwrap(await api.post<ApiEnvelope<StockItemOnly>>("/hostel-admin/stock/items", input));
}

/** Owner only. */
export async function updateStockItem(id: string, input: Partial<StockItemInput>) {
  return unwrap(await api.patch<ApiEnvelope<StockItemOnly>>(`/hostel-admin/stock/items/${id}`, input));
}

/* -------------------------------------------------------------------------- */
/* Suppliers                                                                  */
/* -------------------------------------------------------------------------- */

export type StockSupplierInput = { active?: boolean; name: string; note?: string; openingDue?: number; phone?: string };

type StockSupplierOnly = Pick<StockSupplier, "active" | "id" | "name" | "note" | "openingDue" | "phone">;

export async function addStockSupplier(input: StockSupplierInput) {
  return unwrap(await api.post<ApiEnvelope<StockSupplierOnly>>("/hostel-admin/stock/suppliers", input));
}

export async function updateStockSupplier(id: string, input: Partial<StockSupplierInput>) {
  return unwrap(await api.patch<ApiEnvelope<StockSupplierOnly>>(`/hostel-admin/stock/suppliers/${id}`, input));
}

export type SupplierLedgerRow = {
  balance: number;
  bill: { billNo: string; items: string; paid: number; status: StockBillStatus; total: number } | null;
  change: number;
  id: string;
  kind: "BILL" | "OPENING" | "PAYMENT";
  on: string;
  payment: { amount: number; canCancel: boolean; note: string; paidBy: string; recordedByName: string } | null;
};

export type SupplierLedger = {
  billed: number;
  due: number;
  paid: number;
  /** Newest first. */
  rows: SupplierLedgerRow[];
  supplier: StockSupplierOnly;
};

export function supplierQuery(id: string): Query<SupplierLedger> {
  return defineQuery(`stock-supplier:${id}`, [REALTIME_TOPIC.FOOD], async () =>
    unwrap(await api.get<ApiEnvelope<SupplierLedger>>(`/hostel-admin/stock/suppliers/${id}`)),
  );
}

export type NewStockPayment = {
  amount: number;
  clientRequestId: string;
  note?: string;
  on?: string;
  paidBy?: ExpensePaidBy;
  photoAssetId?: string;
  supplierId: string;
};

export async function payStockSupplier(input: NewStockPayment) {
  return unwrap(await api.post<ApiEnvelope<{ amount: number; id: string }>>("/hostel-admin/stock/payments", input));
}

export async function cancelStockPayment(id: string, reason: string) {
  return unwrap(await api.post<ApiEnvelope<{ id: string }>>(`/hostel-admin/stock/payments/${id}/cancel`, { reason }));
}

/* -------------------------------------------------------------------------- */
/* Look                                                                       */
/* -------------------------------------------------------------------------- */

type IconName = keyof typeof Ionicons.glyphMap;

/**
 * An item's picture: an emoji, read from the
 * name (English or romanised Nepali). Emoji rather than photos: every phone
 * already has them, they need no upload, and a sack of rice reads as rice.
 * Only emoji from Unicode 12 or older, so a 2019 Android does not draw boxes.
 */
const LOOKS: { emoji: string; words: RegExp }[] = [
  { emoji: "🔥", words: /gas|cylinder|lpg|firewood|daura/i },
  { emoji: "🛢️", words: /oil|tel\b|ghee|ghiu/i },
  { emoji: "🍗", words: /chicken|kukhura/i },
  { emoji: "🐟", words: /fish|machha/i },
  { emoji: "🥩", words: /meat|masu|mutton|khasi|buff|pork/i },
  { emoji: "🥚", words: /egg|anda|phul/i },
  { emoji: "🥛", words: /milk|dudh|curd|dahi|paneer|butter/i },
  { emoji: "🥔", words: /potato|aalu|alu\b/i },
  { emoji: "🧅", words: /onion|pyaj/i },
  { emoji: "🍅", words: /tomato|golbheda/i },
  { emoji: "🌶️", words: /chilli|chili|khursani/i },
  { emoji: "🥬", words: /veg|tarkari|sabji|saag|spinach|cauli|cabbage|bandagobi|carrot|gajar|radish|mula|garlic|lasun|ginger|aduwa/i },
  { emoji: "🍌", words: /fruit|banana|apple|orange|suntala/i },
  { emoji: "🍵", words: /tea|chiya|coffee/i },
  { emoji: "🧂", words: /salt|nun\b|masala|spice|jeera|besar|turmeric|sugar|chini/i },
  { emoji: "🧼", words: /soap|sabun|detergent|surf|clean|phenyl|harpic|broom|kucho|mop|tissue/i },
  { emoji: "🍳", words: /pot|pan\b|plate|thal|cooker|utensil|bhada|spoon|chamcha|glass|gilas|bucket|balti|kadai|karahi|tawa|jug|bowl|knife/i },
  { emoji: "🥣", words: /daal|dal\b|lentil|pulse|beans|chana|rajma/i },
  { emoji: "🍚", words: /rice|chamal|chawal|atta|maida|flour|chiura|beaten/i },
];

export function stockLook(item: { kind: StockKind; name: string }): { emoji: string } {
  return (
    LOOKS.find((entry) => entry.words.test(item.name)) ??
    (item.kind === "DAILY" ? { emoji: "🧺" } : { emoji: "📦" })
  );
}

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

/** The item already called this — any case, any spacing — switched off ones included. */
export function findStockItem<T extends { name: string }>(items: readonly T[], name: string): T | null {
  const wanted = name.trim().replace(/\s+/g, " ").toLowerCase();

  if (!wanted) return null;

  return items.find((item) => item.name.trim().replace(/\s+/g, " ").toLowerCase() === wanted) ?? null;
}

/** `Rice 50 kg, Daal 20 kg +2 more` — one line for a row. */
export function linesSummary(lines: readonly StockLine[], max = 2) {
  const shown = lines.slice(0, max).map((line) => `${line.name} ${formatQty(line.qty, line.unit)}`);
  const rest = lines.length - max;

  return rest > 0 ? `${shown.join(", ")} +${rest} more` : shown.join(", ");
}

/** `Rice, Daal, Oil +2` — names only, for a row's second line. */
export function namesSummary(lines: readonly StockLine[], max = 3) {
  const shown = lines.slice(0, max).map((line) => line.name);
  const rest = lines.length - max;

  return rest > 0 ? `${shown.join(", ")} +${rest}` : shown.join(", ");
}

/** Items short on a received Send, as `Rice 2 kg short`. */
export function shortLines(entry: StockEntry) {
  return entry.lines
    .filter((line) => line.receivedQty !== null && line.receivedQty < line.qty)
    .map((line) => `${line.name} ${formatQty(line.qty - (line.receivedQty ?? 0), line.unit)} short`);
}

export type EntryKindView = "BOUGHT" | "COUNT" | "GOT_IT" | "ON_THE_WAY" | "OPENING" | "SEND" | "USED" | "WASTED";

export type EntryView = {
  color: string;
  icon: IconName;
  kind: EntryKindView;
  label: string;
  /** The second line: where it came from or went, or what a Count set. */
  detail: string;
};

/**
 * How an entry reads from where the person is standing. A Send is "Send" to the
 * building it left and "On the way" / "Got it" to the one it went to — the same
 * row, told from each end.
 */
export function entryView(entry: StockEntry, mine: ReadonlySet<string>): EntryView {
  const cancelled = entry.status === "CANCELLED";
  const grey = palette.light.mutedForeground;

  if (entry.kind === "BUY") {
    return {
      color: cancelled ? grey : palette.light.primary,
      detail: entry.supplier || namesSummary(entry.lines),
      icon: "cart-outline",
      kind: "BOUGHT",
      label: entry.bill?.billNo ? `Bill ${entry.bill.billNo}` : "Bought",
    };
  }

  if (entry.kind === "OPENING") {
    return {
      color: cancelled ? grey : palette.light.primary,
      detail: namesSummary(entry.lines),
      icon: "archive-outline",
      kind: "OPENING",
      label: "Opening stock",
    };
  }

  if (entry.kind === "USE") {
    return {
      color: cancelled ? grey : palette.light.foreground,
      detail: `${entry.useFor ? STOCK_USE_FOR_LABELS[entry.useFor] : "Kitchen"} · ${namesSummary(entry.lines)}`,
      icon: "restaurant-outline",
      kind: "USED",
      label: "Used",
    };
  }

  if (entry.kind === "WASTE") {
    return {
      color: cancelled ? grey : palette.light.destructive,
      detail: `${entry.wasteReason ? STOCK_WASTE_LABELS[entry.wasteReason] : "Wasted"} · ${namesSummary(entry.lines)}`,
      icon: "trash-outline",
      kind: "WASTED",
      label: "Wasted",
    };
  }

  if (entry.kind === "COUNT") {
    const off = entry.lines.filter((line) => line.systemQty !== null && line.qty !== line.systemQty);
    const only = off.length === 1 ? off[0] : null;

    return {
      color: cancelled ? grey : entry.status === "PENDING" ? palette.light.warning : palette.light.mutedForeground,
      detail: only
        ? countGap(only)
        : off.length > 1
          ? `${off.length} items different`
          : `${entry.lines.length} item${entry.lines.length === 1 ? "" : "s"} · all match`,
      icon: "clipboard-outline",
      kind: "COUNT",
      label: entry.status === "PENDING" ? "Count · to approve" : "Count",
    };
  }

  const incoming = entry.toHostelId !== null && mine.has(entry.toHostelId) && !mine.has(entry.hostelId);

  if (incoming) {
    const waiting = entry.status === "PENDING";

    return {
      color: cancelled ? grey : waiting ? palette.light.warning : palette.light.success,
      detail: `From ${entry.hostelName}`,
      icon: waiting ? "time-outline" : "checkmark-done-outline",
      kind: waiting ? "ON_THE_WAY" : "GOT_IT",
      label: waiting ? "Coming to you" : "Got it",
    };
  }

  return {
    color: cancelled ? grey : palette.light.primary,
    detail: `To ${entry.toHostelName ?? ""}`,
    icon: "arrow-redo-outline",
    kind: "SEND",
    label: "Send",
  };
}

/** `Rice 2 kg missing` / `Rice 1 kg extra` — a Count line against the book. */
export function countGap(line: StockLine) {
  const gap = line.qty - (line.systemQty ?? line.qty);

  if (gap === 0) return `${line.name} matches`;

  return `${line.name} ${formatQty(Math.abs(gap), line.unit)} ${gap < 0 ? "missing" : "extra"}`;
}

/** The number on the right of a row: one line's quantity, or the item count. */
export function entryQty(entry: StockEntry) {
  const only = entry.lines.length === 1 ? entry.lines[0] : null;

  if (!only) return `${entry.lines.length} items`;

  return formatQty(entry.kind === "SEND" && only.receivedQty !== null ? only.receivedQty : only.qty, only.unit);
}

/** Text input → quantity: `2.5`, `2,5`, `10`. `null` for anything else. */
export function parseQtyInput(value: string): number | null {
  const cleaned = value.trim().replace(",", ".");

  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;

  const qty = Number(cleaned);

  return Number.isFinite(qty) ? qty : null;
}
