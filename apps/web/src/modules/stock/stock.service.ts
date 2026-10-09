import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { bsPeriodBounds, currentBsPeriod, hostelPeriodOf, hostelToday, isBsPeriod } from "@/lib/hostel-day";
import { REALTIME_TOPIC } from "@/lib/realtime/channels";
import { publishResourceChange } from "@/lib/realtime/server";
import { Role } from "@/lib/roles";
import { grantingPermissionKeys } from "@/lib/warden-capability";
import {
  createExpense,
  type ExpenseActor,
  ExpenseError,
  parseSpentOn,
  voidExpense,
} from "@/modules/finance/expenses/expense.service";
import type { CreateExpenseInput } from "@/modules/finance/expenses/expense.validation";
import {
  createInAppNotification,
  settleActionNotifications,
} from "@/modules/notifications/notification.service";
import { EXPENSE_WHAT_MAX } from "@hostel/shared/expenses/categories";
import {
  billStatus,
  formatQty,
  roundQty,
  type StockBillStatus,
  STOCK_ITEM_LIMIT,
  STOCK_SUPPLIER_LIMIT,
  type StockEntryKind,
  type StockEntryStatus,
  type StockKind,
  type StockUnit,
  type StockUseFor,
  type StockWasteReason,
} from "@hostel/shared/expenses/stock";
import { ExpenseModel } from "@hostel/db/models/Expense";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelMemberModel } from "@hostel/db/models/HostelMember";
import { ResidentModel } from "@hostel/db/models/Resident";
import { StockEntryModel } from "@hostel/db/models/StockEntry";
import { StockItemModel } from "@hostel/db/models/StockItem";
import { StockPaymentModel } from "@hostel/db/models/StockPayment";
import { StockSupplierModel } from "@hostel/db/models/StockSupplier";
import { UserModel } from "@hostel/db/models/User";

import { emptyAtPlace, type FoldEntry, foldStock, type ItemAtPlace, supplierLedger } from "./stock-balance";
import type {
  CreateStockEntryInput,
  CreateStockItemInput,
  CreateStockPaymentInput,
  CreateStockSupplierInput,
  UpdateStockItemInput,
  UpdateStockSupplierInput,
} from "./stock.validation";

/**
 * Stock — what was bought, where it went, what is left (docs/INVENTORY_PLAN.md).
 *
 * ## The group, not the building
 *
 * Items and entries belong to the **group**: the main hostel and its branches,
 * keyed by the main hostel's id. The building a request is about (the
 * switcher's choice) decides which group and the one building everyone — the
 * owner too — acts for and sees; Send can still name any building in the group.
 * Only the owner's Overall read sees every building (`resolveStockActor`).
 *
 * ## Money is Money Out's
 *
 * A Bought with an amount writes one ordinary `Expense` through
 * `createExpense`, in the building the recorder is working in, so the proof rule,
 * the warden's cash box and the owner's statement all apply unchanged. Sending
 * goods never moves money between branches.
 *
 * A bill not paid in full leaves the rest owed to its **supplier**: only what
 * was paid becomes an expense on the day, and each later payment to the
 * supplier is an expense of its own. Money Out is cash that left; the supplier
 * ledger is what is still owed.
 *
 * ## Who sees money
 *
 * Prices, stock value and supplier dues are for the owner and for wardens who
 * may add expenses (`rights.money`). A storekeeper without that records what
 * moved and never sees what it cost.
 */

export class StockError extends Error {
  constructor(
    message: string,
    public errorCode: string,
    public status = 400,
  ) {
    super(message);
    this.name = "StockError";
  }
}

type Place = { id: string; isMain: boolean; name: string };

export type StockActor = {
  /** The building the request is about. */
  activeHostelId: Types.ObjectId;
  groupId: Types.ObjectId;
  /** Buildings this person may act for. */
  mine: string[];
  owner: boolean;
  /** The owner's Overall read: every building, nothing to act on. */
  overall: boolean;
  /** Every building in the group, for the Send picker. */
  places: Place[];
  principal: ApiPrincipal;
  rights: StockRights;
};

export type StockRights = {
  /** May approve a warden's Count (owner, or a warden with `approveStockCount`). */
  canApprove: boolean;
  /** May put money on a bill or pay a supplier: owner, or a warden with Add expenses. */
  canSpend: boolean;
  /** Sees prices, values and dues. Same people as `canSpend`. */
  money: boolean;
  proofRequired: boolean;
};

/**
 * Reached through `requireHostelCapability(…, "manageStock")`, which has already
 * narrowed a warden's `hostelIds` to the building they hold the grant for.
 *
 * Everyone, the owner included, acts for **the building the switcher chose** —
 * a branch's Stock never shows another branch's shelves. Only the owner's
 * Overall read passes `everyBuilding` and sees the whole group at once.
 */
export async function resolveStockActor(principal: ApiPrincipal, everyBuilding = false): Promise<StockActor> {
  const active = principal.hostelIds[0];

  if (!active || !Types.ObjectId.isValid(active)) {
    throw new StockError("Pick a hostel first.", "HOSTEL_SCOPE_REQUIRED", 422);
  }

  await connectToDatabase();

  const hostel = await HostelModel.findById(active)
    .select("parentHostelId")
    .lean<{ parentHostelId?: Types.ObjectId | null } | null>();

  if (!hostel) throw new StockError("Hostel not found.", "HOSTEL_NOT_FOUND", 404);

  const groupId = hostel.parentHostelId ?? new Types.ObjectId(active);
  const rows = await HostelModel.find({
    $or: [{ _id: groupId }, { parentHostelId: groupId }],
    isDeleted: { $ne: true },
  })
    .select("name parentHostelId createdAt")
    .sort({ createdAt: 1 })
    .lean<Array<{ _id: Types.ObjectId; name?: string; parentHostelId?: Types.ObjectId | null }>>();

  const places = rows
    .map((row) => ({ id: row._id.toString(), isMain: !row.parentHostelId, name: row.name ?? "Hostel" }))
    .sort((a, b) => Number(b.isMain) - Number(a.isMain));
  const owner = principal.role === Role.HOSTEL_ADMIN;
  const held = new Set(owner && everyBuilding ? (principal.allHostelIds ?? principal.hostelIds) : principal.hostelIds);

  return {
    activeHostelId: new Types.ObjectId(active),
    groupId,
    mine: places.filter((place) => held.has(place.id)).map((place) => place.id),
    overall: owner && everyBuilding,
    owner,
    places,
    principal,
    rights: await readRights(owner, active, principal.userId),
  };
}

