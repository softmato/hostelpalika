import type { StockBillStatus, StockEntryKind, StockEntryStatus, StockKind, StockUnit, StockUseFor, StockWasteReason } from "@hostel/shared/expenses/stock";

import type { ItemAtPlace, ReportFigures, UsageRow } from "@/lib/stock/stock-balance";
import type { StockReportRange } from "@/lib/stock/stock.validation";

export type StockRights = {
  /** May approve a warden's Count (owner, or a warden with `approveStockCount`). */
  canApprove: boolean;
  /** May put money on a bill or pay a supplier: owner, or a warden with Add expenses. */
  canSpend: boolean;
  /** Sees prices, values and dues. Same people as `canSpend`. */
  money: boolean;
  proofRequired: boolean;
};

/** Who in the hostel entered a movement. `null` on rows from before this was kept. */
export type StockRecorderRole = "COOK" | "OWNER" | "WARDEN";

export type StockBill = {
  billNo: string;
  discount: number | null;
  /** What is still owed on this bill alone. */
  due: number | null;
  paid: number | null;
  photoAssetId: string | null;
  status: StockBillStatus | null;
  supplierId: string | null;
  tax: number | null;
  total: number | null;
};

export type StockEntryRow = {
  /** The expense this entry wrote, when this person may see it. */
  amount: number | null;
  approvedByName: string | null;
  /** BUY only. Money fields are `null` for someone who does not see money. */
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
  lines: {
    /** BUY: the line's price. */
    amount: number | null;
    itemId: string;
    name: string;
    packQty: number | null;
    packUnit: StockUnit | null;
    qty: number;
    rate: number | null;
    receivedQty: number | null;
    /** COUNT: what the book said then. */
    systemQty: number | null;
    unit: StockUnit;
  }[];
  mine: boolean;
  note: string;
  /** Gregorian `YYYY-MM-DD`; screens read it in Bikram Sambat. */
  on: string;
  receivedAt: string | null;
  receivedByName: string | null;
  recordedByName: string;
  recordedRole: StockRecorderRole | null;
  status: StockEntryStatus;
  supplier: string;
  toHostelId: string | null;
  toHostelName: string | null;
  useFor: StockUseFor | null;
  wasteReason: StockWasteReason | null;
};

export type StockItemRow = {
  active: boolean;
  /** Per building this person can see, main first. */
  at: AtRow[];
  /** Weighted average cost per unit. `null` without money rights or without a priced Bought. */
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
  /** What is left now, at the average cost. `null` without money rights. */
  value: number | null;
};

export type StockSupplierRow = {
  active: boolean;
  /** Bills not cancelled, all time. */
  bills: number;
  billed: number | null;
  /** Owed now. Negative: paid ahead. `null` without money rights. */
  due: number | null;
  id: string;
  lastBillOn: string | null;
  name: string;
  note: string;
  openingDue: number | null;
  phone: string;
};

export type StockSummary = {
  /** Store items whose Left is under their low mark in a building on screen. */
  low: number;
  /** Everything below is `null` / empty without money rights. */
  boughtValue: number | null;
  byCategory: { category: string; stockValue: number; usedValue: number }[];
  bySupplier: { bills: number; billed: number; name: string; paid: number; supplierId: string | null }[];
  /** Used + wasted + missing at Counts, this month, per resident per day so far. */
  costPerResidentDay: number | null;
  days: number;
  dueTotal: number | null;
  missingValue: number | null;
  residents: number;
  spentValue: number | null;
  stockValue: number | null;
  usedValue: number | null;
  wastedValue: number | null;
};

export type StockHome = StockRights & {
  currentPeriod: string;
  /** This month's entries touching the buildings this person sees, newest first. */
  entries: StockEntryRow[];
  items: StockItemRow[];
  owner: boolean;
  period: string;
  places: (Place & { mine: boolean; residents: number | null })[];
  /** Store items used most lately, most first — the Use screen's first tiles. */
  recentUse: string[];
  /** Sends from these buildings still waiting for Got it. */
  sentWaiting: StockEntryRow[];
  summary: StockSummary;
  suppliers: StockSupplierRow[];
  /** Counts in these buildings waiting for this person's approval. */
  toApprove: StockEntryRow[];
  /** Sends to these buildings: tap Got it. */
  waiting: StockEntryRow[];
};

export type StockUsageRange = "month" | "today" | "week";

export type StockUsage = {
  /** Every day in the range, newest first. */
  days: string[];
  from: string;
  items: { avgCost: number | null; id: string; kind: StockKind; name: string; unit: StockUnit }[];
  money: boolean;
  places: { id: string; name: string }[];
  range: StockUsageRange;
  rows: UsageRow[];
  to: string;
  /** Used + wasted, at average cost. `null` without money rights. */
  value: number | null;
};

export type StockReportItem = ReportFigures & {
  avgCost: number | null;
  category: string;
  id: string;
  kind: StockKind;
  name: string;
  unit: StockUnit;
};

export type StockReport = {
  bySupplier: StockSummary["bySupplier"];
  /** Used + wasted + missing at Counts over the range, per resident per day. */
  costPerResidentDay: number | null;
  days: number;
  /** First BS month of the range; `to` is this month. */
  from: string;
  /** Everything bought, used or on the shelf, by category then name. Rupees zero without money rights. */
  items: StockReportItem[];
  /** "Last 3 months". */
  label: string;
  money: boolean;
  nextPeriod: string;
  range: StockReportRange;
  residents: number;
  /** The building, or "All buildings". */
  scope: string;
  to: string;
  /** `null` without money rights. */
  totals: {
    boughtValue: number;
    missingValue: number;
    nextValue: number;
    stockValue: number;
    usedValue: number;
    wastedValue: number;
  } | null;
};

/** `location` is "Area, City" from the hostel record — what tells two branches apart on Send. */
export type Place = { id: string; isMain: boolean; location: string; name: string };

export type AtRow = Omit<ItemAtPlace, "countedAt"> & { countedAt: string | null; hostelId: string; low: boolean };
