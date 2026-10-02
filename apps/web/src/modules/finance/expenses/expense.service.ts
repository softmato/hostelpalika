import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import {
  addBsMonths,
  bsPeriodBounds,
  currentBsPeriod,
  hostelPeriodOf,
  hostelToday,
  isBsPeriod,
} from "@/lib/hostel-day";
import { Role } from "@/lib/roles";
import { assertHostelAccess } from "@/lib/tenant";
import { auditFinanceAction } from "@/modules/finance/audit-finance";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";
import {
  CUSTOM_EXPENSE_CATEGORY,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_CUSTOM_CATEGORY_LIMIT,
  type ExpenseCategoryValue,
  type ExpensePaidBy,
  isExpenseCategoryKey,
} from "@hostel/shared/expenses/categories";
import { CookAccountModel } from "@hostel/db/models/CookAccount";
import { ExpenseModel } from "@hostel/db/models/Expense";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { HostelExpenseCategoryModel } from "@hostel/db/models/HostelExpenseCategory";
import { HostelMemberModel } from "@hostel/db/models/HostelMember";
import { HostelSettingsModel } from "@hostel/db/models/HostelSettings";
import { PaymentEventModel } from "@hostel/db/models/PaymentEvent";
import { UserModel } from "@hostel/db/models/User";

import type { CreateExpenseInput } from "./expense.validation";

/**
 * Money Out — the hostel's own spending (docs/EXPENSES_PLAN.md).
 *
 * ## Who sees what
 *
 * The owner sees everything: every row, the month's *In · Out · Left*, and
 * what each category cost. A warden (with `recordExpenses`) and the cook (when
 * the owner switched it on) **add only**: they read their own rows and their own
 * month's spend, and nothing that would tell them what the hostel earns. That
 * split is enforced here, by role, and never by the screen hiding a number.
 *
 * ## Why a month is a BS month
 *
 * Every month the owner reads elsewhere — invoices, the Money tab, rates — is a
 * Bikram Sambat month, so *Out* for Asoj has to be Asoj's spending, set against
 * Asoj's *In*. `spentOn` is a calendar day and bins by `hostelPeriodOf`, the same
 * call an invoice uses.
 */

export class ExpenseError extends Error {
  constructor(
    message: string,
    public errorCode: string,
    public status = 400,
  ) {
    super(message);
    this.name = "ExpenseError";
  }
}

export type ExpenseRecorderRole = "HOSTEL_ADMIN" | "WARDEN" | "COOK";