/** What a warden may do beyond moving goods, read per request like every capability. */
async function readRights(owner: boolean, hostelId: string, userId: string): Promise<StockRights> {
  if (owner) return { canApprove: true, canSpend: true, money: true, proofRequired: false };

  const member = await HostelMemberModel.findOne({
    hostelId,
    isDeleted: { $ne: true },
    status: "ACTIVE",
    userId,
  })
    .select("permissions")
    .lean<{ permissions?: string[] } | null>();
  const permissions = member?.permissions ?? [];
  const canSpend = grantingPermissionKeys("recordExpenses").some((key) => permissions.includes(key));

  return {
    canApprove: grantingPermissionKeys("approveStockCount").some((key) => permissions.includes(key)),
    canSpend,
    money: canSpend,
    proofRequired: !permissions.includes("expenseWithoutProof"),
  };
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

type ItemDoc = {
  _id: Types.ObjectId;
  active: boolean;
  category?: string;
  kind: StockKind;
  location?: string;
  lowAt?: number | null;
  name: string;
  packSize?: number | null;
  packUnit?: StockUnit | null;
  unit: StockUnit;
};

type LineDoc = {
  itemId: Types.ObjectId;
  name: string;
  packQty?: number | null;
  packUnit?: StockUnit | null;
  qty: number;
  rate?: number | null;
  receivedQty?: number | null;
  systemQty?: number | null;
  unit: StockUnit;
};

type EntryDoc = {
  _id: Types.ObjectId;
  amount?: number | null;
  approvedByName?: string;
  billNo?: string;
  cancelReason?: string;
  createdAt: Date;
  discount?: number | null;
  expenseId?: Types.ObjectId | null;
  hostelId: Types.ObjectId;
  kind: StockEntryKind;
  lines: LineDoc[];
  note?: string;
  on: Date;
  paid?: number | null;
  photoAssetId?: Types.ObjectId | null;
  receivedAt?: Date;
  receivedByName?: string;
  recordedBy: Types.ObjectId;
  recordedByName?: string;
  status: StockEntryStatus;
  supplier?: string;
  supplierId?: Types.ObjectId | null;
  tax?: number | null;
  toHostelId?: Types.ObjectId | null;
  total?: number | null;
  useFor?: StockUseFor | null;
  wasteReason?: StockWasteReason | null;
};

type SupplierDoc = {
  _id: Types.ObjectId;
  active: boolean;
  createdAt: Date;
  name: string;
  note?: string;
  openingDue?: number;
  phone?: string;
};

type PaymentDoc = {
  _id: Types.ObjectId;
  amount: number;
  cancelReason?: string;
  createdAt: Date;
  expenseId?: Types.ObjectId | null;
  hostelId: Types.ObjectId;
  note?: string;
  on: Date;
  paidBy?: string;
  recordedBy: Types.ObjectId;
  recordedByName?: string;
  status: "CANCELLED" | "DONE";
  supplierId: Types.ObjectId;
};

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
  status: StockEntryStatus;
  supplier: string;
  toHostelId: string | null;
  toHostelName: string | null;
  useFor: StockUseFor | null;
  wasteReason: StockWasteReason | null;
};

type AtRow = Omit<ItemAtPlace, "countedAt"> & { countedAt: string | null; hostelId: string; low: boolean };

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

function dayKey(day: Date) {
  return day.toISOString().slice(0, 10);
}

/** Total and paid of a bill. Old bills kept only `amount` (all paid) or line rates. */
function billMoney(doc: EntryDoc) {
  const fromLines = doc.lines.reduce((sum, line) => sum + (line.rate ?? 0) * line.qty, 0);
  const total = doc.total ?? doc.amount ?? (fromLines > 0 ? Math.round(fromLines) : null);
  const paid = doc.paid ?? doc.amount ?? total;

  return total === null ? null : { paid: Math.min(paid ?? 0, total), total };
}

function serializeEntry(actor: StockActor, doc: EntryDoc): StockEntryRow {
  const names = new Map(actor.places.map((place) => [place.id, place.name]));
  const mine = doc.recordedBy.toString() === actor.principal.userId;
  const toHostelId = doc.toHostelId?.toString() ?? null;
  const money = actor.rights.money;
  const live = !actor.overall && doc.status !== "CANCELLED";
  const pendingCount = doc.kind === "COUNT" && doc.status === "PENDING";
  const canApprove =
    live && pendingCount && actor.rights.canApprove && actor.mine.includes(doc.hostelId.toString()) && (actor.owner || !mine);
  const bill = doc.kind === "BUY" ? billMoney(doc) : null;

  return {
    // A warden sees what they paid, not what the owner paid.
    amount: actor.owner || (mine && money) ? (doc.amount ?? null) : null,
    approvedByName: doc.approvedByName ?? null,
    bill:
      doc.kind === "BUY"
        ? {
            billNo: doc.billNo ?? "",
            discount: money ? (doc.discount ?? 0) : null,
            due: money && bill ? bill.total - bill.paid : null,
            paid: money && bill ? bill.paid : null,
            photoAssetId: doc.photoAssetId?.toString() ?? null,
            status: money && bill ? billStatus(bill.total, bill.paid) : null,
            supplierId: doc.supplierId?.toString() ?? null,
            tax: money ? (doc.tax ?? 0) : null,
            total: money && bill ? bill.total : null,
          }
        : null,
    canApprove,
    canCancel:
      live &&
      (actor.owner ||
        canApprove ||
        (mine && !(doc.kind === "SEND" && doc.status === "RECEIVED") && !(doc.kind === "COUNT" && doc.status === "DONE" && !pendingCount))),
    canReceive: !actor.overall && doc.status === "PENDING" && doc.kind === "SEND" && toHostelId !== null && actor.mine.includes(toHostelId),
    cancelReason: doc.cancelReason ?? null,
    createdAt: doc.createdAt.toISOString(),
    hostelId: doc.hostelId.toString(),
    hostelName: names.get(doc.hostelId.toString()) ?? "Hostel",
    id: doc._id.toString(),
    kind: doc.kind,
    lines: doc.lines.map((line) => ({
      amount: money && line.rate != null && doc.kind === "BUY" ? Math.round(line.rate * line.qty) : null,
      itemId: line.itemId.toString(),
      name: line.name,
      packQty: line.packQty ?? null,
      packUnit: line.packUnit ?? null,
      qty: line.qty,
      rate: money ? (line.rate ?? null) : null,
      receivedQty: line.receivedQty ?? null,
      systemQty: line.systemQty ?? null,
      unit: line.unit,
    })),
    mine,
    note: doc.note ?? "",
    on: dayKey(doc.on),
    receivedAt: doc.receivedAt?.toISOString() ?? null,
    receivedByName: doc.receivedByName ?? null,
    recordedByName: doc.recordedByName || "Staff",
    status: doc.status,
    supplier: doc.supplier ?? "",
    toHostelId,
    toHostelName: toHostelId ? (names.get(toHostelId) ?? "Hostel") : null,
    useFor: doc.useFor ?? null,
    wasteReason: doc.wasteReason ?? null,
  };
}

function resolvePeriod(requested?: string) {
  const current = currentBsPeriod();

  if (!requested || !isBsPeriod(requested) || requested > current) return current;

  try {
    bsPeriodBounds(requested);
  } catch {
    return current;
  }

  return requested;
}

function toFoldEntry(doc: EntryDoc, period: string): FoldEntry {
  const entryPeriod = hostelPeriodOf(doc.on);

  return {
    createdAt: doc.createdAt,
    hostelId: doc.hostelId.toString(),
    kind: doc.kind,
    lines: doc.lines.map((line) => ({
      itemId: line.itemId.toString(),
      qty: line.qty,
      rate: line.rate ?? null,
      receivedQty: line.receivedQty ?? null,
      systemQty: line.systemQty ?? null,
    })),
    receivedAt: doc.receivedAt ?? null,
    status: doc.status,
    toHostelId: doc.toHostelId?.toString() ?? null,
    when: entryPeriod < period ? "before" : entryPeriod > period ? "after" : "in",
  };
}

/** The whole group's book, folded for `places`. */
async function readBook(actor: StockActor, places: readonly string[], period = currentBsPeriod()) {
  const [items, docs] = await Promise.all([
    StockItemModel.find({ groupHostelId: actor.groupId }).sort({ active: -1, name: 1 }).lean<ItemDoc[]>(),
    // ponytail: the group's whole history is folded in memory; a busy group adds
    // a few hundred entries a month. Aggregate in Mongo past ~20k entries.
    StockEntryModel.find({ groupHostelId: actor.groupId }).sort({ createdAt: 1 }).lean<EntryDoc[]>(),
  ]);
  const kinds = new Map(items.map((item) => [item._id.toString(), item.kind]));
  const fold = foldStock(
    docs.map((doc) => toFoldEntry(doc, period)),
    kinds,
    places,
  );

  return { docs, fold, items };
}

/** What the book says is left of each item in one building now. */
async function leftAt(actor: StockActor, hostelId: string) {
  const { fold, items } = await readBook(actor, [hostelId]);

  return {
    items,
    left: new Map(items.map((item) => [item._id.toString(), fold.byItem.get(item._id.toString())?.get(hostelId)?.left ?? 0])),
  };
}

/* -------------------------------------------------------------------------- */
/* The screen's one read                                                      */
/* -------------------------------------------------------------------------- */

