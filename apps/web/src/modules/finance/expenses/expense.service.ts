import { Types } from "mongoose";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { notifyHostelAdmins } from "@/modules/finance/finance-notify";

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
  isSpendingCategory,
  STAFF_CASH_CATEGORY,
  type StaffCashStatus,
} from "@hostel/shared/expenses/categories";
import { CookAccountModel } from "@hostel/db/models/CookAccount";
import { ExpenseModel } from "@hostel/db/models/Expense";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { HostelModel } from "@hostel/db/models/Hostel";
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
  cashNote?: string;
  cashRespondedAt?: Date;
  cashStatus?: StaffCashStatus | null;
  cashTo?: { name: string; userId: Types.ObjectId } | null;
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
  /** `STAFF_CASH` only: the warden's words when they said it never arrived. */
  cashNote: string | null;
  cashRespondedAt: string | null;
  /** `STAFF_CASH` only. Only `ACCEPTED` is in the warden's cash box. */
  cashStatus: StaffCashStatus | null;
  /** `STAFF_CASH` only: which warden the owner gave it to. */
  cashTo: { name: string; userId: string } | null;
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

export type ExpensePerson = {
  /** A warden who can add expenses — the only people the owner can hand cash to. */
  holdsCash: boolean;
  name: string;
  role: "WARDEN" | "COOK";
  userId: string;
};

/**
 * A warden's cash box in one hostel (docs/EXPENSES_PLAN.md §3.4), derived from
 * rows every time — never a stored number that can drift.
 *
 * `given` is cash the warden confirmed; `spent` is every expense they added
 * (whatever app they paid from: the money they spend is the money they were
 * given). `left` goes below zero when they paid from their own pocket, which
 * the screens read as "Hostel owes Hari Rs 400".
 */
export type StaffWallet = {
  given: number;
  left: number;
  name: string;
  /** Handed over but not yet confirmed — not in `left`. */
  pending: number;
  spent: number;
  userId: string;
};

export type ExpenseCategoryTotal = {
  amount: number;
  category: ExpenseCategoryValue;
  customCategoryId: string | null;
  label: string;
};

