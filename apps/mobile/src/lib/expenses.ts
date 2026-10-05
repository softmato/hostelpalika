/**
 * Money Out — the pure half (docs/EXPENSES_PLAN.md).
 *
 * Kept free of the axios client for the same reason as `lib/admin-money.ts`:
 * Vitest runs node-side here with no React Native shim, so the parts worth
 * testing — the Nepali dates, the day groups, reading an amount someone typed —
 * live here and the screens are renderers over them.
 *
 * ## Every date in this feature is Bikram Sambat
 *
 * The owner asked for it outright: *"date is auto picked as today, Nepali date,
 * all everywhere"*. So these screens spell days with the BS helpers directly
 * rather than through the portal's calendar preference — an expense is written
 * down the way the shop's bill is dated. What travels to the server is the
 * Gregorian day (`2026-10-01`), the one shape the API accepts, so neither end
 * has to guess which calendar a string is in.
 */
import type { Ionicons } from "@expo/vector-icons";

import { bsMonthName, hostelToday, toBs } from "@hostel/calendar/bs";
import {
  EXPENSE_CATEGORY_KEYS,
  EXPENSE_CATEGORY_LABELS,
  type ExpenseCategoryKey,
  type ExpenseCategoryValue,
  type ExpensePaidBy,
} from "@hostel/expenses/categories";
import { dayFromKey, dayKey, todayKey } from "@hostel/expenses/input";

export {
  dayKey,
  parseAmountInput,
  parseBsDayInput,
  toBsDayInput,
  todayKey,
} from "@hostel/expenses/input";
export {
  EXPENSE_AMOUNT_MAX,
  EXPENSE_CATEGORY_KEYS,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_PAID_BY,
  EXPENSE_PAID_BY_LABELS,
  EXPENSE_WHAT_MAX,
} from "@hostel/expenses/categories";
export type { ExpenseCategoryKey, ExpenseCategoryValue, ExpensePaidBy };

/* -------------------------------------------------------------------------- */
/* Shapes — mirror `modules/finance/expenses/expense.service.ts`              */
/* -------------------------------------------------------------------------- */

export type ExpenseRecorderRole = "COOK" | "HOSTEL_ADMIN" | "WARDEN";

export type StaffCashStatus = "ACCEPTED" | "DECLINED" | "PENDING";

export type ExpenseRow = {
  amount: number;
  /** `STAFF_CASH` only — see the server's `ExpenseRow`. */
  cashNote: string | null;
  cashRespondedAt: string | null;
  cashStatus: StaffCashStatus | null;
  cashTo: { name: string; userId: string } | null;
  category: ExpenseCategoryValue;
  categoryLabel: string;
  createdAt: string | null;
  customCategoryId: string | null;
  id: string;
  mine: boolean;
  paidBy: ExpensePaidBy;
  payer: "HOSTEL" | "STAFF";
  photoAssetId: string | null;
  recordedBy: { id: string; name: string; role: ExpenseRecorderRole };
  salaryFor: { name: string; userId: string | null } | null;
  /** Gregorian calendar day, `YYYY-MM-DD`. Shown in BS. */
  spentOn: string;
  status: "RECORDED" | "VOID";
  voidReason: string | null;
  voidedAt: string | null;
  what: string;
};

export type CustomExpenseCategory = { hidden: boolean; id: string; name: string };

export type ExpensePerson = {
  /** A warden with Add expenses — the only people the owner can give cash to. */
  holdsCash: boolean;
  name: string;
  role: "COOK" | "WARDEN";
  userId: string;
};