export async function getStockHome(actor: StockActor, requestedPeriod?: string): Promise<StockHome> {
  await connectToDatabase();

  const period = resolvePeriod(requestedPeriod);
  const money = actor.rights.money;
  const [{ docs, fold, items }, suppliers, payments, residents] = await Promise.all([
    readBook(actor, actor.mine, period),
    StockSupplierModel.find({ groupHostelId: actor.groupId }).sort({ active: -1, name: 1 }).lean<SupplierDoc[]>(),
    money
      ? StockPaymentModel.find({ groupHostelId: actor.groupId, status: "DONE" }).lean<PaymentDoc[]>()
      : Promise.resolve([] as PaymentDoc[]),
    Promise.all(
      actor.mine.map((id) =>
        ResidentModel.countDocuments({ hostelId: id, isDeleted: false, status: { $ne: "MOVED_OUT" } }),
      ),
    ),
  ]);

  const mine = new Set(actor.mine);
  const touchesMine = (doc: EntryDoc) =>
    mine.has(doc.hostelId.toString()) || (doc.toHostelId ? mine.has(doc.toHostelId.toString()) : false);
  const visible = docs.filter(touchesMine);
  const residentsById = new Map(actor.mine.map((id, index) => [id, residents[index] ?? 0]));

  const itemRows: StockItemRow[] = items.map((item) => {
    const id = item._id.toString();
    const byPlace = fold.byItem.get(id);
    const avgCost = fold.avgCost.get(id) ?? null;
    const at = actor.mine.map((hostelId): AtRow => {
      const row = byPlace?.get(hostelId) ?? emptyAtPlace();
      const hidden = money ? {} : { adjustedValue: 0, boughtValue: 0, usedValue: 0, wastedValue: 0 };

      return {
        ...row,
        ...hidden,
        countedAt: row.countedAt?.toISOString() ?? null,
        hostelId,
        low: item.kind === "STORE" && item.active && item.lowAt != null && row.left < item.lowAt,
      };
    });
    const leftHere = at.reduce((sum, row) => sum + Math.max(0, row.left), 0);

    return {
      active: item.active,
      at,
      avgCost: money ? avgCost : null,
      category: item.category ?? "GROCERIES",
      id,
      kind: item.kind,
      location: item.location ?? "",
      lowAt: item.lowAt ?? null,
      name: item.name,
      packSize: item.packSize ?? null,
      packUnit: item.packUnit ?? null,
      unit: item.unit,
      value: money ? (avgCost !== null && item.kind === "STORE" ? Math.round(leftHere * avgCost) : 0) : null,
    };
  });

  /* ------------------------------------------------------------ suppliers */

  const supplierRows: StockSupplierRow[] = suppliers.map((supplier) => {
    const id = supplier._id.toString();
    const bills = docs.filter((doc) => doc.kind === "BUY" && doc.status !== "CANCELLED" && doc.supplierId?.toString() === id);
    const ledger = supplierLedger(
      supplier.openingDue ?? 0,
      bills.map((doc) => {
        const bill = billMoney(doc) ?? { paid: 0, total: 0 };

        return { createdAt: doc.createdAt, id: doc._id.toString(), on: doc.on, paid: bill.paid, status: doc.status, total: bill.total };
      }),
      payments
        .filter((payment) => payment.supplierId.toString() === id)
        .map((payment) => ({
          amount: payment.amount,
          createdAt: payment.createdAt,
          id: payment._id.toString(),
          on: payment.on,
          status: payment.status,
        })),
      supplier.createdAt,
    );
    const last = bills.reduce<Date | null>((latest, doc) => (!latest || doc.on > latest ? doc.on : latest), null);

    return {
      active: supplier.active,
      bills: bills.length,
      billed: money ? ledger.billed : null,
      due: money ? ledger.due : null,
      id,
      lastBillOn: last ? dayKey(last) : null,
      name: supplier.name,
      note: supplier.note ?? "",
      openingDue: money ? (supplier.openingDue ?? 0) : null,
      phone: supplier.phone ?? "",
    };
  });

  /* -------------------------------------------------------------- summary */

  const inPeriod = visible.filter((doc) => hostelPeriodOf(doc.on) === period);
  const sum = (pick: (row: AtRow) => number, kind?: StockKind) =>
    itemRows.filter((item) => !kind || item.kind === kind).reduce((total, item) => total + item.at.reduce((inner, row) => inner + pick(row), 0), 0);
  const usedValue = sum((row) => row.usedValue);
  const wastedValue = sum((row) => row.wastedValue);
  const missingValue = sum((row) => Math.max(0, -row.adjustedValue));
  const residentsTotal = [...residentsById.values()].reduce((total, count) => total + count, 0);
  const bounds = bsPeriodBounds(period);
  const days =
    period === currentBsPeriod()
      ? Math.max(1, Math.floor((hostelToday().getTime() - bounds.start.getTime()) / 86_400_000) + 1)
      : bounds.daysInMonth;
  const spentValue = usedValue + wastedValue + missingValue;
  const categories = new Map<string, { stockValue: number; usedValue: number }>();

  for (const item of itemRows) {
    const bucket = categories.get(item.category) ?? { stockValue: 0, usedValue: 0 };

    bucket.stockValue += item.value ?? 0;
    bucket.usedValue += item.at.reduce((total, row) => total + row.usedValue + row.wastedValue, 0);
    categories.set(item.category, bucket);
  }

  const supplierNames = new Map(suppliers.map((supplier) => [supplier._id.toString(), supplier.name]));
  const bySupplier = new Map<string, StockSummary["bySupplier"][number]>();

  for (const doc of inPeriod) {
    if (doc.kind !== "BUY" || doc.status === "CANCELLED" || !mine.has(doc.hostelId.toString())) continue;

    const bill = billMoney(doc);

    if (!bill) continue;

    const supplierId = doc.supplierId?.toString() ?? null;
    const key = supplierId ?? `name:${(doc.supplier ?? "").toLowerCase()}`;
    const bucket = bySupplier.get(key) ?? {
      bills: 0,
      billed: 0,
      name: (supplierId && supplierNames.get(supplierId)) || doc.supplier || "No supplier",
      paid: 0,
      supplierId,
    };

    bucket.bills += 1;
    bucket.billed += bill.total;
    bucket.paid += bill.paid;
    bySupplier.set(key, bucket);
  }

  const summary: StockSummary = {
    boughtValue: money ? sum((row) => row.boughtValue) : null,
    byCategory: money
      ? [...categories]
          .map(([category, bucket]) => ({ category, ...bucket }))
          .filter((row) => row.stockValue > 0 || row.usedValue > 0)
          .sort((a, b) => b.stockValue + b.usedValue - (a.stockValue + a.usedValue))
      : [],
    bySupplier: money ? [...bySupplier.values()].sort((a, b) => b.billed - a.billed) : [],
    costPerResidentDay: money && residentsTotal > 0 ? Math.round(spentValue / (residentsTotal * days)) : null,
    days,
    dueTotal: money ? supplierRows.reduce((total, row) => total + Math.max(0, row.due ?? 0), 0) : null,
    low: itemRows.filter((item) => item.at.some((row) => row.low)).length,
    missingValue: money ? missingValue : null,
    residents: residentsTotal,
    spentValue: money ? spentValue : null,
    stockValue: money ? itemRows.reduce((total, item) => total + (item.value ?? 0), 0) : null,
    usedValue: money ? usedValue : null,
    wastedValue: money ? wastedValue : null,
  };

  /* ---------------------------------------------------------- recent use */

  const storeIds = new Set(items.filter((item) => item.active && item.kind === "STORE").map((item) => item._id.toString()));
  const useCounts = new Map<string, number>();

  for (const doc of visible.slice(-200)) {
    if (doc.status === "CANCELLED" || (doc.kind !== "USE" && doc.kind !== "BUY")) continue;

    for (const line of doc.lines) {
      const id = line.itemId.toString();

      if (storeIds.has(id)) useCounts.set(id, (useCounts.get(id) ?? 0) + (doc.kind === "USE" ? 3 : 1));
    }
  }

  return {
    ...actor.rights,
    currentPeriod: currentBsPeriod(),
    entries: inPeriod
      .sort((a, b) => b.on.getTime() - a.on.getTime() || b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 300)
      .map((doc) => serializeEntry(actor, doc)),
    items: itemRows,
    owner: actor.owner,
    period,
    places: actor.places.map((place) => ({
      ...place,
      mine: mine.has(place.id),
      residents: residentsById.get(place.id) ?? null,
    })),
    recentUse: [...useCounts].sort((a, b) => b[1] - a[1]).map(([id]) => id),
    sentWaiting: visible
      .filter((doc) => doc.kind === "SEND" && doc.status === "PENDING" && mine.has(doc.hostelId.toString()))
      .reverse()
      .map((doc) => serializeEntry(actor, doc)),
    summary,
    suppliers: supplierRows,
    toApprove: visible
      .filter((doc) => doc.kind === "COUNT" && doc.status === "PENDING")
      .map((doc) => serializeEntry(actor, doc))
      .filter((row) => row.canApprove),
    waiting: visible
      .filter((doc) => doc.kind === "SEND" && doc.status === "PENDING" && doc.toHostelId && mine.has(doc.toHostelId.toString()))
      .reverse()
      .map((doc) => serializeEntry(actor, doc)),
  };
}