export type ExpenseActor = {
  /** The owner sees every row and the totals; everyone else only their own. */
  canSeeAll: boolean;
  hostelId: Types.ObjectId;
  principal: ApiPrincipal;
  role: ExpenseRecorderRole;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** How far back a day may be back-dated. A year and a little, for a late bill. */
const OLDEST_SPENT_ON_DAYS = 400;
/** One month's rows are read whole; a busy hostel adds a few hundred. */
const MAX_ROWS_PER_MONTH = 2000;

/**
 * Who is asking, for which hostel, and how much they may see.
 *
 * A warden reaches this only through `requireHostelCapability(…,
 * "recordExpenses")`, which has already narrowed `hostelIds` to hostels where
 * the grant is held. The cook has no grant to narrow by, so the hostel's own
 * switch is read here.
 */
export async function resolveExpenseActor(
  principal: ApiPrincipal,
  requestedHostelId?: string,
): Promise<ExpenseActor> {
  if (principal.role === Role.HOSTEL_ADMIN || principal.role === Role.WARDEN) {
    return {
      canSeeAll: principal.role === Role.HOSTEL_ADMIN,
      hostelId: resolveAdminHostelId(principal, requestedHostelId),
      principal,
      role: principal.role === Role.HOSTEL_ADMIN ? "HOSTEL_ADMIN" : "WARDEN",
    };
  }

  if (principal.role === Role.COOK) {
    const hostelId = requestedHostelId ?? principal.hostelIds[0];

    if (!hostelId || !Types.ObjectId.isValid(hostelId)) {
      throw new ExpenseError("This cook account is not linked to a hostel.", "HOSTEL_SCOPE_REQUIRED", 422);
    }

    assertHostelAccess(principal, hostelId);
    await connectToDatabase();

    const settings = await HostelSettingsModel.findOne({ hostelId })
      .select("cookCanRecordExpenses")
      .lean<{ cookCanRecordExpenses?: boolean } | null>();

    if (!settings?.cookCanRecordExpenses) {
      throw new ExpenseError(
        "The owner has not turned on expenses for the cook.",
        "EXPENSES_OFF_FOR_COOK",
        403,
      );
    }

    return {
      canSeeAll: false,
      hostelId: new Types.ObjectId(hostelId),
      principal,
      role: "COOK",
    };
  }

  throw new ExpenseError("You cannot add expenses.", "CAPABILITY_DENIED", 403);
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

type ExpenseDoc = {
  _id: Types.ObjectId;
  amount: number;
  category: string;
  createdAt?: Date;
  customCategoryId?: Types.ObjectId | null;
  paidBy: ExpensePaidBy;
  payer: "HOSTEL" | "STAFF";
  photoAssetId?: Types.ObjectId | null;
  recordedBy: Types.ObjectId;
  recordedByName?: string;
  recordedByRole: ExpenseRecorderRole;
  salaryFor?: { name: string; userId?: Types.ObjectId | null } | null;
  spentOn: Date;
  status: "RECORDED" | "VOID";
  voidReason?: string;
  voidedAt?: Date;
  what?: string;
};

export type ExpenseRow = {
  amount: number;
  category: ExpenseCategoryValue;
  /** What to print under the icon — built-in label or the hostel's own name. */
  categoryLabel: string;
  createdAt: string | null;
  customCategoryId: string | null;
  id: string;
  /** Added by the person asking. Only the owner ever sees a row where this is false. */
  mine: boolean;
  paidBy: ExpensePaidBy;
  payer: "HOSTEL" | "STAFF";
  photoAssetId: string | null;
  recordedBy: { id: string; name: string; role: ExpenseRecorderRole };
  salaryFor: { name: string; userId: string | null } | null;
  /** The calendar day, `YYYY-MM-DD` (Gregorian; the client shows it in BS). */
  spentOn: string;
  status: "RECORDED" | "VOID";
  voidReason: string | null;
  voidedAt: string | null;
  what: string;
};

export type CustomExpenseCategory = { hidden: boolean; id: string; name: string };

export type ExpensePerson = { name: string; role: "WARDEN" | "COOK"; userId: string };

export type ExpenseCategoryTotal = {
  amount: number;
  category: ExpenseCategoryValue;
  customCategoryId: string | null;
  label: string;
};

export type ExpenseHome = {
  canSeeTotals: boolean;
  categories: CustomExpenseCategory[];
  currentPeriod: string;
  expenses: ExpenseRow[];
  /** What the asker themselves spent this month — the staff screen's header. */
  mine: { count: number; out: number };
  people: ExpensePerson[];
  period: string;
  role: ExpenseRecorderRole;
  /** Owner only. `null` for everyone else, never zeroes they could misread. */
  totals: {
    byCategory: ExpenseCategoryTotal[];
    in: number;
    lastMonthOut: number;
    left: number;
    out: number;
    /** Rows a warden or the cook added this month. */
    staffCount: number;
  } | null;
};

function calendarDayKey(day: Date) {
  return day.toISOString().slice(0, 10);
}

function categoryLabel(doc: Pick<ExpenseDoc, "category" | "customCategoryId">, custom: Map<string, string>) {
  if (doc.category === CUSTOM_EXPENSE_CATEGORY) {
    return custom.get(doc.customCategoryId?.toString() ?? "") ?? EXPENSE_CATEGORY_LABELS.OTHER;
  }

  return isExpenseCategoryKey(doc.category) ? EXPENSE_CATEGORY_LABELS[doc.category] : EXPENSE_CATEGORY_LABELS.OTHER;
}

export function serializeExpense(
  doc: ExpenseDoc,
  askerId: string,
  custom: Map<string, string>,
): ExpenseRow {
  return {
    amount: doc.amount,
    category: (doc.category === CUSTOM_EXPENSE_CATEGORY || isExpenseCategoryKey(doc.category)
      ? doc.category
      : "OTHER") as ExpenseCategoryValue,
    categoryLabel: categoryLabel(doc, custom),
    createdAt: doc.createdAt ? doc.createdAt.toISOString() : null,
    customCategoryId: doc.customCategoryId?.toString() ?? null,
    id: doc._id.toString(),
    mine: doc.recordedBy.toString() === askerId,
    paidBy: doc.paidBy,
    payer: doc.payer,
    photoAssetId: doc.photoAssetId?.toString() ?? null,
    recordedBy: {
      id: doc.recordedBy.toString(),
      name: doc.recordedByName || "Staff",
      role: doc.recordedByRole,
    },
    salaryFor: doc.salaryFor
      ? { name: doc.salaryFor.name, userId: doc.salaryFor.userId?.toString() ?? null }
      : null,
    spentOn: calendarDayKey(doc.spentOn),
    status: doc.status,
    voidReason: doc.voidReason ?? null,
    voidedAt: doc.voidedAt ? doc.voidedAt.toISOString() : null,
    what: doc.what ?? "",
  };
}

/* -------------------------------------------------------------------------- */
/* Money In                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What actually arrived in a BS month: settled credits minus settled debits
 * (reversals), by the day the money settled.
 *
 * Not the Money tab's `collected`, which is "paid against invoices billed in
 * this month" — a resident who settles Bhadra's rent in Asoj is Asoj's money in
 * this card, because Asoj is when the owner had it to spend.
 *
 * `settledAt` is an instant and a Nepal day starts at 18:15 UTC the evening
 * before, so the range is read a day wide on both sides and binned exactly.
 */
export async function moneyInForPeriod(hostelId: Types.ObjectId, period: string) {
  const { end, start } = bsPeriodBounds(period);

  const events = await PaymentEventModel.find({
    hostelId,
    settledAt: {
      $gte: new Date(start.getTime() - MS_PER_DAY),
      $lte: new Date(end.getTime() + MS_PER_DAY),
    },
    status: "SETTLED",
  })
    .select("amount direction settledAt")
    .lean<{ amount: number; direction: "CREDIT" | "DEBIT"; settledAt?: Date }[]>();

  return events.reduce((sum, event) => {
    if (!event.settledAt || hostelPeriodOf(event.settledAt) !== period) return sum;

    return event.direction === "DEBIT" ? sum - event.amount : sum + event.amount;
  }, 0);
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

async function loadCustomCategories(hostelId: Types.ObjectId) {
  const rows = await HostelExpenseCategoryModel.find({ hostelId })
    .sort({ name: 1 })
    .select("hidden name")
    .lean<{ _id: Types.ObjectId; hidden?: boolean; name: string }[]>();

  return rows.map((row) => ({ hidden: Boolean(row.hidden), id: row._id.toString(), name: row.name }));
}

/** The salary picker: this hostel's wardens and cooks, by name. */
async function loadPeople(hostelId: Types.ObjectId): Promise<ExpensePerson[]> {
  const [members, cooks] = await Promise.all([
    HostelMemberModel.find({
      hostelId,
      isDeleted: { $ne: true },
      role: Role.WARDEN,
      status: "ACTIVE",
    })
      .select("userId")
      .lean<{ userId: Types.ObjectId }[]>(),
    CookAccountModel.find({ hostelId, status: "ACTIVE", userId: { $ne: null } })
      .select("name userId")
      .lean<{ name: string; userId?: Types.ObjectId }[]>(),
  ]);

  const users = members.length
    ? await UserModel.find({ _id: { $in: members.map((member) => member.userId) } })
        .select("name")
        .lean<{ _id: Types.ObjectId; name: string }[]>()
    : [];

  return [
    ...users.map((user) => ({ name: user.name, role: "WARDEN" as const, userId: user._id.toString() })),
    ...cooks
      .filter((cook) => cook.userId)
      .map((cook) => ({ name: cook.name, role: "COOK" as const, userId: cook.userId!.toString() })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

function resolvePeriod(requested?: string) {
  const current = currentBsPeriod();

  if (!requested) return current;

  if (!isBsPeriod(requested)) {
    throw new ExpenseError("Pick a month to show.", "INVALID_PERIOD", 422);
  }

  // A month that has not started has nothing in it yet; show this one.
  if (requested > current) return current;

  try {
    // Throws below the calendar floor — a month long before any hostel billed.
    bsPeriodBounds(requested);
  } catch {
    throw new ExpenseError("There is nothing that far back.", "INVALID_PERIOD", 422);
  }

  return requested;
}

function periodFilter(period: string) {
  const { end, start } = bsPeriodBounds(period);

  return { $gte: start, $lte: end };
}

export async function getExpenseHome(actor: ExpenseActor, requestedPeriod?: string): Promise<ExpenseHome> {
  await connectToDatabase();

  const period = resolvePeriod(requestedPeriod);
  const askerId = actor.principal.userId;
  const scope: Record<string, unknown> = { hostelId: actor.hostelId, spentOn: periodFilter(period) };

  if (!actor.canSeeAll) {
    scope.recordedBy = new Types.ObjectId(askerId);
  }

  const [docs, categories, people] = await Promise.all([
    ExpenseModel.find(scope)
      .sort({ spentOn: -1, createdAt: -1 })
      .limit(MAX_ROWS_PER_MONTH)
      .lean<ExpenseDoc[]>(),
    loadCustomCategories(actor.hostelId),
    loadPeople(actor.hostelId),
  ]);

  const customNames = new Map(categories.map((category) => [category.id, category.name]));
  const expenses = docs.map((doc) => serializeExpense(doc, askerId, customNames));
  const recorded = expenses.filter((row) => row.status === "RECORDED");
  const mineRows = recorded.filter((row) => row.mine);

  const home: ExpenseHome = {
    canSeeTotals: actor.canSeeAll,
    categories: actor.canSeeAll ? categories : categories.filter((category) => !category.hidden),
    currentPeriod: currentBsPeriod(),
    expenses,
    mine: { count: mineRows.length, out: mineRows.reduce((sum, row) => sum + row.amount, 0) },
    people,
    period,
    role: actor.role,
    totals: null,
  };

  if (!actor.canSeeAll) {
    return home;
  }

  const lastPeriod = addBsMonths(period, -1);
  const [moneyIn, lastMonth] = await Promise.all([
    moneyInForPeriod(actor.hostelId, period),
    ExpenseModel.aggregate<{ total: number }>([
      { $match: { hostelId: actor.hostelId, spentOn: periodFilter(lastPeriod), status: "RECORDED" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
  ]);

  const out = recorded.reduce((sum, row) => sum + row.amount, 0);
  const byCategory = new Map<string, ExpenseCategoryTotal>();

  for (const row of recorded) {
    const key = row.category === CUSTOM_EXPENSE_CATEGORY ? `C:${row.customCategoryId}` : row.category;
    const entry = byCategory.get(key) ?? {
      amount: 0,
      category: row.category,
      customCategoryId: row.customCategoryId,
      label: row.categoryLabel,
    };

    entry.amount += row.amount;
    byCategory.set(key, entry);
  }

  home.totals = {
    byCategory: [...byCategory.values()].sort((a, b) => b.amount - a.amount),
    in: moneyIn,
    lastMonthOut: lastMonth[0]?.total ?? 0,
    left: moneyIn - out,
    out,
    staffCount: recorded.filter((row) => row.recordedBy.role !== "HOSTEL_ADMIN").length,
  };

  return home;
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `2026-10-01` → that day at UTC midnight, the shape every calendar-day field
 * in this product is stored in. Refuses a day that has not happened yet in
 * Nepal, and one so old it is almost certainly a typo in the year.
 */
export function parseSpentOn(value: string | undefined, now = new Date()): Date {
  const today = hostelToday(now);

  if (!value) return today;

  const day = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(day.getTime()) || calendarDayKey(day) !== value) {
    throw new ExpenseError("That date does not exist.", "INVALID_DATE", 422);
  }

  if (day.getTime() > today.getTime()) {
    throw new ExpenseError("The date cannot be in the future.", "DATE_IN_FUTURE", 422);
  }

  if (today.getTime() - day.getTime() > OLDEST_SPENT_ON_DAYS * MS_PER_DAY) {
    throw new ExpenseError("That date is too long ago. Check the year.", "DATE_TOO_OLD", 422);
  }

  return day;
}

async function recorderName(actor: ExpenseActor) {
  if (actor.role === "COOK") {
    const cook = await CookAccountModel.findOne({
      hostelId: actor.hostelId,
      userId: actor.principal.userId,
    })
      .select("name")
      .lean<{ name: string } | null>();

    if (cook?.name) return cook.name;
  }

  const user = await UserModel.findById(actor.principal.userId)
    .select("name")
    .lean<{ name?: string } | null>();

  return user?.name ?? "";
}

/**
 * The photo must be the asker's own upload, for this hostel, finished, and
 * uploaded *as* an expense photo — the kind is what keeps it staff-only to read.
 * A missing asset and someone else's asset answer the same way.
 */
async function assertPhotoUsable(actor: ExpenseActor, assetId: string) {
  const asset = await FileAssetModel.findOne({ _id: assetId, isDeleted: false, status: "ACTIVE" })
    .select("hostelId kind ownerId uploadCompletedAt")
    .lean<{
      hostelId?: Types.ObjectId;
      kind?: string;
      ownerId?: Types.ObjectId;
      uploadCompletedAt?: Date;
    } | null>();

  if (
    !asset ||
    asset.ownerId?.toString() !== actor.principal.userId ||
    asset.hostelId?.toString() !== actor.hostelId.toString() ||
    asset.kind !== "EXPENSE_RECEIPT"
  ) {
    throw new ExpenseError("This photo is not yours to attach. Add it again.", "ASSET_NOT_OWNED", 403);
  }

  if (!asset.uploadCompletedAt) {
    throw new ExpenseError("The photo has not finished uploading. Try again.", "ASSET_NOT_READY", 409);
  }

  return new Types.ObjectId(assetId);
}

function isDuplicateKeyError(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;
}

export async function createExpense(actor: ExpenseActor, input: CreateExpenseInput) {
  await connectToDatabase();

  const recordedBy = new Types.ObjectId(actor.principal.userId);

  if (input.clientRequestId) {
    const existing = await ExpenseModel.findOne({
      clientRequestId: input.clientRequestId,
      hostelId: actor.hostelId,
      recordedBy,
    }).lean<ExpenseDoc | null>();

    if (existing) {
      return { duplicate: true, expense: await serializeOne(actor, existing) };
    }
  }

  const spentOn = parseSpentOn(input.spentOn);
  let customCategoryId: Types.ObjectId | null = null;

  if (input.category === CUSTOM_EXPENSE_CATEGORY) {
    const category = await HostelExpenseCategoryModel.findOne({
      _id: input.customCategoryId,
      hidden: { $ne: true },
      hostelId: actor.hostelId,
    })
      .select("_id")
      .lean<{ _id: Types.ObjectId } | null>();

    if (!category) {
      throw new ExpenseError("That category is not there any more. Pick another.", "CATEGORY_NOT_FOUND", 404);
    }

    customCategoryId = category._id;
  }

  let salaryFor: { name: string; userId: Types.ObjectId | null } | null = null;

  if (input.category === "SALARY" && input.salaryFor) {
    const people = input.salaryFor.userId ? await loadPeople(actor.hostelId) : [];
    const known = people.some((person) => person.userId === input.salaryFor?.userId);

    salaryFor = {
      name: input.salaryFor.name,
      // An id that is not one of this hostel's staff is dropped, the name kept.
      userId: known ? new Types.ObjectId(input.salaryFor.userId) : null,
    };
  }

  const photoAssetId = input.photoAssetId ? await assertPhotoUsable(actor, input.photoAssetId) : null;

  let doc: ExpenseDoc;

  try {
    const created = await ExpenseModel.create({
      amount: input.amount,
      category: input.category,
      clientRequestId: input.clientRequestId ?? null,
      customCategoryId,
      hostelId: actor.hostelId,
      paidBy: input.paidBy,
      payer: actor.role === "HOSTEL_ADMIN" ? "HOSTEL" : "STAFF",
      photoAssetId,
      recordedBy,
      recordedByName: await recorderName(actor),
      recordedByRole: actor.role,
      salaryFor,
      source: "MANUAL",
      spentOn,
      status: "RECORDED",
      what: input.what ?? "",
    });

    doc = created.toObject() as ExpenseDoc;
  } catch (error) {
    // Two taps raced past the lookup above; the index kept one. Return it.
    if (input.clientRequestId && isDuplicateKeyError(error)) {
      const existing = await ExpenseModel.findOne({
        clientRequestId: input.clientRequestId,
        hostelId: actor.hostelId,
        recordedBy,
      }).lean<ExpenseDoc | null>();

      if (existing) {
        return { duplicate: true, expense: await serializeOne(actor, existing) };
      }
    }

    throw error;
  }

  await auditFinanceAction(actor.principal, {
    action: "EXPENSE_RECORDED",
    amountAfter: doc.amount,
    amountBefore: 0,
    entityId: doc._id,
    entityType: "Expense",
    hostelId: actor.hostelId,
    source: "EXPENSE_MANUAL",
  });

  return { duplicate: false, expense: await serializeOne(actor, doc) };
}

async function serializeOne(actor: ExpenseActor, doc: ExpenseDoc) {
  const customNames = new Map<string, string>();

  if (doc.customCategoryId) {
    const category = await HostelExpenseCategoryModel.findById(doc.customCategoryId)
      .select("name")
      .lean<{ name: string } | null>();

    if (category) customNames.set(doc.customCategoryId.toString(), category.name);
  }

  return serializeExpense(doc, actor.principal.userId, customNames);
}

/**
 * Cancel a row, with the reason kept beside it. The owner may cancel any row;
 * a warden or the cook only their own — the same "add only" line, since fixing
 * your own typo is not reading anyone else's spending.
 */
export async function voidExpense(actor: ExpenseActor, expenseId: string, reason: string) {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(expenseId)) {
    throw new ExpenseError("Expense not found.", "EXPENSE_NOT_FOUND", 404);
  }

  const filter: Record<string, unknown> = { _id: new Types.ObjectId(expenseId), hostelId: actor.hostelId };

  if (!actor.canSeeAll) {
    filter.recordedBy = new Types.ObjectId(actor.principal.userId);
  }

  const existing = await ExpenseModel.findOne(filter).lean<ExpenseDoc | null>();

  if (!existing) {
    throw new ExpenseError("Expense not found.", "EXPENSE_NOT_FOUND", 404);
  }

  if (existing.status === "VOID") {
    throw new ExpenseError("This expense is already cancelled.", "EXPENSE_ALREADY_VOID", 409);
  }

  const updated = await ExpenseModel.findOneAndUpdate(
    { ...filter, status: "RECORDED" },
    {
      $set: {
        status: "VOID",
        voidReason: reason,
        voidedAt: new Date(),
        voidedBy: new Types.ObjectId(actor.principal.userId),
      },
    },
    { new: true },
  ).lean<ExpenseDoc | null>();

  if (!updated) {
    throw new ExpenseError("This expense is already cancelled.", "EXPENSE_ALREADY_VOID", 409);
  }

  await auditFinanceAction(actor.principal, {
    action: "EXPENSE_VOIDED",
    amountAfter: 0,
    amountBefore: existing.amount,
    entityId: existing._id,
    entityType: "Expense",
    hostelId: actor.hostelId,
    reason,
    source: "EXPENSE_VOID",
  });

  return serializeOne(actor, updated);
}

/* -------------------------------------------------------------------------- */
/* The hostel's own categories (owner only)                                   */
/* -------------------------------------------------------------------------- */

function assertOwner(actor: ExpenseActor) {
  if (!actor.canSeeAll) {
    throw new ExpenseError("Only the owner can change categories.", "CAPABILITY_DENIED", 403);
  }
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function assertNameFree(hostelId: Types.ObjectId, name: string, exceptId?: Types.ObjectId) {
  const builtIn = Object.values(EXPENSE_CATEGORY_LABELS).some(
    (label) => label.toLowerCase() === name.toLowerCase(),
  );
  const clash = await HostelExpenseCategoryModel.exists({
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
    hostelId,
    name: { $options: "i", $regex: `^${escapeRegex(name)}$` },
  });

  if (builtIn || clash) {
    throw new ExpenseError("You already have a category with this name.", "CATEGORY_EXISTS", 409);
  }
}

export async function createExpenseCategory(actor: ExpenseActor, name: string) {
  assertOwner(actor);
  await connectToDatabase();
  await assertNameFree(actor.hostelId, name);

  const count = await HostelExpenseCategoryModel.countDocuments({ hostelId: actor.hostelId });

  if (count >= EXPENSE_CUSTOM_CATEGORY_LIMIT) {
    throw new ExpenseError(
      `You can add up to ${EXPENSE_CUSTOM_CATEGORY_LIMIT} categories. Hide one you do not use.`,
      "CATEGORY_LIMIT",
      409,
    );
  }

  const created = await HostelExpenseCategoryModel.create({
    createdBy: new Types.ObjectId(actor.principal.userId),
    hostelId: actor.hostelId,
    name,
  });

  return { hidden: false, id: created._id.toString(), name: created.name as string };
}

export async function updateExpenseCategory(
  actor: ExpenseActor,
  categoryId: string,
  input: { hidden?: boolean; name?: string },
) {
  assertOwner(actor);
  await connectToDatabase();

  if (!Types.ObjectId.isValid(categoryId)) {
    throw new ExpenseError("Category not found.", "CATEGORY_NOT_FOUND", 404);
  }

  const id = new Types.ObjectId(categoryId);

  if (input.name) {
    await assertNameFree(actor.hostelId, input.name, id);
  }

  const updated = await HostelExpenseCategoryModel.findOneAndUpdate(
    { _id: id, hostelId: actor.hostelId },
    {
      $set: {
        ...(input.hidden === undefined ? {} : { hidden: input.hidden }),
        ...(input.name ? { name: input.name } : {}),
      },
    },
    { new: true },
  ).lean<{ _id: Types.ObjectId; hidden?: boolean; name: string } | null>();

  if (!updated) {
    throw new ExpenseError("Category not found.", "CATEGORY_NOT_FOUND", 404);
  }

  return { hidden: Boolean(updated.hidden), id: updated._id.toString(), name: updated.name };
}

/* -------------------------------------------------------------------------- */
/* The cook's switch (owner only)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Let the kitchen add what it spends, or stop it. An owner decision, not a
 * `manageFood` one: a warden who runs the menu does not get to hand the shared
 * kitchen login a way to put money on the hostel's books.
 */
export async function setCookExpensesEnabled(actor: ExpenseActor, enabled: boolean) {
  assertOwner(actor);
  await connectToDatabase();

  await HostelSettingsModel.updateOne(
    { hostelId: actor.hostelId },
    {
      $set: { cookCanRecordExpenses: enabled, updatedBy: actor.principal.userId },
      $setOnInsert: { hostelId: actor.hostelId },
    },
    { upsert: true },
  );

  return { expensesEnabled: enabled };
}

/** Reads suggestions only; creating an expense still requires an explicit Save. */
export async function readExpenseReceipt(actor: ExpenseActor, assetId: string) {
  await connectToDatabase();
  await assertPhotoUsable(actor, assetId);
  const asset = await FileAssetModel.findOne({ _id: assetId, hostelId: actor.hostelId, ownerId: actor.principal.userId, kind: "EXPENSE_RECEIPT", isDeleted: false, status: "ACTIVE" })
    .select("bucket key mimeType").lean<{ bucket: string; key: string; mimeType?: string } | null>();
  if (!asset) throw new ExpenseError("File not found", "NOT_FOUND", 404);
  const { readStoredObject } = await import("@/lib/uploads/verify");
  const { readEvidence, extractClaimFields } = await import("@/modules/finance/evidence-ocr");
  const bytes = await readStoredObject(asset);
  if (!bytes) throw new ExpenseError("Receipt could not be opened. Try again.", "READ_UNAVAILABLE", 503);
  const read = await readEvidence(bytes, asset.mimeType);
  return { fields: read.result?.text ? extractClaimFields(read.result.text) : {} };
}
