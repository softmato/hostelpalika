import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { bsPeriodBounds, currentBsPeriod, hostelPeriodOf, isBsPeriod } from "@/lib/hostel-day";
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
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { EXPENSE_WHAT_MAX } from "@hostel/shared/expenses/categories";
import {
  formatQty,
  roundQty,
  STOCK_ITEM_LIMIT,
  type StockEntryKind,
  type StockEntryStatus,
  type StockKind,
  type StockUnit,
} from "@hostel/shared/expenses/stock";
import { ExpenseModel } from "@hostel/db/models/Expense";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelMemberModel } from "@hostel/db/models/HostelMember";
import { ResidentModel } from "@hostel/db/models/Resident";
import { StockEntryModel } from "@hostel/db/models/StockEntry";
import { StockItemModel } from "@hostel/db/models/StockItem";
import { UserModel } from "@hostel/db/models/User";

import { foldStock, type ItemAtPlace } from "./stock-balance";
import type { CreateStockEntryInput, CreateStockItemInput, UpdateStockItemInput } from "./stock.validation";

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
  lowAt?: number | null;
  name: string;
  unit: StockUnit;
};

type EntryDoc = {
  _id: Types.ObjectId;
  amount?: number | null;
  cancelReason?: string;
  createdAt: Date;
  expenseId?: Types.ObjectId | null;
  hostelId: Types.ObjectId;
  kind: StockEntryKind;
  lines: {
    itemId: Types.ObjectId;
    name: string;
    qty: number;
    rate?: number | null;
    receivedQty?: number | null;
    unit: StockUnit;
  }[];
  note?: string;
  supplier?: string;
  on: Date;
  receivedAt?: Date;
  receivedByName?: string;
  recordedBy: Types.ObjectId;
  recordedByName?: string;
  status: StockEntryStatus;
  toHostelId?: Types.ObjectId | null;
};

export type StockEntryRow = {
  amount: number | null;
  canCancel: boolean;
  canReceive: boolean;
  cancelReason: string | null;
  createdAt: string;
  hostelId: string;
  hostelName: string;
  id: string;
  kind: StockEntryKind;
  lines: { itemId: string; name: string; qty: number; rate: number | null; receivedQty: number | null; unit: StockUnit }[];
  mine: boolean;
  note: string;
  supplier: string;
  /** Gregorian `YYYY-MM-DD`; screens read it in Bikram Sambat. */
  on: string;
  receivedAt: string | null;
  receivedByName: string | null;
  recordedByName: string;
  status: StockEntryStatus;
  toHostelId: string | null;
  toHostelName: string | null;
};

export type StockItemRow = {
  active: boolean;
  /** Per building this person can see, main first. */
  at: (Omit<ItemAtPlace, "countedAt"> & { countedAt: string | null; hostelId: string; low: boolean })[];
  category: string;
  id: string;
  kind: StockKind;
  lowAt: number | null;
  name: string;
  unit: StockUnit;
};

export type StockHome = {
  /** May put an amount on a Bought (owner, or a warden with Add expenses). */
  canSpend: boolean;
  currentPeriod: string;
  /** This month's entries touching the buildings this person sees, newest first. */
  entries: StockEntryRow[];
  items: StockItemRow[];
  owner: boolean;
  period: string;
  places: (Place & { mine: boolean; residents: number | null })[];
  proofRequired: boolean;
  /** Sends from these buildings still waiting for Got it. */
  sentWaiting: StockEntryRow[];
  /** Sends to these buildings: tap Got it. */
  waiting: StockEntryRow[];
};

function dayKey(day: Date) {
  return day.toISOString().slice(0, 10);
}