/* -------------------------------------------------------------------------- */
/* Movements                                                                  */
/* -------------------------------------------------------------------------- */

function assertMine(actor: StockActor, hostelId: string, message: string) {
  if (!actor.mine.includes(hostelId)) {
    throw new StockError(message, "CAPABILITY_DENIED", 403);
  }
}

async function userName(userId: string) {
  const user = await UserModel.findById(userId).select("name").lean<{ name?: string } | null>();

  return user?.name ?? "";
}

/** `Rice 25 kg, Daal 10 kg`, or with a prefix: `Local Store: Rice 25 kg`. Fits an expense's `what`. */
function lineSummary(lines: { name: string; qty: number; unit: StockUnit }[], prefix = "") {
  const text = prefix + lines.map((line) => `${line.name} ${formatQty(line.qty, line.unit)}`).join(", ");

  return text.length > EXPENSE_WHAT_MAX ? `${text.slice(0, EXPENSE_WHAT_MAX - 1)}…` : text;
}

function isDuplicateKeyError(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;
}

async function existingByRequest(actor: StockActor, clientRequestId?: string) {
  if (!clientRequestId) return null;

  return StockEntryModel.findOne({
    clientRequestId,
    groupHostelId: actor.groupId,
    recordedBy: new Types.ObjectId(actor.principal.userId),
  }).lean<EntryDoc | null>();
}

function changed(...hostelIds: (string | null | undefined)[]) {
  return publishResourceChange({ hostelIds, topics: [REALTIME_TOPIC.FOOD] }).catch(() => undefined);
}

/**
 * Filed under `STOCK`, not `GENERAL`, so the bell can show stock on its own.
 * "On the way" and "Count to approve" wait for an answer (`waits`); the rest is
 * news. Waiting rows are cleared for everyone once answered (`settleStockBells`).
 */
async function notifyQuietly(
  userIds: string[],
  title: string,
  body: string,
  hostelId: string,
  entryId: string,
  waits = false,
) {
  await Promise.all(
    [...new Set(userIds)].map((userId) =>
      createInAppNotification({
        actionUrl: "/hostel-admin/stock",
        body,
        category: "STOCK",
        data: { entryId, type: "STOCK" },
        hostelId,
        kind: waits ? "ACTION" : "NORMAL",
        title,
        userId,
      }).catch((error) => console.warn("stock_notification_failed", entryId, error)),
    ),
  );
}

async function settleStockBells(entryId: string, answer: string) {
  await settleActionNotifications({ category: "STOCK", data: { entryId } }, answer).catch(() => undefined);
}

/** The owner and every warden of the building holding `permission` (Got it, low stock, approvals). */
async function receivers(hostelId: string, permission: "approveStockCount" | "manageStock" = "manageStock") {
  const [hostel, wardens] = await Promise.all([
    HostelModel.findById(hostelId).select("ownerId").lean<{ ownerId?: Types.ObjectId } | null>(),
    HostelMemberModel.find({
      hostelId,
      isDeleted: { $ne: true },
      permissions: { $in: grantingPermissionKeys(permission) },
      role: Role.WARDEN,
      status: "ACTIVE",
    })
      .select("userId")
      .lean<{ userId: Types.ObjectId }[]>(),
  ]);

  return [hostel?.ownerId?.toString(), ...wardens.map((row) => row.userId.toString())].filter(
    (id): id is string => Boolean(id),
  );
}

/**
 * A push the moment an item **crosses** its low mark in a building — not on
 * every Use after, which would teach people to swipe it away.
 */
async function warnIfLow(
  actor: StockActor,
  hostelId: string,
  items: readonly ItemDoc[],
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
  entryId: string,
) {
  const crossed = items.filter((item) => {
    const id = item._id.toString();
    const was = before.get(id);
    const now = after.get(id);

    return (
      item.kind === "STORE" &&
      item.lowAt != null &&
      was !== undefined &&
      now !== undefined &&
      was >= item.lowAt &&
      now < item.lowAt
    );
  });

  if (crossed.length === 0) return;

  const place = actor.places.find((entry) => entry.id === hostelId)?.name ?? "the hostel";

  await notifyQuietly(
    await receivers(hostelId),
    crossed.length === 1 ? `${crossed[0]!.name} is running low` : "Stock running low",
    `${crossed
      .map((item) => `${item.name}: ${formatQty(Math.max(0, after.get(item._id.toString()) ?? 0), item.unit)} left`)
      .join(", ")} in ${place}. Buy more soon.`,
    hostelId,
    entryId,
  );
}

type MergedLine = { amount: number | null; packQty: number | null; qty: number; rate: number | null };

