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

export type StockLine = {
  itemId: string;
  name: string;
  qty: number;
  /** Bought only: rupees per unit, if the bill showed it. */
  rate: number | null;
  receivedQty: number | null;
  unit: StockUnit;
};

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
  /** Bought only: the shop or person it came from. */
  supplier: string;
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
  lines: { itemId: string; qty: number; rate?: number }[];
  note?: string;
  supplier?: string;
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

type IconName = keyof typeof Ionicons.glyphMap;

/**
 * An item's picture: an emoji on a tint of its family colour, read from the
 * name (English or romanised Nepali). Emoji rather than photos: every phone
 * already has them, they need no upload, and a sack of rice reads as rice.
 * Only emoji from Unicode 12 or older, so a 2019 Android does not draw boxes.
 */
const LOOKS: { color: string; emoji: string; words: RegExp }[] = [
  { color: "#FF3B30", emoji: "🔥", words: /gas|cylinder|lpg|firewood|daura/i },
  { color: "#FF9F0A", emoji: "🛢️", words: /oil|tel\b|ghee|ghiu/i },
  { color: "#FF2D55", emoji: "🍗", words: /chicken|kukhura/i },
  { color: "#FF2D55", emoji: "🐟", words: /fish|machha/i },
  { color: "#FF2D55", emoji: "🥩", words: /meat|masu|mutton|khasi|buff|pork/i },
  { color: "#FF9500", emoji: "🥚", words: /egg|anda|phul/i },
  { color: "#007AFF", emoji: "🥛", words: /milk|dudh|curd|dahi|paneer|butter/i },
  { color: "#34C759", emoji: "🥔", words: /potato|aalu|alu\b/i },
  { color: "#34C759", emoji: "🧅", words: /onion|pyaj/i },
  { color: "#FF3B30", emoji: "🍅", words: /tomato|golbheda/i },
  { color: "#FF3B30", emoji: "🌶️", words: /chilli|chili|khursani/i },
  { color: "#34C759", emoji: "🥬", words: /veg|tarkari|sabji|saag|spinach|cauli|cabbage|bandagobi|carrot|gajar|radish|mula|garlic|lasun|ginger|aduwa/i },
  { color: "#FF9500", emoji: "🍌", words: /fruit|banana|apple|orange|suntala/i },
  { color: "#AF52DE", emoji: "🍵", words: /tea|chiya|coffee/i },
  { color: "#AF52DE", emoji: "🧂", words: /salt|nun\b|masala|spice|jeera|besar|turmeric|sugar|chini/i },
  { color: "#5AC8FA", emoji: "🧼", words: /soap|sabun|detergent|surf|clean|phenyl|harpic|broom|kucho|mop|tissue/i },
  { color: "#5E5CE6", emoji: "🍳", words: /pot|pan\b|plate|thal|cooker|utensil|bhada|spoon|chamcha|glass|gilas|bucket|balti|kadai|karahi|tawa|jug|bowl|knife/i },
  { color: "#FF9500", emoji: "🥣", words: /daal|dal\b|lentil|pulse|beans|chana|rajma/i },
  { color: "#FF9500", emoji: "🍚", words: /rice|chamal|chawal|atta|maida|flour|chiura|beaten/i },
];

export function stockLook(item: { kind: StockKind; name: string }): { color: string; emoji: string } {
  return (
    LOOKS.find((entry) => entry.words.test(item.name)) ??
    (item.kind === "DAILY" ? { color: "#34C759", emoji: "🧺" } : { color: "#FF9500", emoji: "📦" })
  );
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

export type EntryKindView = "BOUGHT" | "COUNT" | "GOT_IT" | "ON_THE_WAY" | "SEND";

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
  const grey = "#8E8E93";

  if (entry.kind === "BUY") {
    return {
      color: cancelled ? grey : "#34C759",
      detail: entry.supplier || namesSummary(entry.lines),
      icon: "cart-outline",
      kind: "BOUGHT",
      label: "Bought",
    };
  }

  if (entry.kind === "COUNT") {
    const only = entry.lines.length === 1 ? entry.lines[0] : null;

    return {
      color: cancelled ? grey : "#AF52DE",
      detail: only ? `Set left to ${formatQty(only.qty, only.unit)}` : `${entry.lines.length} items counted`,
      icon: "clipboard-outline",
      kind: "COUNT",
      label: "Count",
    };
  }

  const incoming = entry.toHostelId !== null && mine.has(entry.toHostelId) && !mine.has(entry.hostelId);

  if (incoming) {
    const waiting = entry.status === "PENDING";

    return {
      color: cancelled ? grey : waiting ? "#FF9500" : "#5AC8FA",
      detail: `From ${entry.hostelName}`,
      icon: waiting ? "time-outline" : "checkmark-done-outline",
      kind: waiting ? "ON_THE_WAY" : "GOT_IT",
      label: waiting ? "Coming to you" : "Got it",
    };
  }

  return {
    color: cancelled ? grey : "#007AFF",
    detail: `To ${entry.toHostelName ?? ""}`,
    icon: "arrow-redo-outline",
    kind: "SEND",
    label: "Send",
  };
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