function serializeEntry(actor: StockActor, doc: EntryDoc): StockEntryRow {
  const names = new Map(actor.places.map((place) => [place.id, place.name]));
  const mine = doc.recordedBy.toString() === actor.principal.userId;
  const toHostelId = doc.toHostelId?.toString() ?? null;

  return {
    // A warden sees what they paid, not what the owner paid.
    amount: actor.owner || mine ? (doc.amount ?? null) : null,
    canCancel:
      !actor.overall &&
      doc.status !== "CANCELLED" &&
      (actor.owner || (mine && !(doc.kind === "SEND" && doc.status === "RECEIVED"))),
    canReceive: !actor.overall && doc.status === "PENDING" && toHostelId !== null && actor.mine.includes(toHostelId),
    cancelReason: doc.cancelReason ?? null,
    createdAt: doc.createdAt.toISOString(),
    hostelId: doc.hostelId.toString(),
    hostelName: names.get(doc.hostelId.toString()) ?? "Hostel",
    id: doc._id.toString(),
    kind: doc.kind,
    lines: doc.lines.map((line) => ({
      itemId: line.itemId.toString(),
      name: line.name,
      qty: line.qty,
      rate: line.rate ?? null,
      receivedQty: line.receivedQty ?? null,
      unit: line.unit,
    })),
    mine,
    note: doc.note ?? "",
    supplier: doc.supplier ?? "",
    on: dayKey(doc.on),
    receivedAt: doc.receivedAt?.toISOString() ?? null,
    receivedByName: doc.receivedByName ?? null,
    recordedByName: doc.recordedByName || "Staff",
    status: doc.status,
    toHostelId,
    toHostelName: toHostelId ? (names.get(toHostelId) ?? "Hostel") : null,
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

/** What a warden may do with money, read per request like every capability. */
async function spendRights(actor: StockActor) {
  if (actor.owner) return { canSpend: true, proofRequired: false };

  const member = await HostelMemberModel.findOne({
    hostelId: actor.activeHostelId,
    isDeleted: { $ne: true },
    status: "ACTIVE",
    userId: actor.principal.userId,
  })
    .select("permissions")
    .lean<{ permissions?: string[] } | null>();
  const permissions = member?.permissions ?? [];

  return {
    canSpend: grantingPermissionKeys("recordExpenses").some((key) => permissions.includes(key)),
    proofRequired: !permissions.includes("expenseWithoutProof"),
  };
}

/* -------------------------------------------------------------------------- */
/* The screen's one read                                                      */
/* -------------------------------------------------------------------------- */

export async function getStockHome(actor: StockActor, requestedPeriod?: string): Promise<StockHome> {
  await connectToDatabase();

  const period = resolvePeriod(requestedPeriod);
  const [items, docs, rights, residents] = await Promise.all([
    StockItemModel.find({ groupHostelId: actor.groupId })
      .sort({ active: -1, name: 1 })
      .lean<ItemDoc[]>(),
    // ponytail: the group's whole history is folded in memory; a busy group adds
    // a few hundred entries a month. Aggregate in Mongo past ~20k entries.
    StockEntryModel.find({ groupHostelId: actor.groupId }).sort({ createdAt: 1 }).lean<EntryDoc[]>(),
    spendRights(actor),
    Promise.all(
      actor.mine.map((id) =>
        ResidentModel.countDocuments({ hostelId: id, isDeleted: false, status: { $ne: "MOVED_OUT" } }),
      ),
    ),
  ]);

  const kinds = new Map(items.map((item) => [item._id.toString(), item.kind]));
  const folded = foldStock(
    docs.map((doc) => ({
      createdAt: doc.createdAt,
      hostelId: doc.hostelId.toString(),
      inPeriod: hostelPeriodOf(doc.on) === period,
      kind: doc.kind,
      lines: doc.lines.map((line) => ({
        itemId: line.itemId.toString(),
        qty: line.qty,
        receivedQty: line.receivedQty ?? null,
      })),
      receivedAt: doc.receivedAt ?? null,
      status: doc.status,
      toHostelId: doc.toHostelId?.toString() ?? null,
    })),
    kinds,
    actor.mine,
  );

  const mine = new Set(actor.mine);
  const touchesMine = (doc: EntryDoc) =>
    mine.has(doc.hostelId.toString()) || (doc.toHostelId ? mine.has(doc.toHostelId.toString()) : false);
  const visible = docs.filter(touchesMine);
  const residentsById = new Map(actor.mine.map((id, index) => [id, residents[index] ?? 0]));

  return {
    ...rights,
    currentPeriod: currentBsPeriod(),
    entries: visible
      .filter((doc) => hostelPeriodOf(doc.on) === period)
      .sort((a, b) => b.on.getTime() - a.on.getTime() || b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 300)
      .map((doc) => serializeEntry(actor, doc)),
    items: items.map((item) => {
      const id = item._id.toString();
      const byPlace = folded.get(id);

      return {
        active: item.active,
        at: actor.mine.map((hostelId) => {
          const row = byPlace?.get(hostelId) ?? {
            bought: 0,
            counted: null,
            countedAt: null,
            in: 0,
            left: 0,
            onWay: 0,
            out: 0,
            short: 0,
            used: 0,
          };

          return {
            ...row,
            countedAt: row.countedAt?.toISOString() ?? null,
            hostelId,
            low: item.kind === "STORE" && item.lowAt != null && row.left < item.lowAt,
          };
        }),
        category: item.category ?? "GROCERIES",
        id,
        kind: item.kind,
        lowAt: item.lowAt ?? null,
        name: item.name,
        unit: item.unit,
      };
    }),
    owner: actor.owner,
    period,
    places: actor.places.map((place) => ({
      ...place,
      mine: mine.has(place.id),
      residents: residentsById.get(place.id) ?? null,
    })),
    sentWaiting: visible
      .filter((doc) => doc.kind === "SEND" && doc.status === "PENDING" && mine.has(doc.hostelId.toString()))
      .reverse()
      .map((doc) => serializeEntry(actor, doc)),
    waiting: visible
      .filter((doc) => doc.kind === "SEND" && doc.status === "PENDING" && doc.toHostelId && mine.has(doc.toHostelId.toString()))
      .reverse()
      .map((doc) => serializeEntry(actor, doc)),
  };
}

/* -------------------------------------------------------------------------- */
/* Bought · Send · Count                                                      */
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

async function notifyQuietly(userIds: string[], title: string, body: string, hostelId: string, entryId: string) {
  await Promise.all(
    [...new Set(userIds)].map((userId) =>
      createInAppNotification({
        actionUrl: "/hostel-admin/stock",
        body,
        category: "GENERAL",
        data: { entryId, type: "STOCK" },
        hostelId,
        title,
        userId,
      }).catch((error) => console.warn("stock_notification_failed", entryId, error)),
    ),
  );
}

/** The owner and every warden of the building who can tap Got it. */
async function receivers(hostelId: string) {
  const [hostel, wardens] = await Promise.all([
    HostelModel.findById(hostelId).select("ownerId").lean<{ ownerId?: Types.ObjectId } | null>(),
    HostelMemberModel.find({
      hostelId,
      isDeleted: { $ne: true },
      permissions: { $in: grantingPermissionKeys("manageStock") },
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

export async function createStockEntry(actor: StockActor, input: CreateStockEntryInput) {
  await connectToDatabase();

  const existing = await existingByRequest(actor, input.clientRequestId);

  if (existing) return { duplicate: true, entry: serializeEntry(actor, existing) };

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

  let toHostelId: string | null = null;

  if (input.kind === "SEND") {
    toHostelId = input.toHostelId ?? null;

    if (!toHostelId || toHostelId === hostelId || !actor.places.some((place) => place.id === toHostelId)) {
      throw new StockError("Pick another building of this hostel to send to.", "INVALID_DESTINATION", 422);
    }
  }

  const on = parseSpentOn(input.on);
  const items = await StockItemModel.find({
    _id: { $in: input.lines.map((line) => new Types.ObjectId(line.itemId)) },
    active: true,
    groupHostelId: actor.groupId,
  }).lean<ItemDoc[]>();
  const byId = new Map(items.map((item) => [item._id.toString(), item]));

  // One line per item: two rows of Rice on one Bought are one Rice.
  const merged = new Map<string, number>();
  const rates = new Map<string, number>();

  for (const line of input.lines) {
    const item = byId.get(line.itemId);

    if (!item) throw new StockError("One of the items is not there any more. Pick again.", "ITEM_NOT_FOUND", 404);

    if (input.kind === "COUNT" && item.kind === "DAILY") {
      throw new StockError(`${item.name} is a daily item. Daily items are not counted.`, "DAILY_NOT_COUNTED", 422);
    }

    merged.set(line.itemId, input.kind === "COUNT" ? line.qty : (merged.get(line.itemId) ?? 0) + line.qty);

    if (input.kind === "BUY" && line.rate !== undefined) rates.set(line.itemId, line.rate);
  }

  const lines = [...merged].map(([itemId, qty]) => {
    const item = byId.get(itemId)!;

    return {
      itemId: item._id,
      name: item.name,
      qty: roundQty(qty),
      rate: rates.get(itemId) ?? null,
      receivedQty: null,
      unit: item.unit,
    };
  });

  const supplier = input.kind === "BUY" ? input.supplier?.trim() || undefined : undefined;
  let expenseId: Types.ObjectId | null = null;

  if (input.kind === "BUY" && input.amount) {
    const rights = await spendRights(actor);

    if (!rights.canSpend) {
      throw new StockError(
        "Your account cannot add expenses. Leave the amount empty, or ask the owner to turn on Add expenses.",
        "CAPABILITY_DENIED",
        403,
      );
    }

    const expenseActor: ExpenseActor = {
      canSeeAll: actor.owner,
      hostelId: actor.activeHostelId,
      principal: actor.principal,
      role: actor.owner ? "HOSTEL_ADMIN" : "WARDEN",
    };
    const first = byId.get(lines[0]!.itemId.toString());
    const { expense } = await createExpense(expenseActor, {
      amount: input.amount,
      category: (first?.category ?? "GROCERIES") as CreateExpenseInput["category"],
      clientRequestId: input.clientRequestId ? `stock:${input.clientRequestId}`.slice(0, 64) : undefined,
      paidBy: input.paidBy,
      photoAssetId: input.photoAssetId,
      spentOn: input.on,
      what: supplier ? lineSummary(lines, `${supplier}: `) : lineSummary(lines),
    });

    expenseId = new Types.ObjectId(expense.id);
  }

  let doc: EntryDoc;

  try {
    const created = await StockEntryModel.create({
      amount: expenseId ? input.amount : null,
      clientRequestId: input.clientRequestId ?? null,
      expenseId,
      groupHostelId: actor.groupId,
      hostelId: new Types.ObjectId(hostelId),
      kind: input.kind,
      lines,
      note: input.note,
      on,
      supplier,
      recordedBy: new Types.ObjectId(actor.principal.userId),
      recordedByName: await userName(actor.principal.userId),
      status: input.kind === "SEND" ? "PENDING" : "DONE",
      toHostelId: toHostelId ? new Types.ObjectId(toHostelId) : null,
    });

    doc = created.toObject() as EntryDoc;
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const raced = await existingByRequest(actor, input.clientRequestId);

      if (raced) return { duplicate: true, entry: serializeEntry(actor, raced) };
    }

    throw error;
  }

  if (toHostelId) {
    const from = actor.places.find((place) => place.id === hostelId)?.name ?? "the other building";

    await notifyQuietly(
      (await receivers(toHostelId)).filter((id) => id !== actor.principal.userId),
      "Stock on the way",
      `${lineSummary(lines)} from ${from}. Tap Got it when it comes.`,
      toHostelId,
      doc._id.toString(),
    );
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

/** A mistake is cancelled, never deleted. A Bought takes its expense with it. */
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
    lowAt: item.lowAt ?? null,
    name: item.name,
    unit: item.unit,
  };
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
    lowAt: input.kind === "STORE" ? (input.lowAt ?? null) : null,
    name: input.name,
    unit: input.unit,
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
  const updated = await StockItemModel.findOneAndUpdate(
    { _id: id },
    {
      $set: {
        ...input,
        ...(kind === "DAILY" ? { lowAt: null } : {}),
      },
    },
    { new: true },
  ).lean<ItemDoc | null>();

  await changed(...actor.mine);

  return serializeItemOnly(updated!);
}