export async function createStockEntry(actor: StockActor, input: CreateStockEntryInput) {
  await connectToDatabase();

  const existing = await existingByRequest(actor, input.clientRequestId);

  if (existing) return { duplicate: true, entry: serializeEntry(actor, existing) };

  if (actor.overall) throw new StockError("Overall only shows. Pick a building to add stock.", "OVERALL_READ_ONLY", 422);

  const main = actor.places.find((place) => place.isMain)?.id;
  const fallback =
    actor.owner && input.kind === "BUY" && main && actor.mine.includes(main)
      ? main
      : actor.mine.includes(actor.activeHostelId.toString())
        ? actor.activeHostelId.toString()
        : actor.mine[0];
  const hostelId = input.hostelId ?? fallback;

  if (!hostelId) throw new StockError("You do not look after any building here.", "CAPABILITY_DENIED", 403);

  assertMine(actor, hostelId, "You can only add stock for your own building.");

  if (input.kind === "OPENING" && !actor.owner) {
    throw new StockError("Only the owner can add opening stock.", "CAPABILITY_DENIED", 403);
  }

  let toHostelId: string | null = null;

  if (input.kind === "SEND") {
    toHostelId = input.toHostelId ?? null;

    if (!toHostelId || toHostelId === hostelId || !actor.places.some((place) => place.id === toHostelId)) {
      throw new StockError("Pick another building of this hostel to send to.", "INVALID_DESTINATION", 422);
    }
  }

  const on = parseSpentOn(input.on);
  const lineIds = input.lines.map((line) => new Types.ObjectId(line.itemId));
  const incoming = input.kind === "BUY" || input.kind === "OPENING";

  /*
   * Buying a switched-off item switches it back on. Its name stays taken while
   * it is off, so the app's Add stock — which matches what was typed to an
   * existing item — would otherwise have nowhere to put it.
   */
  if (incoming) {
    await StockItemModel.updateMany(
      { _id: { $in: lineIds }, active: false, groupHostelId: actor.groupId },
      { $set: { active: true } },
    );
  }

  const items = await StockItemModel.find({
    _id: { $in: lineIds },
    active: true,
    groupHostelId: actor.groupId,
  }).lean<ItemDoc[]>();
  const byId = new Map(items.map((item) => [item._id.toString(), item]));

  // One line per item: two rows of Rice on one entry are one Rice.
  const merged = new Map<string, MergedLine>();

  for (const line of input.lines) {
    const item = byId.get(line.itemId);

    if (!item) throw new StockError("One of the items is not there any more. Pick again.", "ITEM_NOT_FOUND", 404);

    if (item.kind === "DAILY" && (input.kind === "COUNT" || input.kind === "USE" || input.kind === "WASTE")) {
      throw new StockError(
        `${item.name} is a daily item. It is used the day it comes, so it is not ${input.kind === "COUNT" ? "counted" : "entered again"}.`,
        "DAILY_NOT_TRACKED",
        422,
      );
    }

    const inPacks = line.packQty !== undefined && item.packUnit && item.packSize;
    const qty = inPacks ? line.packQty! * item.packSize! : line.qty;
    const before = merged.get(line.itemId);

    if (input.kind === "COUNT" || !before) {
      merged.set(line.itemId, {
        amount: line.amount ?? null,
        packQty: inPacks ? line.packQty! : null,
        qty,
        rate: line.rate ?? null,
      });
    } else {
      merged.set(line.itemId, {
        amount: before.amount !== null || line.amount !== undefined ? (before.amount ?? 0) + (line.amount ?? 0) : null,
        packQty: before.packQty !== null && inPacks ? before.packQty + line.packQty! : null,
        qty: before.qty + qty,
        rate: line.rate ?? before.rate,
      });
    }
  }

  /* --------------------------------------------------- the book, before */

  const needsBook = input.kind === "COUNT" || input.kind === "USE" || input.kind === "WASTE" || input.kind === "SEND";
  const book = needsBook ? await leftAt(actor, hostelId) : null;

  const lines = [...merged].map(([itemId, line]) => {
    const item = byId.get(itemId)!;
    const qty = roundQty(line.qty);
    const money = actor.rights.money && incoming;
    const rate =
      money && line.amount !== null && qty > 0
        ? Math.round((line.amount / qty) * 100) / 100
        : money
          ? line.rate
          : null;

    return {
      itemId: item._id,
      name: item.name,
      packQty: line.packQty,
      packUnit: line.packQty !== null ? (item.packUnit ?? null) : null,
      qty,
      rate,
      receivedQty: null,
      systemQty: input.kind === "COUNT" ? roundQty(book?.left.get(itemId) ?? 0) : null,
      unit: item.unit,
    };
  });

  /* ---------------------------------------------------------------- Count */

  let status: StockEntryStatus = input.kind === "SEND" ? "PENDING" : "DONE";

  if (input.kind === "COUNT") {
    const differs = lines.some((line) => line.qty !== line.systemQty);

    if (differs && !input.note?.trim()) {
      throw new StockError("The count is different from the book. Say why.", "COUNT_REASON_REQUIRED", 422);
    }

    // Nothing to approve when the shelf agrees with the book.
    if (differs && !actor.rights.canApprove) status = "PENDING";
  }

  /* -------------------------------------------------------- Bought: money */

  let supplierDoc: SupplierDoc | null = null;

  if (input.supplierId && input.kind === "BUY") {
    supplierDoc = await StockSupplierModel.findOne({
      _id: new Types.ObjectId(input.supplierId),
      groupHostelId: actor.groupId,
    }).lean<SupplierDoc | null>();

    if (!supplierDoc) throw new StockError("That supplier is not in the list any more.", "SUPPLIER_NOT_FOUND", 404);
  }

  const supplier = input.kind === "BUY" ? supplierDoc?.name ?? (input.supplier?.trim() || undefined) : undefined;
  let total: number | null = null;
  let paid: number | null = null;
  let expenseId: Types.ObjectId | null = null;

  if (input.kind === "BUY") {
    const subtotal = [...merged.values()].reduce(
      (sum, line) => sum + (line.amount ?? (line.rate !== null ? Math.round(line.rate * line.qty) : 0)),
      0,
    );
    const gross = subtotal > 0 ? subtotal : (input.amount ?? 0);
    const discount = input.discount ?? 0;
    const tax = input.tax ?? 0;

    if (gross > 0 || discount > 0 || tax > 0) {
      if (!actor.rights.canSpend) {
        throw new StockError(
          "Your account cannot add prices. Leave the prices empty, or ask the owner to turn on Add expenses.",
          "CAPABILITY_DENIED",
          403,
        );
      }

      if (discount > gross + tax) throw new StockError("The discount is more than the bill.", "INVALID_DISCOUNT", 422);

      total = gross - discount + tax;
      paid = Math.min(input.paid ?? total, total);

      if (paid < total && !supplierDoc) {
        throw new StockError("Pick the supplier you still owe.", "SUPPLIER_REQUIRED", 422);
      }
    }

    if (paid && paid > 0) {
      const expenseActor: ExpenseActor = {
        canSeeAll: actor.owner,
        hostelId: actor.activeHostelId,
        principal: actor.principal,
        role: actor.owner ? "HOSTEL_ADMIN" : "WARDEN",
      };
      const first = byId.get(lines[0]!.itemId.toString());
      const prefix = [supplier, input.billNo ? `bill ${input.billNo}` : null].filter(Boolean).join(" · ");
      const { expense } = await createExpense(expenseActor, {
        amount: paid,
        category: (first?.category ?? "GROCERIES") as CreateExpenseInput["category"],
        clientRequestId: input.clientRequestId ? `stock:${input.clientRequestId}`.slice(0, 64) : undefined,
        paidBy: input.paidBy,
        photoAssetId: input.photoAssetId,
        spentOn: input.on,
        what: lineSummary(lines, prefix ? `${prefix}: ` : ""),
      });

      expenseId = new Types.ObjectId(expense.id);
    }
  }

  /* ----------------------------------------------------------------- save */

  let doc: EntryDoc;
  const recordedByName = await userName(actor.principal.userId);

  try {
    const created = await StockEntryModel.create({
      amount: expenseId ? paid : null,
      ...(status === "DONE" && input.kind === "COUNT"
        ? { approvedAt: new Date(), approvedBy: new Types.ObjectId(actor.principal.userId), approvedByName: recordedByName }
        : {}),
      billNo: input.kind === "BUY" ? input.billNo : undefined,
      clientRequestId: input.clientRequestId ?? null,
      discount: input.kind === "BUY" && total !== null ? (input.discount ?? 0) : 0,
      expenseId,
      groupHostelId: actor.groupId,
      hostelId: new Types.ObjectId(hostelId),
      kind: input.kind,
      lines,
      note: input.note,
      on,
      paid,
      photoAssetId: input.kind === "BUY" && input.photoAssetId ? new Types.ObjectId(input.photoAssetId) : null,
      recordedBy: new Types.ObjectId(actor.principal.userId),
      recordedByName,
      status,
      supplier,
      supplierId: supplierDoc?._id ?? null,
      tax: input.kind === "BUY" && total !== null ? (input.tax ?? 0) : 0,
      toHostelId: toHostelId ? new Types.ObjectId(toHostelId) : null,
      total,
      useFor: input.kind === "USE" ? (input.useFor ?? "KITCHEN") : null,
      wasteReason: input.kind === "WASTE" ? (input.wasteReason ?? "OTHER") : null,
    });

    doc = created.toObject() as EntryDoc;
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const raced = await existingByRequest(actor, input.clientRequestId);

      if (raced) return { duplicate: true, entry: serializeEntry(actor, raced) };
    }

    throw error;
  }

  const entryId = doc._id.toString();

  /* ---------------------------------------------------------------- tell */

  if (toHostelId) {
    const from = actor.places.find((place) => place.id === hostelId)?.name ?? "the other building";

    await notifyQuietly(
      (await receivers(toHostelId)).filter((id) => id !== actor.principal.userId),
      "Stock on the way",
      `${lineSummary(lines)} from ${from}. Tap Got it when it comes.`,
      toHostelId,
      entryId,
      true,
    );
  }

  if (input.kind === "COUNT" && status === "PENDING") {
    await notifyQuietly(
      (await receivers(hostelId, "approveStockCount")).filter((id) => id !== actor.principal.userId),
      "Count to approve",
      `${recordedByName || "Staff"} counted ${lines.length} item${lines.length === 1 ? "" : "s"}. Some are different from the book.`,
      hostelId,
      entryId,
      true,
    );
  }

  if (book && status === "DONE" && input.kind !== "SEND") {
    const after = new Map(book.left);

    for (const line of lines) {
      const id = line.itemId.toString();
      const was = book.left.get(id) ?? 0;

      after.set(id, input.kind === "COUNT" ? line.qty : was - line.qty);
    }

    await warnIfLow(actor, hostelId, items, book.left, after, entryId);
  } else if (book && input.kind === "SEND") {
    const after = new Map([...book.left].map(([id, left]) => [id, left - (merged.get(id)?.qty ?? 0)]));

    await warnIfLow(actor, hostelId, items, book.left, after, entryId);
  }

  await changed(hostelId, toHostelId);

  return { duplicate: false, entry: serializeEntry(actor, doc) };
}