export type ExpenseHome = {
  canSeeTotals: boolean;
  /**
   * Cash handed over and not yet confirmed, any month. The warden sees what is
   * waiting for their "Got it"; the owner sees who has not answered yet.
   */
  pendingCash: ExpenseRow[];
  /** Whether the asker must attach a bill photo to save. Never for the owner. */
  proofRequired: boolean;
  /** The asker's own cash box — wardens only. */
  wallet: StaffWallet | null;
  /** Every warden's cash box — the owner only. */
  wallets: StaffWallet[] | null;
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
    cashNote: doc.cashNote ?? null,
    cashRespondedAt: doc.cashRespondedAt ? doc.cashRespondedAt.toISOString() : null,
    cashStatus: doc.cashStatus ?? null,
    cashTo: doc.cashTo ? { name: doc.cashTo.name, userId: doc.cashTo.userId.toString() } : null,
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

/**
 * Every recorded expense, newest first — the debit half of the hostel
 * statement (`GET /finance/invoices/ledger`). Voided rows are left out: the
 * statement is what actually moved, and a cancelled expense never did.
 *
 * Owner-only by construction: the caller passes the owner's id, and the ledger
 * route only asks when the principal is `HOSTEL_ADMIN` — the same line
 * `canSeeAll` draws on the expenses screen.
 */
export async function listLedgerExpenses(
  hostelId: Types.ObjectId | string,
  askerId: string,
  limit: number,
  /** A warden's statement: only what they recorded or were handed — the expenses screen's own scope. */
  mineOnly = false,
): Promise<{ expenses: ExpenseRow[]; truncated: boolean }> {
  await connectToDatabase();

  const id = typeof hostelId === "string" ? new Types.ObjectId(hostelId) : hostelId;
  const me = new Types.ObjectId(askerId);
  const [docs, categories] = await Promise.all([
    // A handover the warden says never arrived is not money that moved.
    ExpenseModel.find({
      cashStatus: { $ne: "DECLINED" },
      hostelId: id,
      status: "RECORDED",
      ...(mineOnly
        ? { $or: [{ recordedBy: me }, { category: STAFF_CASH_CATEGORY, "cashTo.userId": me }] }
        : {}),
    })
      .sort({ spentOn: -1, createdAt: -1 })
      .limit(limit)
      .lean<ExpenseDoc[]>(),
    loadCustomCategories(id),
  ]);
  const customNames = new Map(categories.map((category) => [category.id, category.name]));

  return {
    expenses: docs.map((doc) => serializeExpense(doc, askerId, customNames)),
    truncated: docs.length >= limit,
  };
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
      .select("permissions userId")
      .lean<{ permissions?: string[]; userId: Types.ObjectId }[]>(),
    CookAccountModel.find({ hostelId, status: "ACTIVE", userId: { $ne: null } })
      .select("name userId")
      .lean<{ name: string; userId?: Types.ObjectId }[]>(),
  ]);

  const users = members.length
    ? await UserModel.find({ _id: { $in: members.map((member) => member.userId) } })
        .select("name")
        .lean<{ _id: Types.ObjectId; name: string }[]>()
    : [];

  const canSpend = new Set(
    members
      .filter((member) => member.permissions?.includes("recordExpenses"))
      .map((member) => member.userId.toString()),
  );

  return [
    ...users.map((user) => ({
      holdsCash: canSpend.has(user._id.toString()),
      name: user.name,
      role: "WARDEN" as const,
      userId: user._id.toString(),
    })),
    ...cooks
      .filter((cook) => cook.userId)
      .map((cook) => ({
        holdsCash: false,
        name: cook.name,
        role: "COOK" as const,
        userId: cook.userId!.toString(),
      })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

/* -------------------------------------------------------------------------- */
/* Cash boxes                                                                 */
/* -------------------------------------------------------------------------- */

/** Every handover still waiting for the warden's answer. */
function pendingCashFilter(hostelId: Types.ObjectId, userId?: Types.ObjectId) {
  return {
    category: STAFF_CASH_CATEGORY,
    cashStatus: "PENDING",
    hostelId,
    status: "RECORDED",
    ...(userId ? { "cashTo.userId": userId } : {}),
  };
}

const EMPTY_WALLET = { given: 0, left: 0, pending: 0, spent: 0 };

/**
 * The cash boxes of one hostel — every warden who can hold cash, plus anyone
 * with a handover or a staff expense on the books (a warden removed since keeps
 * their history). Pass `userId` for one person's box.
 *
 * Per hostel, so a warden of two branches has two boxes and neither branch's
 * owner view mixes in the other's money.
 */
export async function listStaffWallets(
  hostelId: Types.ObjectId,
  people: ExpensePerson[],
  userId?: Types.ObjectId,
): Promise<StaffWallet[]> {
  const [handed, spent] = await Promise.all([
    ExpenseModel.aggregate<{ _id: { status: StaffCashStatus; user: Types.ObjectId }; name: string; total: number }>([
      {
        $match: {
          category: STAFF_CASH_CATEGORY,
          cashStatus: { $in: ["PENDING", "ACCEPTED"] },
          hostelId,
          status: "RECORDED",
          ...(userId ? { "cashTo.userId": userId } : {}),
        },
      },
      {
        $group: {
          _id: { status: "$cashStatus", user: "$cashTo.userId" },
          name: { $last: "$cashTo.name" },
          total: { $sum: "$amount" },
        },
      },
    ]),
    ExpenseModel.aggregate<{ _id: Types.ObjectId; name: string; total: number }>([
      {
        $match: {
          category: { $ne: STAFF_CASH_CATEGORY },
          hostelId,
          payer: "STAFF",
          recordedByRole: "WARDEN",
          status: "RECORDED",
          ...(userId ? { recordedBy: userId } : {}),
        },
      },
      { $group: { _id: "$recordedBy", name: { $last: "$recordedByName" }, total: { $sum: "$amount" } } },
    ]),
  ]);

  const boxes = new Map<string, StaffWallet>();
  const box = (id: string, name: string) => {
    const existing = boxes.get(id) ?? { ...EMPTY_WALLET, name, userId: id };

    boxes.set(id, existing);

    return existing;
  };

  for (const person of people) {
    if (person.holdsCash && (!userId || person.userId === userId.toString())) box(person.userId, person.name);
  }

  for (const row of handed) {
    const entry = box(row._id.user.toString(), row.name);

    if (row._id.status === "ACCEPTED") entry.given += row.total;
    else entry.pending += row.total;
  }

  for (const row of spent) {
    box(row._id.toString(), row.name || "Warden").spent += row.total;
  }

  const names = new Map(people.map((person) => [person.userId, person.name]));

  return [...boxes.values()]
    .map((entry) => ({ ...entry, left: entry.given - entry.spent, name: names.get(entry.userId) ?? entry.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The owner never has to attach a bill. A warden must, unless the owner
 * switched "Bill photo needed" off for them (`expenseWithoutProof`). The cook
 * has no such switch, so the kitchen always does.
 */
export async function isProofRequired(actor: ExpenseActor): Promise<boolean> {
  if (actor.role === "HOSTEL_ADMIN") return false;
  if (actor.role === "COOK") return true;

  const waived = await HostelMemberModel.exists({
    hostelId: actor.hostelId,
    isDeleted: { $ne: true },
    permissions: "expenseWithoutProof",
    status: "ACTIVE",
    userId: actor.principal.userId,
  });

  return !waived;
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

  const me = new Types.ObjectId(askerId);

  if (!actor.canSeeAll) {
    // Their own rows, and the cash the owner handed them — nobody else's.
    scope.$or = [{ recordedBy: me }, { category: STAFF_CASH_CATEGORY, "cashTo.userId": me }];
  }

  const [docs, categories, people, pendingDocs, proofRequired] = await Promise.all([
    ExpenseModel.find(scope)
      .sort({ spentOn: -1, createdAt: -1 })
      .limit(MAX_ROWS_PER_MONTH)
      .lean<ExpenseDoc[]>(),
    loadCustomCategories(actor.hostelId),
    loadPeople(actor.hostelId),
    ExpenseModel.find(pendingCashFilter(actor.hostelId, actor.canSeeAll ? undefined : me))
      .sort({ spentOn: -1, createdAt: -1 })
      .limit(50)
      .lean<ExpenseDoc[]>(),
    isProofRequired(actor),
  ]);

  const customNames = new Map(categories.map((category) => [category.id, category.name]));
  const expenses = docs.map((doc) => serializeExpense(doc, askerId, customNames));
  const recorded = expenses.filter((row) => row.status === "RECORDED");
  const spending = recorded.filter((row) => isSpendingCategory(row.category));
  const mineRows = spending.filter((row) => row.mine);
  const wallets =
    actor.canSeeAll || actor.role === "WARDEN"
      ? await listStaffWallets(actor.hostelId, people, actor.canSeeAll ? undefined : me)
      : [];

  const home: ExpenseHome = {
    canSeeTotals: actor.canSeeAll,
    categories: actor.canSeeAll ? categories : categories.filter((category) => !category.hidden),
    currentPeriod: currentBsPeriod(),
    expenses,
    mine: { count: mineRows.length, out: mineRows.reduce((sum, row) => sum + row.amount, 0) },
    pendingCash: pendingDocs.map((doc) => serializeExpense(doc, askerId, customNames)),
    people,
    period,
    proofRequired,
    role: actor.role,
    totals: null,
    wallet:
      actor.role === "WARDEN" ? wallets[0] ?? { ...EMPTY_WALLET, name: "", userId: askerId } : null,
    wallets: actor.canSeeAll ? wallets : null,
  };

  if (!actor.canSeeAll) {
    return home;
  }

  const lastPeriod = addBsMonths(period, -1);
  const [moneyIn, lastMonth] = await Promise.all([
    moneyInForPeriod(actor.hostelId, period),
    ExpenseModel.aggregate<{ total: number }>([
      {
        $match: {
          category: { $ne: STAFF_CASH_CATEGORY },
          hostelId: actor.hostelId,
          spentOn: periodFilter(lastPeriod),
          status: "RECORDED",
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
  ]);

  // Cash handed to a warden is not spending; what they buy with it is.
  const out = spending.reduce((sum, row) => sum + row.amount, 0);
  const byCategory = new Map<string, ExpenseCategoryTotal>();

  for (const row of spending) {
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
    staffCount: spending.filter((row) => row.recordedBy.role !== "HOSTEL_ADMIN").length,
  };

  return home;
}

/** A month's money out for the owner's report PDF. */
export type MonthMoneyOut = {
  byCategory: ExpenseCategoryTotal[];
  out: number;
  /** Every row that stands, oldest first: spending, and cash handed to wardens. */
  rows: ExpenseRow[];
  /** Each warden's cash box as it stands now. */
  staff: StaffWallet[];
};

/**
 * Where the month's money went, for the performance report: the category
 * split, each warden's box, and every line — when, what, who, how much.
 * Owner only by construction: the report asks only for `HOSTEL_ADMIN`.
 */
export async function getMonthMoneyOut(
  hostelId: Types.ObjectId,
  period: string,
  askerId: string,
): Promise<MonthMoneyOut> {
  await connectToDatabase();

  const [docs, categories, people] = await Promise.all([
    ExpenseModel.find({
      cashStatus: { $ne: "DECLINED" },
      hostelId,
      spentOn: periodFilter(period),
      status: "RECORDED",
    })
      .sort({ spentOn: 1, createdAt: 1 })
      .limit(MAX_ROWS_PER_MONTH)
      .lean<ExpenseDoc[]>(),
    loadCustomCategories(hostelId),
    loadPeople(hostelId),
  ]);
  const customNames = new Map(categories.map((category) => [category.id, category.name]));
  const rows = docs.map((doc) => serializeExpense(doc, askerId, customNames));
  const byCategory = new Map<string, ExpenseCategoryTotal>();
  let out = 0;

  for (const row of rows) {
    if (!isSpendingCategory(row.category)) continue;

    const key = row.category === CUSTOM_EXPENSE_CATEGORY ? `C:${row.customCategoryId}` : row.category;
    const entry = byCategory.get(key) ?? {
      amount: 0,
      category: row.category,
      customCategoryId: row.customCategoryId,
      label: row.categoryLabel,
    };

    entry.amount += row.amount;
    out += row.amount;
    byCategory.set(key, entry);
  }

  return {
    byCategory: [...byCategory.values()].sort((a, b) => b.amount - a.amount),
    out,
    rows,
    staff: await listStaffWallets(hostelId, people),
  };
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
    .select("contentHash hostelId kind ownerId receiptTxnId uploadCompletedAt")
    .lean<{
      contentHash?: string;
      hostelId?: Types.ObjectId;
      kind?: string;
      ownerId?: Types.ObjectId;
      receiptTxnId?: string;
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

  return { contentHash: asset.contentHash, id: new Types.ObjectId(assetId), receiptTxnId: asset.receiptTxnId };
}

/** The main hostel of this building's group: itself, or the hostel it is a branch of. */
async function receiptGroup(hostelId: Types.ObjectId) {
  const hostel = await HostelModel.findById(hostelId)
    .select("parentHostelId")
    .lean<{ parentHostelId?: Types.ObjectId | null } | null>();
  return hostel?.parentHostelId ?? hostelId;
}

type SavedReceipt = { amount: number; by: string; what: string; where: string | null };

/**
 * The standing expense already holding this receipt anywhere in the hostel
 * group — the same bytes or the same transaction id. Two point lookups on the
 * `receiptGroupId` indexes; the branch is only named when the hit is elsewhere.
 */
async function findSavedReceipt(
  actor: ExpenseActor,
  groupId: Types.ObjectId,
  receipt: { hash?: string | null; txnId?: string | null },
): Promise<SavedReceipt | null> {
  const match = [
    ...(receipt.hash ? [{ receiptHash: receipt.hash }] : []),
    ...(receipt.txnId ? [{ receiptTxnId: receipt.txnId }] : []),
  ];
  if (!match.length) return null;
  const saved = await ExpenseModel.findOne({ receiptGroupId: groupId, status: "RECORDED", $or: match })
    .select("amount hostelId recordedByName what")
    .lean<{ amount: number; hostelId: Types.ObjectId; recordedByName?: string; what?: string } | null>();
  if (!saved) return null;
  const elsewhere = saved.hostelId.toString() !== actor.hostelId.toString()
    ? await HostelModel.findById(saved.hostelId).select("name").lean<{ name?: string } | null>()
    : null;
  return { amount: saved.amount, by: saved.recordedByName ?? "", what: saved.what ?? "", where: elsewhere?.name ?? null };
}

function receiptAlreadySaved(saved: SavedReceipt) {
  return new ExpenseError(
    `Already added: ${rupees(saved.amount)}${saved.by ? ` by ${saved.by}` : ""}${saved.where ? ` in ${saved.where}` : ""}.`,
    "RECEIPT_ALREADY_SAVED",
    409,
  );
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

  let cashTo: { name: string; userId: Types.ObjectId } | null = null;

  if (input.category === STAFF_CASH_CATEGORY) {
    if (!actor.canSeeAll) {
      throw new ExpenseError("Only the owner can give cash to a warden.", "CAPABILITY_DENIED", 403);
    }

    // Only a warden of *this* hostel who can add expenses — a box nobody can
    // spend from, or a warden of another branch, is refused.
    const person = (await loadPeople(actor.hostelId)).find(
      (entry) => entry.holdsCash && entry.userId === input.cashTo?.userId,
    );

    if (!person) {
      throw new ExpenseError(
        "Pick a warden of this hostel who can add expenses.",
        "CASH_TO_NOT_STAFF",
        422,
      );
    }

    cashTo = { name: person.name, userId: new Types.ObjectId(person.userId) };
  }

  if (!input.photoAssetId && (await isProofRequired(actor))) {
    throw new ExpenseError("Add a photo of the bill or the goods.", "PROOF_REQUIRED", 422);
  }

  const photo = input.photoAssetId ? await assertPhotoUsable(actor, input.photoAssetId) : null;
  const photoAssetId = photo?.id ?? null;
  const receipt = input.sharedReceipt && photo
    ? { groupId: await receiptGroup(actor.hostelId), hash: photo.contentHash ?? null, txnId: photo.receiptTxnId ?? null }
    : null;

  if (receipt) {
    const saved = await findSavedReceipt(actor, receipt.groupId, receipt);
    if (saved) throw receiptAlreadySaved(saved);
  }

  let doc: ExpenseDoc;

  try {
    const created = await ExpenseModel.create({
      amount: input.amount,
      cashStatus: cashTo ? "PENDING" : null,
      cashTo,
      category: input.category,
      clientRequestId: input.clientRequestId ?? null,
      customCategoryId,
      hostelId: actor.hostelId,
      paidBy: input.paidBy,
      payer: actor.role === "HOSTEL_ADMIN" ? "HOSTEL" : "STAFF",
      photoAssetId,
      receiptGroupId: receipt?.groupId ?? null,
      receiptHash: receipt?.hash ?? null,
      receiptTxnId: receipt?.txnId ?? null,
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

    // Two people saved the same payment at once; the receipt index kept one.
    if (receipt && isDuplicateKeyError(error)) {
      const saved = await findSavedReceipt(actor, receipt.groupId, receipt);
      if (saved) throw receiptAlreadySaved(saved);
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

  if (cashTo) {
    await notifyQuietly({
      actionUrl: "/app/expenses",
      body: `${rupees(doc.amount)} from the owner. Open Expenses and tap Got it.`,
      data: { expenseId: doc._id.toString(), type: "STAFF_CASH_GIVEN" },
      hostelId: actor.hostelId,
      title: "Cash for the hostel",
      userId: cashTo.userId.toString(),
    });
  }

  // Staff spending reaches the owner's phone the moment it is recorded.
  if (actor.role !== "HOSTEL_ADMIN") {
    await notifyHostelAdmins({
      actionUrl: "/app/expenses",
      body: `${doc.recordedByName || "Staff"} recorded ${rupees(doc.amount)}${doc.what ? ` — ${doc.what}` : ""}.`,
      data: { expenseId: doc._id.toString(), type: "STAFF_EXPENSE_RECORDED" },
      exceptUserId: actor.principal.userId,
      hostelId: actor.hostelId,
      title: "New expense recorded",
    });
  }

  if (input.sharedReceipt && photoAssetId) {
    try {
      await createInAppNotification({
        actionUrl: "/app/expenses",
        body: `Your shared receipt was saved as an expense of NPR ${doc.amount.toLocaleString("en-US")}.`,
        category: "PAYMENT",
        data: { expenseId: doc._id.toString(), type: "SHARED_RECEIPT_SAVED" },
        hostelId: actor.hostelId.toString(),
        kind: "NORMAL",
        // The Android share sheet draws its own notice; a push would be a second one.
        push: !input.notifiedOnDevice,
        title: "Receipt saved",
        userId: actor.principal.userId,
      });
    } catch (error) {
      // Delivery must never turn a committed expense into a failed Save.
      console.warn("receipt_saved_notification_failed", doc._id.toString(), error);
    }
  }

  return { duplicate: false, expense: await serializeOne(actor, doc) };
}

function rupees(amount: number) {
  return `Rs ${amount.toLocaleString("en-IN")}`;
}

/** Delivery must never turn a committed write into a failed request. */
async function notifyQuietly(input: {
  actionUrl: string;
  body: string;
  data: Record<string, string>;
  hostelId: Types.ObjectId;
  title: string;
  userId: string;
}) {
  try {
    await createInAppNotification({
      ...input,
      category: "PAYMENT",
      hostelId: input.hostelId.toString(),
      kind: "NORMAL",
    });
  } catch (error) {
    console.warn("staff_cash_notification_failed", input.data.expenseId, error);
  }
}

/**
 * The warden's answer to cash the owner says they handed over. **Got it** puts
 * it in their box; **Not received** keeps the row (and the owner's claim) on the
 * record with the warden's words, out of the box and out of the statement.
 * Only the warden it was given to can answer, and only once.
 */
export async function respondToStaffCash(
  actor: ExpenseActor,
  expenseId: string,
  input: { accept: boolean; note?: string },
) {
  await connectToDatabase();

  if (actor.role !== "WARDEN" || !Types.ObjectId.isValid(expenseId)) {
    throw new ExpenseError("Cash not found.", "EXPENSE_NOT_FOUND", 404);
  }

  const updated = await ExpenseModel.findOneAndUpdate(
    {
      ...pendingCashFilter(actor.hostelId, new Types.ObjectId(actor.principal.userId)),
      _id: new Types.ObjectId(expenseId),
    },
    {
      $set: {
        cashNote: input.accept ? undefined : input.note || "Not received",
        cashRespondedAt: new Date(),
        cashStatus: input.accept ? "ACCEPTED" : "DECLINED",
      },
    },
    { new: true },
  ).lean<ExpenseDoc | null>();

  if (!updated) {
    throw new ExpenseError("This cash was already answered, or is not yours.", "CASH_NOT_PENDING", 409);
  }

  await auditFinanceAction(actor.principal, {
    action: input.accept ? "STAFF_CASH_ACCEPTED" : "STAFF_CASH_DECLINED",
    amountAfter: input.accept ? updated.amount : 0,
    amountBefore: 0,
    entityId: updated._id,
    entityType: "Expense",
    hostelId: actor.hostelId,
    reason: input.accept ? undefined : updated.cashNote,
    source: "STAFF_CASH",
  });

  const name = updated.cashTo?.name || "The warden";

  await notifyQuietly({
    actionUrl: "/app/expenses",
    body: input.accept
      ? `${name} got ${rupees(updated.amount)}.`
      : `${name} says ${rupees(updated.amount)} did not reach them.`,
    data: { expenseId: updated._id.toString(), type: input.accept ? "STAFF_CASH_ACCEPTED" : "STAFF_CASH_DECLINED" },
    hostelId: actor.hostelId,
    title: input.accept ? "Cash received" : "Cash not received",
    userId: updated.recordedBy.toString(),
  });

  return serializeOne(actor, updated);
}

/**
 * One warden's cash box with its whole history, newest first: what the owner
 * handed over (+) and every expense they added (−), each with its bill photo.
 * The owner names the warden; a warden only ever gets their own.
 */
export async function getStaffWallet(actor: ExpenseActor, requestedUserId?: string) {
  await connectToDatabase();

  if (actor.role === "COOK" || (actor.canSeeAll && !requestedUserId)) {
    throw new ExpenseError("Pick a warden.", "WALLET_USER_REQUIRED", 422);
  }

  const userId = new Types.ObjectId(actor.canSeeAll ? requestedUserId : actor.principal.userId);
  const [people, categories, docs] = await Promise.all([
    loadPeople(actor.hostelId),
    loadCustomCategories(actor.hostelId),
    ExpenseModel.find({
      $or: [
        { category: STAFF_CASH_CATEGORY, "cashTo.userId": userId },
        { category: { $ne: STAFF_CASH_CATEGORY }, payer: "STAFF", recordedBy: userId, recordedByRole: "WARDEN" },
      ],
      hostelId: actor.hostelId,
    })
      .sort({ spentOn: -1, createdAt: -1 })
      .limit(MAX_ROWS_PER_MONTH)
      .lean<ExpenseDoc[]>(),
  ]);
  const [wallet] = await listStaffWallets(actor.hostelId, people, userId);
  const customNames = new Map(categories.map((category) => [category.id, category.name]));

  if (!wallet && docs.length === 0) {
    throw new ExpenseError("This warden has no cash box here.", "WALLET_NOT_FOUND", 404);
  }

  return {
    rows: docs.map((doc) => serializeExpense(doc, actor.principal.userId, customNames)),
    truncated: docs.length >= MAX_ROWS_PER_MONTH,
    wallet: wallet ?? { ...EMPTY_WALLET, name: docs[0]?.cashTo?.name ?? "", userId: userId.toString() },
  };
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

/** Suggestions only; the share client applies the user's opt-in auto-save preference. */
export async function readExpenseReceipt(actor: ExpenseActor, assetId: string) {
  await connectToDatabase();
  await assertPhotoUsable(actor, assetId);
  const asset = await FileAssetModel.findOne({ _id: assetId, hostelId: actor.hostelId, ownerId: actor.principal.userId, kind: "EXPENSE_RECEIPT", isDeleted: false, status: "ACTIVE" })
    .select("bucket contentHash key mimeType").lean<{ bucket: string; contentHash?: string; key: string; mimeType?: string } | null>();
  if (!asset) throw new ExpenseError("File not found", "NOT_FOUND", 404);
  const { readStoredObject } = await import("@/lib/uploads/verify");
  const { readEvidence } = await import("@/modules/finance/evidence-ocr");
  const bytes = await readStoredObject(asset);
  if (!bytes) throw new ExpenseError("Receipt could not be opened. Try again.", "READ_UNAVAILABLE", 503);
  const read = await readEvidence(bytes, asset.mimeType);
  const { expenseReceiptSuggestions } = await import("./receipt-suggestions");
  const suggestions = expenseReceiptSuggestions(read.result?.text ?? null);
  if (suggestions.txnId) await FileAssetModel.updateOne({ _id: assetId }, { $set: { receiptTxnId: suggestions.txnId } });
  const [saved, hostel] = await Promise.all([
    receiptGroup(actor.hostelId).then((group) => findSavedReceipt(actor, group, { hash: asset.contentHash, txnId: suggestions.txnId })),
    receiptHostel(actor.hostelId),
  ]);
  return { ...suggestions, alreadySaved: saved, autoSaveEligible: suggestions.autoSaveEligible && !saved, hostel };
}

/**
 * Which hostel the share sheet is saving into, by name. A main hostel and its
 * branch often share one name, so `kind` tells them apart; a hostel with no
 * branches gets none.
 */
async function receiptHostel(hostelId: Types.ObjectId | string) {
  const hostel = await HostelModel.findById(hostelId).select("name parentHostelId location.area")
    .lean<{ name: string; parentHostelId?: Types.ObjectId | null; location?: { area?: string } } | null>();
  if (!hostel) return null;
  const kind = hostel.parentHostelId ? "Branch"
    : await HostelModel.exists({ parentHostelId: hostelId, isDeleted: { $ne: true } }) ? "Main hostel" : null;
  return { area: hostel.location?.area ?? "", kind, name: hostel.name };
}