/** A warden's cash box. `left < 0` reads "Hostel owes". `pending` is not in `left`. */
export type StaffWallet = {
  given: number;
  left: number;
  name: string;
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
  categories: CustomExpenseCategory[];
  currentPeriod: string;
  expenses: ExpenseRow[];
  mine: { count: number; out: number };
  /** Cash handed over and not yet answered, any month. */
  pendingCash: ExpenseRow[];
  people: ExpensePerson[];
  period: string;
  /** Saving needs a bill photo. Never for the owner. */
  proofRequired: boolean;
  role: ExpenseRecorderRole;
  /** The warden's own box; `null` for the owner and the cook. */
  wallet: StaffWallet | null;
  /** Every warden's box; the owner only. */
  wallets: StaffWallet[] | null;
  totals: {
    byCategory: ExpenseCategoryTotal[];
    in: number;
    lastMonthOut: number;
    left: number;
    out: number;
    staffCount: number;
  } | null;
};

/* -------------------------------------------------------------------------- */
/* Icons                                                                      */
/* -------------------------------------------------------------------------- */

type IconName = keyof typeof Ionicons.glyphMap;

/**
 * One glyph per category. Recognised by shape, not colour: every tile is the
 * brand tint, because the app's palette is black, white and green and a rainbow
 * of categories would spend colour that means something elsewhere.
 */
export const EXPENSE_CATEGORY_ICONS: Record<ExpenseCategoryKey, IconName> = {
  CLEANING: "sparkles-outline",
  ELECTRICITY: "flash-outline",
  GAS: "flame-outline",
  GROCERIES: "basket-outline",
  INTERNET: "wifi-outline",
  OTHER: "ellipsis-horizontal-circle-outline",
  RENT: "business-outline",
  REPAIR: "construct-outline",
  SALARY: "people-outline",
  STAFF_CASH: "wallet-outline",
  VEGETABLES_MEAT: "leaf-outline",
  WATER: "water-outline",
};

/** A hostel's own categories share one glyph: a tag, because that is what they are. */
export const CUSTOM_CATEGORY_ICON: IconName = "pricetag-outline";

export function expenseIcon(category: ExpenseCategoryValue): IconName {
  return category === "CUSTOM" ? CUSTOM_CATEGORY_ICON : EXPENSE_CATEGORY_ICONS[category];
}

/** The built-in tiles, in the order the add screen draws them. */
export const BUILT_IN_CATEGORIES = EXPENSE_CATEGORY_KEYS.map((key) => ({
  icon: EXPENSE_CATEGORY_ICONS[key],
  key,
  label: EXPENSE_CATEGORY_LABELS[key],
}));

/* -------------------------------------------------------------------------- */
/* Days                                                                       */
/* -------------------------------------------------------------------------- */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `Asoj 15` — the short BS form for chips and headings. */
export function bsDayMonth(key: string): string {
  const day = dayFromKey(key);

  if (!day) return "";

  const bs = toBs(day);

  return `${bsMonthName(bs.month)} ${bs.day}`;
}

/** `Asoj 15, 2083` — the full BS form. */
export function bsDayLong(key: string): string {
  const day = dayFromKey(key);

  if (!day) return "";

  const bs = toBs(day);

  return `${bsMonthName(bs.month)} ${bs.day}, ${bs.year}`;
}

/** `Today`, `Yesterday`, or the BS day — whichever a person would say. */
export function relativeBsDay(key: string, now: Date = new Date()): string {
  const today = todayKey(now);

  if (key === today) return "Today";
  if (key === dayKey(new Date(hostelToday(now).getTime() - MS_PER_DAY))) return "Yesterday";

  return bsDayLong(key);
}

export type DayChoice = { key: string; label: string; sub: string };

/**
 * The last week as tappable chips: `Today · Asoj 15`, `Yesterday · Asoj 14`, …
 *
 * A row of chips rather than a date picker — `docs/DESIGN.md` rules out building
 * one, and nearly every expense is today's or this week's. An older bill goes
 * through {@link parseBsDayInput}.
 */