/**
 * Got it. Lines left out arrived in full; a line with less is "short". Only
 * someone who acts for the receiving building, and only once.
 */
export async function receiveStock(
  actor: StockActor,
  entryId: string,
  input: { lines?: { itemId: string; receivedQty: number }[] },
) {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(entryId)) throw new StockError("Not found.", "ENTRY_NOT_FOUND", 404);

  const doc = await StockEntryModel.findOne({
    _id: new Types.ObjectId(entryId),
    groupHostelId: actor.groupId,
    kind: "SEND",
  }).lean<EntryDoc | null>();

  if (!doc || !doc.toHostelId || !actor.mine.includes(doc.toHostelId.toString())) {
    throw new StockError("Not found.", "ENTRY_NOT_FOUND", 404);
  }

  if (doc.status !== "PENDING") {
    throw new StockError("This was already answered.", "ENTRY_NOT_PENDING", 409);
  }

  const got = new Map((input.lines ?? []).map((line) => [line.itemId, roundQty(line.receivedQty)]));
  const lines = doc.lines.map((line) => ({
    ...line,
    receivedQty: got.get(line.itemId.toString()) ?? line.qty,
  }));
  const updated = await StockEntryModel.findOneAndUpdate(
    { _id: doc._id, status: "PENDING" },
    {
      $set: {
        lines,
        receivedAt: new Date(),
        receivedBy: new Types.ObjectId(actor.principal.userId),
        receivedByName: await userName(actor.principal.userId),
        status: "RECEIVED",
      },
    },
    { new: true },
  ).lean<EntryDoc | null>();

  if (!updated) throw new StockError("This was already answered.", "ENTRY_NOT_PENDING", 409);

  const place = actor.places.find((entry) => entry.id === doc.toHostelId?.toString())?.name ?? "The branch";
  const short = lines.filter((line) => line.receivedQty < line.qty);

  await settleStockBells(entryId, "GOT_IT");

  if (updated.recordedBy.toString() !== actor.principal.userId) {
    await notifyQuietly(
      [updated.recordedBy.toString()],
      short.length > 0 ? "Less stock came" : "Stock received",
      short.length > 0
        ? `${place} got ${short
            .map((line) => `${formatQty(line.receivedQty, line.unit)} of ${formatQty(line.qty, line.unit)} ${line.name}`)
            .join(", ")}.`
        : `${place} got ${lineSummary(lines)}.`,
      doc.hostelId.toString(),
      doc._id.toString(),
    );
  }

  await changed(doc.hostelId.toString(), doc.toHostelId.toString());

  return serializeEntry(actor, updated);
}

/**
 * Approve a warden's Count: only now does the gap from the book move the stock.
 * The owner, or a warden allowed to approve counts — never one's own.
 */
export async function approveStockCount(actor: StockActor, entryId: string) {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(entryId)) throw new StockError("Not found.", "ENTRY_NOT_FOUND", 404);

  const doc = await StockEntryModel.findOne({
    _id: new Types.ObjectId(entryId),
    groupHostelId: actor.groupId,
    kind: "COUNT",
  }).lean<EntryDoc | null>();

  if (!doc) throw new StockError("Not found.", "ENTRY_NOT_FOUND", 404);
  if (doc.status !== "PENDING") throw new StockError("This was already answered.", "ENTRY_NOT_PENDING", 409);
  if (!serializeEntry(actor, doc).canApprove) {
    throw new StockError("You cannot approve this count.", "CAPABILITY_DENIED", 403);
  }

  const hostelId = doc.hostelId.toString();
  const book = await leftAt(actor, hostelId);
  const name = await userName(actor.principal.userId);
  const updated = await StockEntryModel.findOneAndUpdate(
    { _id: doc._id, status: "PENDING" },
    {
      $set: {
        approvedAt: new Date(),
        approvedBy: new Types.ObjectId(actor.principal.userId),
        approvedByName: name,
        status: "DONE",
      },
    },
    { new: true },
  ).lean<EntryDoc | null>();

  if (!updated) throw new StockError("This was already answered.", "ENTRY_NOT_PENDING", 409);

  const after = new Map(book.left);

  for (const line of doc.lines) {
    const id = line.itemId.toString();

    after.set(id, (book.left.get(id) ?? 0) + line.qty - (line.systemQty ?? line.qty));
  }

  await settleStockBells(entryId, "APPROVED");
  await notifyQuietly([doc.recordedBy.toString()], "Count approved", `${name || "The owner"} approved your count.`, hostelId, entryId);
  await warnIfLow(
    actor,
    hostelId,
    book.items.filter((item) => doc.lines.some((line) => line.itemId.equals(item._id))),
    book.left,
    after,
    entryId,
  );
  await changed(hostelId);

  return serializeEntry(actor, updated);
}

/**
 * A mistake is cancelled, never deleted. A Bought takes its expense with it. A
 * Count waiting for approval is turned down the same way, with the reason.
 */
export async function cancelStockEntry(actor: StockActor, entryId: string, reason: string) {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(entryId)) throw new StockError("Not found.", "ENTRY_NOT_FOUND", 404);

  const doc = await StockEntryModel.findOne({
    _id: new Types.ObjectId(entryId),
    groupHostelId: actor.groupId,
  }).lean<EntryDoc | null>();

  if (!doc || !serializeEntry(actor, doc).canCancel) {
    throw new StockError("You cannot cancel this.", "ENTRY_NOT_CANCELLABLE", 404);
  }

  if (doc.expenseId) {
    const expense = await ExpenseModel.findById(doc.expenseId)
      .select("hostelId")
      .lean<{ hostelId: Types.ObjectId } | null>();

    if (expense) {
      try {
        await voidExpense(
          {
            canSeeAll: actor.owner,
            hostelId: expense.hostelId,
            principal: actor.principal,
            role: actor.owner ? "HOSTEL_ADMIN" : "WARDEN",
          },
          doc.expenseId.toString(),
          reason,
        );
      } catch (error) {
        // Already cancelled from the Expenses screen — the stock entry still goes.
        if (!(error instanceof ExpenseError && error.errorCode === "EXPENSE_ALREADY_VOID")) throw error;
      }
    }
  }

  const updated = await StockEntryModel.findOneAndUpdate(
    { _id: doc._id, status: { $ne: "CANCELLED" } },
    {
      $set: {
        cancelReason: reason,
        cancelledAt: new Date(),
        cancelledBy: new Types.ObjectId(actor.principal.userId),
        status: "CANCELLED",
      },
    },
    { new: true },
  ).lean<EntryDoc | null>();

  if (!updated) throw new StockError("This is already cancelled.", "ENTRY_NOT_CANCELLABLE", 409);

  await settleStockBells(doc._id.toString(), "CANCEL");

  if (doc.kind === "COUNT" && doc.status === "PENDING" && doc.recordedBy.toString() !== actor.principal.userId) {
    await notifyQuietly(
      [doc.recordedBy.toString()],
      "Count not approved",
      reason,
      doc.hostelId.toString(),
      doc._id.toString(),
    );
  }

  await changed(doc.hostelId.toString(), doc.toHostelId?.toString());

  return serializeEntry(actor, updated);
}

