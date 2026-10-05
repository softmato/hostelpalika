import type { Ionicons } from "@expo/vector-icons";

import { REALTIME_TOPIC } from "@/constants/topics";
import { isOverall } from "@/lib/active-hostel";
import { api } from "@/lib/api";
import { type ApiEnvelope, readApiError, readApiErrorCode, unwrap } from "@/lib/api-contract";
import type { ExpensePaidBy } from "@/lib/expenses";
import { defineQuery, type Query } from "@/lib/query-cache";
import {
  formatQty,
  type StockEntryKind,
  type StockEntryStatus,
  type StockKind,
  type StockUnit,
} from "@hostel/expenses/stock";

export {
  formatQty,
  roundQty,
  STOCK_ENTRY_LABELS,
  STOCK_ITEM_NAME_MAX,
  STOCK_KIND_LABELS,
  STOCK_QTY_MAX,
  STOCK_UNIT_LABELS,
  STOCK_UNITS,
} from "@hostel/expenses/stock";
export type { StockEntryKind, StockEntryStatus, StockKind, StockUnit };

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

export type StockAt = {
  bought: number;
  counted: number | null;
  countedAt: string | null;
  hostelId: string;
  in: number;
  left: number;
  low: boolean;
  onWay: number;
  out: number;
  short: number;
  used: number;
};

export type StockItem = {
  active: boolean;
  at: StockAt[];
  category: string;
  id: string;
  kind: StockKind;
  lowAt: number | null;
  name: string;
  unit: StockUnit;
};

export type StockLine = { itemId: string; name: string; qty: number; receivedQty: number | null; unit: StockUnit };

export type StockEntry = {
  amount: number | null;
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
  receivedByName: string | null;
  recordedByName: string;
  status: StockEntryStatus;
  toHostelId: string | null;
  toHostelName: string | null;
};

export type StockHome = {
  canSpend: boolean;
  currentPeriod: string;
  entries: StockEntry[];
  items: StockItem[];
  owner: boolean;
  period: string;
  places: StockPlace[];
  proofRequired: boolean;
  sentWaiting: StockEntry[];
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
  clientRequestId: string;
  hostelId?: string;
  kind: StockEntryKind;
  lines: { itemId: string; qty: number }[];
  note?: string;
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

export async function cancelStockEntry(id: string, reason: string) {
  return unwrap(
    await api.post<ApiEnvelope<StockEntry>>(`/hostel-admin/stock/entries/${id}/cancel`, { reason }),
  );
}

export type StockItemInput = {
  active?: boolean;
  kind: StockKind;
  lowAt?: number | null;
  name: string;
  unit: StockUnit;
};

type StockItemOnly = Omit<StockItem, "at">;

export async function addStockItem(input: StockItemInput) {
  return unwrap(await api.post<ApiEnvelope<StockItemOnly>>("/hostel-admin/stock/items", input));
}

/** Owner only. */
export async function updateStockItem(id: string, input: Partial<StockItemInput>) {
  return unwrap(await api.patch<ApiEnvelope<StockItemOnly>>(`/hostel-admin/stock/items/${id}`, input));
}

/* -------------------------------------------------------------------------- */
/* Look                                                                       */
/* -------------------------------------------------------------------------- */

type Glyph = { color: string; icon: keyof typeof Ionicons.glyphMap };

/**
 * A tinted tile per item, read from its name (English or romanised Nepali) —
 * the Finance screen's iOS colours, one per family of goods.
 */
const GLYPHS: { glyph: Glyph; words: RegExp }[] = [
  { glyph: { color: "#FF3B30", icon: "flame-outline" }, words: /gas|cylinder|lpg|firewood|daura/i },
  { glyph: { color: "#FF9F0A", icon: "water-outline" }, words: /oil|tel\b|ghee|ghiu/i },
  { glyph: { color: "#FF2D55", icon: "fish-outline" }, words: /meat|masu|chicken|kukhura|mutton|khasi|buff|fish|machha|pork/i },
  { glyph: { color: "#FF9500", icon: "egg-outline" }, words: /egg|anda|phul/i },
  { glyph: { color: "#007AFF", icon: "pint-outline" }, words: /milk|dudh|curd|dahi|paneer|butter/i },
  {
    glyph: { color: "#34C759", icon: "leaf-outline" },
    words: /veg|tarkari|sabji|saag|spinach|potato|aalu|alu\b|onion|pyaj|tomato|golbheda|cauli|cabbage|bandagobi|carrot|gajar|radish|mula|garlic|lasun|ginger|aduwa|chilli|khursani|fruit|banana|apple/i,
  },
  { glyph: { color: "#AF52DE", icon: "cafe-outline" }, words: /tea|chiya|coffee|sugar|chini|salt|nun|masala|spice|jeera|besar|turmeric/i },
  { glyph: { color: "#5AC8FA", icon: "sparkles-outline" }, words: /soap|sabun|detergent|surf|clean|phenyl|harpic|broom|kucho|mop|tissue/i },
  {
    glyph: { color: "#5E5CE6", icon: "restaurant-outline" },
    words: /pot|pan|plate|thal|cooker|utensil|bhada|spoon|chamcha|glass|gilas|bucket|balti|kadai|karahi|tawa|jug|bowl|knife/i,
  },
  { glyph: { color: "#FF9500", icon: "nutrition-outline" }, words: /rice|chamal|chawal|daal|dal\b|lentil|pulse|beans|chana|rajma|atta|maida|flour|chiura|beaten/i },
];

export function stockGlyph(item: { kind: StockKind; name: string }): Glyph {
  const hit = GLYPHS.find((entry) => entry.words.test(item.name));

  if (hit) return hit.glyph;

  return item.kind === "DAILY"
    ? { color: "#34C759", icon: "basket-outline" }
    : { color: "#FF9500", icon: "cube-outline" };
}

export const ENTRY_GLYPHS: Record<StockEntryKind, Glyph> = {
  BUY: { color: "#34C759", icon: "bag-add-outline" },
  COUNT: { color: "#AF52DE", icon: "clipboard-outline" },
  SEND: { color: "#007AFF", icon: "paper-plane-outline" },
};

/** `Rice 50 kg, Daal 20 kg +2 more` — one line for a row. */
export function linesSummary(lines: readonly StockLine[], max = 2) {
  const shown = lines.slice(0, max).map((line) => `${line.name} ${formatQty(line.qty, line.unit)}`);
  const rest = lines.length - max;

  return rest > 0 ? `${shown.join(", ")} +${rest} more` : shown.join(", ");
}

/** The row title an entry reads as. */
export function entryTitle(entry: StockEntry) {
  if (entry.kind === "SEND") return `${entry.hostelName} → ${entry.toHostelName ?? ""}`;
  if (entry.kind === "COUNT") return `Count · ${entry.hostelName}`;

  return `Bought · ${entry.hostelName}`;
}

/** Items short on a received Send, as `Rice 2 kg short`. */
export function shortLines(entry: StockEntry) {
  return entry.lines
    .filter((line) => line.receivedQty !== null && line.receivedQty < line.qty)
    .map((line) => `${line.name} ${formatQty(line.qty - (line.receivedQty ?? 0), line.unit)} short`);
}

/** Text input → quantity: `2.5`, `2,5`, `10`. `null` for anything else. */
export function parseQtyInput(value: string): number | null {
  const cleaned = value.trim().replace(",", ".");

  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;

  const qty = Number(cleaned);

  return Number.isFinite(qty) ? qty : null;
}
