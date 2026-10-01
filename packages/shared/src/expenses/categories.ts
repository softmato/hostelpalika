/**
 * What a hostel spends money on — the built-in list (docs/EXPENSES_PLAN.md §3.3).
 *
 * One file, imported by the server, the web page and the app (through the
 * `@hostel/expenses/*` alias in `apps/mobile/metro.config.js`), so a category the
 * add screen offers is always one the API accepts and the totals group by.
 *
 * **No icons here.** The app draws Ionicons and the web draws lucide; each side
 * maps a key to its own glyph. Labels are A1 English and stay short enough to
 * sit under a tile on a small phone.
 *
 * Order is the tile order: the daily kitchen spend first, because that is what
 * gets added most, and `OTHER` last.
 */

export const EXPENSE_CATEGORY_KEYS = [
  "GROCERIES",
  "VEGETABLES_MEAT",
  "GAS",
  "ELECTRICITY",
  "WATER",
  "INTERNET",
  "SALARY",
  "RENT",
  "REPAIR",
  "CLEANING",
  "OTHER",
] as const;

export type ExpenseCategoryKey = (typeof EXPENSE_CATEGORY_KEYS)[number];

/**
 * A hostel's own category is stored as `CUSTOM` on the expense, with the
 * category's id beside it. Never offered as a tile itself.
 */
export const CUSTOM_EXPENSE_CATEGORY = "CUSTOM" as const;

export type ExpenseCategoryValue = ExpenseCategoryKey | typeof CUSTOM_EXPENSE_CATEGORY;

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategoryKey, string> = {
  CLEANING: "Cleaning",
  ELECTRICITY: "Electricity",
  GAS: "Gas",
  GROCERIES: "Groceries",
  INTERNET: "Internet",
  OTHER: "Other",
  RENT: "Building rent",
  REPAIR: "Repair",
  SALARY: "Salary",
  VEGETABLES_MEAT: "Vegetables & meat",
  WATER: "Water",
};

export function isExpenseCategoryKey(value: unknown): value is ExpenseCategoryKey {
  return (
    typeof value === "string" &&
    (EXPENSE_CATEGORY_KEYS as readonly string[]).includes(value)
  );
}

/** How the money left. Cash first: most hostel spending is cash. */
export const EXPENSE_PAID_BY = ["CASH", "ESEWA", "KHALTI", "BANK"] as const;

export type ExpensePaidBy = (typeof EXPENSE_PAID_BY)[number];

export const EXPENSE_PAID_BY_LABELS: Record<ExpensePaidBy, string> = {
  BANK: "Bank",
  CASH: "Cash",
  ESEWA: "eSewa",
  KHALTI: "Khalti",
};

/** Longest "what" line — one short phrase, e.g. "Rice 25 kg". */
export const EXPENSE_WHAT_MAX = 120;
/** Longest name for a hostel's own category. */
export const EXPENSE_CUSTOM_CATEGORY_NAME_MAX = 32;
/** A hostel may add this many categories of its own. */
export const EXPENSE_CUSTOM_CATEGORY_LIMIT = 20;