/* -------------------------------------------------------------------------- */
/* Items                                                                      */
/* -------------------------------------------------------------------------- */

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function assertNameFree(actor: StockActor, name: string, exceptId?: Types.ObjectId) {
  const clash = await StockItemModel.exists({
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
    groupHostelId: actor.groupId,
    name: { $options: "i", $regex: `^${escapeRegex(name)}$` },
  });

  if (clash) throw new StockError(`${name} is already in the list.`, "ITEM_NAME_TAKEN", 409);
}

function serializeItemOnly(item: ItemDoc) {
  return {
    active: item.active,
    category: item.category ?? "GROCERIES",
    id: item._id.toString(),
    kind: item.kind,
    location: item.location ?? "",
    lowAt: item.lowAt ?? null,
    name: item.name,
    packSize: item.packSize ?? null,
    packUnit: item.packUnit ?? null,
    unit: item.unit,
  };
}

/** A pack is a unit *and* a size, never one without the other, and never the item's own unit. */
function packOf(input: { packSize?: number | null; packUnit?: StockUnit | null }, unit: StockUnit) {
  if (!input.packUnit || !input.packSize || input.packUnit === unit) return { packSize: null, packUnit: null };

  return { packSize: input.packSize, packUnit: input.packUnit };
}

/** Anyone who handles stock can add an item: it is usually added standing at the shop. */
export async function createStockItem(actor: StockActor, input: CreateStockItemInput) {
  await connectToDatabase();

  if ((await StockItemModel.countDocuments({ groupHostelId: actor.groupId })) >= STOCK_ITEM_LIMIT) {
    throw new StockError("The list is full. Switch off an item you no longer buy.", "ITEM_LIMIT", 422);
  }

  await assertNameFree(actor, input.name);

  const created = await StockItemModel.create({
    category: input.category ?? (input.kind === "DAILY" ? "VEGETABLES_MEAT" : "GROCERIES"),
    createdBy: new Types.ObjectId(actor.principal.userId),
    groupHostelId: actor.groupId,
    kind: input.kind,
    location: input.location,
    lowAt: input.kind === "STORE" ? (input.lowAt ?? null) : null,
    name: input.name,
    unit: input.unit,
    ...packOf(input, input.unit),
  });

  await changed(...actor.mine);

  return serializeItemOnly(created.toObject() as ItemDoc);
}

/** Owner only. The unit is fixed once anything was entered in it. */
export async function updateStockItem(actor: StockActor, itemId: string, input: UpdateStockItemInput) {
  await connectToDatabase();

  if (!actor.owner) throw new StockError("Only the owner can change an item.", "CAPABILITY_DENIED", 403);
  if (!Types.ObjectId.isValid(itemId)) throw new StockError("Item not found.", "ITEM_NOT_FOUND", 404);

  const id = new Types.ObjectId(itemId);
  const item = await StockItemModel.findOne({ _id: id, groupHostelId: actor.groupId }).lean<ItemDoc | null>();

  if (!item) throw new StockError("Item not found.", "ITEM_NOT_FOUND", 404);

  if (input.name && input.name.toLowerCase() !== item.name.toLowerCase()) {
    await assertNameFree(actor, input.name, id);
  }

  if (
    input.unit &&
    input.unit !== item.unit &&
    (await StockEntryModel.exists({ groupHostelId: actor.groupId, "lines.itemId": id }))
  ) {
    throw new StockError(
      "Stock was already entered in this unit. Add a new item for the new unit.",
      "UNIT_IN_USE",
      409,
    );
  }

  const kind = input.kind ?? item.kind;
  const { packSize, packUnit, ...rest } = input;
  const packChanged = packSize !== undefined || packUnit !== undefined;
  const updated = await StockItemModel.findOneAndUpdate(
    { _id: id },
    {
      $set: {
        ...rest,
        ...(packChanged
          ? packOf(
              { packSize: packSize === undefined ? item.packSize : packSize, packUnit: packUnit === undefined ? item.packUnit : packUnit },
              input.unit ?? item.unit,
            )
          : {}),
        ...(kind === "DAILY" ? { lowAt: null } : {}),
      },
    },
    { new: true },
  ).lean<ItemDoc | null>();

  await changed(...actor.mine);

  return serializeItemOnly(updated!);
}

/* -------------------------------------------------------------------------- */
/* Suppliers                                                                  */
/* -------------------------------------------------------------------------- */

function assertMoney(actor: StockActor) {
  if (!actor.rights.money) {
    throw new StockError("Only the owner, or staff who can add expenses, see suppliers' money.", "CAPABILITY_DENIED", 403);
  }
}

async function assertSupplierNameFree(actor: StockActor, name: string, exceptId?: Types.ObjectId) {
  const clash = await StockSupplierModel.exists({
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
    groupHostelId: actor.groupId,
    name: { $options: "i", $regex: `^${escapeRegex(name)}$` },
  });

  if (clash) throw new StockError(`${name} is already in the list.`, "SUPPLIER_NAME_TAKEN", 409);
}

function serializeSupplierOnly(actor: StockActor, doc: SupplierDoc) {
  return {
    active: doc.active,
    id: doc._id.toString(),
    name: doc.name,
    note: doc.note ?? "",
    openingDue: actor.rights.money ? (doc.openingDue ?? 0) : null,
    phone: doc.phone ?? "",
  };
}

/** Anyone who handles stock can add a supplier — it is picked on the bill. Only money people set what was owed. */
export async function createStockSupplier(actor: StockActor, input: CreateStockSupplierInput) {
  await connectToDatabase();

  if ((await StockSupplierModel.countDocuments({ groupHostelId: actor.groupId })) >= STOCK_SUPPLIER_LIMIT) {
    throw new StockError("The list is full. Switch off a supplier you no longer use.", "SUPPLIER_LIMIT", 422);
  }

  await assertSupplierNameFree(actor, input.name);

  const created = await StockSupplierModel.create({
    createdBy: new Types.ObjectId(actor.principal.userId),
    groupHostelId: actor.groupId,
    name: input.name,
    note: input.note,
    openingDue: actor.rights.money ? (input.openingDue ?? 0) : 0,
    phone: input.phone,
  });

  await changed(...actor.mine);

  return serializeSupplierOnly(actor, created.toObject() as SupplierDoc);
}

export async function updateStockSupplier(actor: StockActor, supplierId: string, input: UpdateStockSupplierInput) {
  await connectToDatabase();
  assertMoney(actor);

  if (!Types.ObjectId.isValid(supplierId)) throw new StockError("Supplier not found.", "SUPPLIER_NOT_FOUND", 404);

  const id = new Types.ObjectId(supplierId);
  const supplier = await StockSupplierModel.findOne({ _id: id, groupHostelId: actor.groupId }).lean<SupplierDoc | null>();

  if (!supplier) throw new StockError("Supplier not found.", "SUPPLIER_NOT_FOUND", 404);

  if (input.name && input.name.toLowerCase() !== supplier.name.toLowerCase()) {
    await assertSupplierNameFree(actor, input.name, id);
  }

  if (input.openingDue !== undefined && !actor.owner) {
    throw new StockError("Only the owner can change what was owed before.", "CAPABILITY_DENIED", 403);
  }

  const updated = await StockSupplierModel.findOneAndUpdate({ _id: id }, { $set: input }, { new: true }).lean<SupplierDoc | null>();

  await changed(...actor.mine);

  return serializeSupplierOnly(actor, updated!);
}

export type StockSupplierLedgerRow = {
  balance: number;
  /** Signed: a bill adds what was not paid on it, a payment takes off. */
  change: number;
  id: string;
  kind: "BILL" | "OPENING" | "PAYMENT";
  on: string;
  /** BILL */
  bill: { billNo: string; items: string; paid: number; status: StockBillStatus; total: number } | null;
  /** PAYMENT */
  payment: { amount: number; canCancel: boolean; note: string; paidBy: string; recordedByName: string } | null;
};