export function recentDayChoices(now: Date = new Date(), days = 7): DayChoice[] {
  const today = hostelToday(now).getTime();

  return Array.from({ length: days }, (_, index) => {
    const key = dayKey(new Date(today - index * MS_PER_DAY));

    return {
      key,
      label: index === 0 ? "Today" : index === 1 ? "Yesterday" : bsDayMonth(key),
      sub: index <= 1 ? bsDayMonth(key) : `${toBs(dayFromKey(key)!).year}`,
    };
  });
}

/** Not after today in Nepal. The server refuses it too; this says so sooner. */
export function isFutureDay(key: string, now: Date = new Date()): boolean {
  return key > todayKey(now);
}

/* -------------------------------------------------------------------------- */
/* Amounts                                                                    */
/* -------------------------------------------------------------------------- */

/** `2400` → `2,400`, for the field as the person types. */
export function groupDigits(value: string): string {
  const digits = value.replace(/\D/g, "").replace(/^0+(?=\d)/, "");

  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/* -------------------------------------------------------------------------- */
/* Lists                                                                      */
/* -------------------------------------------------------------------------- */

export type ExpenseDay = {
  key: string;
  label: string;
  rows: ExpenseRow[];
  /** What still stands that day — a cancelled row is listed, never counted. */
  total: number;
};

/** Newest day first, headings to sit outside the cards (NOTES §5). */
export function groupExpensesByDay(rows: readonly ExpenseRow[], now: Date = new Date()): ExpenseDay[] {
  const days = new Map<string, ExpenseDay>();

  for (const row of rows) {
    const day = days.get(row.spentOn) ?? {
      key: row.spentOn,
      label: relativeBsDay(row.spentOn, now),
      rows: [],
      total: 0,
    };

    day.rows.push(row);

    // Cash handed to a warden is listed, not counted: their expenses are.
    if (row.status === "RECORDED" && isSpending(row)) day.total += row.amount;

    days.set(row.spentOn, day);
  }

  return [...days.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
}

export const CASH_STATUS_LABELS: Record<StaffCashStatus, string> = {
  ACCEPTED: "Got it",
  DECLINED: "Not received",
  PENDING: "Waiting",
};

/** The line under a row's title: who added it, and how it was paid. */
export function expenseSubtitle(row: ExpenseRow, showWho: boolean): string {
  const parts = [
    row.cashStatus ? CASH_STATUS_LABELS[row.cashStatus] : null,
    row.salaryFor ? `For ${row.salaryFor.name}` : null,
    showWho && !row.mine ? row.recordedBy.name || "Staff" : null,
    row.paidBy === "CASH" ? "Cash" : row.paidBy === "ESEWA" ? "eSewa" : row.paidBy === "KHALTI" ? "Khalti" : "Bank",
  ];

  return parts.filter(Boolean).join(" · ");
}

/** The row's title: what it was for, or the category when nothing was written. */
export function expenseTitle(row: ExpenseRow): string {
  if (row.cashTo) return `Cash to ${row.cashTo.name}`;

  return row.what.trim() || row.categoryLabel;
}

/** Real spending — everything but cash handed to a warden. */
export function isSpending(row: ExpenseRow): boolean {
  return row.cashTo === null;
}

/**
 * What a cash box can still cover, as a share of what was handed over — the
 * fuel gauge on the box. `null` before anything was given.
 */
export function walletPercent(wallet: StaffWallet): number | null {
  if (wallet.given <= 0) return null;

  return Math.max(0, Math.round((wallet.left / wallet.given) * 100));
}

/**
 * How this month compares with the last, for the top category line.
 * `null` when there is nothing to compare with.
 */
export function monthChange(out: number, lastMonthOut: number): { more: boolean; amount: number } | null {
  if (lastMonthOut <= 0 || out === lastMonthOut) return null;

  return { amount: Math.abs(out - lastMonthOut), more: out > lastMonthOut };
}

/** A fresh id per Save tap; a retry of the same tap reuses it. */
export function newClientRequestId(): string {
  return `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