/** One supplier: bills (what we owe) against payments (what we paid), with the balance after each. */
export async function getStockSupplier(actor: StockActor, supplierId: string) {
  await connectToDatabase();
  assertMoney(actor);

  if (!Types.ObjectId.isValid(supplierId)) throw new StockError("Supplier not found.", "SUPPLIER_NOT_FOUND", 404);

  const id = new Types.ObjectId(supplierId);
  const [supplier, bills, payments] = await Promise.all([
    StockSupplierModel.findOne({ _id: id, groupHostelId: actor.groupId }).lean<SupplierDoc | null>(),
    StockEntryModel.find({ groupHostelId: actor.groupId, kind: "BUY", status: { $ne: "CANCELLED" }, supplierId: id }).lean<EntryDoc[]>(),
    StockPaymentModel.find({ groupHostelId: actor.groupId, status: "DONE", supplierId: id }).lean<PaymentDoc[]>(),
  ]);

  if (!supplier) throw new StockError("Supplier not found.", "SUPPLIER_NOT_FOUND", 404);

  const billsById = new Map(bills.map((doc) => [doc._id.toString(), doc]));
  const paymentsById = new Map(payments.map((doc) => [doc._id.toString(), doc]));
  const ledger = supplierLedger(
    supplier.openingDue ?? 0,
    bills.map((doc) => {
      const bill = billMoney(doc) ?? { paid: 0, total: 0 };

      return { createdAt: doc.createdAt, id: doc._id.toString(), on: doc.on, paid: bill.paid, status: doc.status, total: bill.total };
    }),
    payments.map((doc) => ({ amount: doc.amount, createdAt: doc.createdAt, id: doc._id.toString(), on: doc.on, status: doc.status })),
    supplier.createdAt,
  );

  const rows: StockSupplierLedgerRow[] = ledger.rows.map((row) => {
    const bill = row.kind === "BILL" ? billsById.get(row.id) : undefined;
    const payment = row.kind === "PAYMENT" ? paymentsById.get(row.id) : undefined;
    const money = bill ? (billMoney(bill) ?? { paid: 0, total: 0 }) : null;

    return {
      balance: row.balance,
      bill:
        bill && money
          ? {
              billNo: bill.billNo ?? "",
              items: bill.lines.map((line) => line.name).join(", "),
              paid: money.paid,
              status: billStatus(money.total, money.paid),
              total: money.total,
            }
          : null,
      change: row.change,
      id: row.id,
      kind: row.kind,
      on: dayKey(row.on),
      payment: payment
        ? {
            amount: payment.amount,
            canCancel: !actor.overall && (actor.owner || payment.recordedBy.toString() === actor.principal.userId),
            note: payment.note ?? "",
            paidBy: payment.paidBy ?? "CASH",
            recordedByName: payment.recordedByName || "Staff",
          }
        : null,
    };
  });

  return {
    billed: ledger.billed,
    due: ledger.due,
    paid: ledger.paid,
    // Newest first, as a statement is read.
    rows: rows.reverse(),
    supplier: serializeSupplierOnly(actor, supplier),
  };
}

/**
 * Pay a supplier. One `Expense` in the building being worked in, so the cash
 * box and Money Out see it; the supplier's balance drops by the same amount.
 */
export async function createStockPayment(actor: StockActor, input: CreateStockPaymentInput) {
  await connectToDatabase();

  if (!actor.rights.canSpend) {
    throw new StockError("Your account cannot add expenses. Ask the owner to turn on Add expenses.", "CAPABILITY_DENIED", 403);
  }

  if (actor.overall) throw new StockError("Overall only shows. Pick the building you paid from.", "OVERALL_READ_ONLY", 422);

  const recordedBy = new Types.ObjectId(actor.principal.userId);

  if (input.clientRequestId) {
    const existing = await StockPaymentModel.findOne({ clientRequestId: input.clientRequestId, recordedBy }).lean<PaymentDoc | null>();

    if (existing) return { duplicate: true, payment: { amount: existing.amount, id: existing._id.toString() } };
  }

  const supplier = await StockSupplierModel.findOne({
    _id: new Types.ObjectId(input.supplierId),
    groupHostelId: actor.groupId,
  }).lean<SupplierDoc | null>();

  if (!supplier) throw new StockError("Supplier not found.", "SUPPLIER_NOT_FOUND", 404);

  // Filed under what this supplier sells: the first item of their latest bill.
  const lastBill = await StockEntryModel.findOne({ groupHostelId: actor.groupId, kind: "BUY", supplierId: supplier._id })
    .sort({ on: -1 })
    .select("lines.itemId")
    .lean<{ lines: { itemId: Types.ObjectId }[] } | null>();
  const firstItem = lastBill?.lines[0]
    ? await StockItemModel.findById(lastBill.lines[0].itemId).select("category").lean<{ category?: string } | null>()
    : null;

  const { expense } = await createExpense(
    {
      canSeeAll: actor.owner,
      hostelId: actor.activeHostelId,
      principal: actor.principal,
      role: actor.owner ? "HOSTEL_ADMIN" : "WARDEN",
    },
    {
      amount: input.amount,
      category: (firstItem?.category ?? "GROCERIES") as CreateExpenseInput["category"],
      clientRequestId: input.clientRequestId ? `stockpay:${input.clientRequestId}`.slice(0, 64) : undefined,
      paidBy: input.paidBy,
      photoAssetId: input.photoAssetId,
      spentOn: input.on,
      what: `Paid ${supplier.name}${input.note ? ` · ${input.note}` : ""}`.slice(0, EXPENSE_WHAT_MAX),
    },
  );

  let doc: PaymentDoc;

  try {
    const created = await StockPaymentModel.create({
      amount: input.amount,
      clientRequestId: input.clientRequestId ?? null,
      entryIds: (input.entryIds ?? []).map((id) => new Types.ObjectId(id)),
      expenseId: new Types.ObjectId(expense.id),
      groupHostelId: actor.groupId,
      hostelId: actor.activeHostelId,
      note: input.note,
      on: parseSpentOn(input.on),
      paidBy: input.paidBy,
      recordedBy,
      recordedByName: await userName(actor.principal.userId),
      supplierId: supplier._id,
    });

    doc = created.toObject() as PaymentDoc;
  } catch (error) {
    if (isDuplicateKeyError(error) && input.clientRequestId) {
      const raced = await StockPaymentModel.findOne({ clientRequestId: input.clientRequestId, recordedBy }).lean<PaymentDoc | null>();

      if (raced) return { duplicate: true, payment: { amount: raced.amount, id: raced._id.toString() } };
    }

    throw error;
  }

  await changed(...actor.mine);

  return { duplicate: false, payment: { amount: doc.amount, id: doc._id.toString() } };
}

/** A wrong payment is cancelled with a reason, and its expense with it. */
export async function cancelStockPayment(actor: StockActor, paymentId: string, reason: string) {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(paymentId)) throw new StockError("Not found.", "PAYMENT_NOT_FOUND", 404);

  const doc = await StockPaymentModel.findOne({
    _id: new Types.ObjectId(paymentId),
    groupHostelId: actor.groupId,
  }).lean<PaymentDoc | null>();

  if (!doc || doc.status === "CANCELLED") throw new StockError("Not found.", "PAYMENT_NOT_FOUND", 404);

  if (actor.overall || !(actor.owner || doc.recordedBy.toString() === actor.principal.userId)) {
    throw new StockError("You cannot cancel this payment.", "CAPABILITY_DENIED", 403);
  }

  if (doc.expenseId) {
    try {
      await voidExpense(
        {
          canSeeAll: actor.owner,
          hostelId: doc.hostelId,
          principal: actor.principal,
          role: actor.owner ? "HOSTEL_ADMIN" : "WARDEN",
        },
        doc.expenseId.toString(),
        reason,
      );
    } catch (error) {
      if (!(error instanceof ExpenseError && error.errorCode === "EXPENSE_ALREADY_VOID")) throw error;
    }
  }

  await StockPaymentModel.updateOne(
    { _id: doc._id, status: "DONE" },
    {
      $set: {
        cancelReason: reason,
        cancelledAt: new Date(),
        cancelledBy: new Types.ObjectId(actor.principal.userId),
        status: "CANCELLED",
      },
    },
  );

  await changed(...actor.mine);

  return { id: doc._id.toString(), status: "CANCELLED" as const };
}
