import { REALTIME_TOPIC } from "@/constants/topics";
import { api } from "@/lib/api";
import { type ApiEnvelope, readApiError, readApiErrorCode, unwrap } from "@/lib/api-contract";
import type {
  CustomExpenseCategory,
  ExpenseCategoryValue,
  ExpenseHome,
  ExpensePaidBy,
  ExpenseRow,
} from "@/lib/expenses";
import { defineQuery, type Query } from "@/lib/query-cache";

/**
 * Money Out over the wire (docs/EXPENSES_PLAN.md).
 *
 * The owner and a warden share `/hostel-admin/expenses`; the cook has its own
 * `/cook/expenses`, the same split as the rest of the kitchen's reads. The
 * server decides what each of them sees — this file only picks the door.
 */
export type ExpenseAudience = "cook" | "staff";

function base(audience: ExpenseAudience) {
  return audience === "cook" ? "/cook/expenses" : "/hostel-admin/expenses";
}

export async function getExpenseHome(audience: ExpenseAudience, period?: string) {
  const response = await api.get<ApiEnvelope<ExpenseHome>>(base(audience), {
    params: period ? { period } : undefined,
  });

  return unwrap(response);
}

export type NewExpense = {
  amount: number;
  category: ExpenseCategoryValue;
  clientRequestId: string;
  customCategoryId?: string;
  paidBy: ExpensePaidBy;
  photoAssetId?: string;
  salaryFor?: { name: string; userId?: string };
  /** Gregorian `YYYY-MM-DD`. */
  spentOn: string;
  what?: string;
};

export async function addExpense(audience: ExpenseAudience, input: NewExpense) {
  const response = await api.post<ApiEnvelope<ExpenseRow>>(base(audience), input);

  return unwrap(response);
}

export async function cancelExpense(audience: ExpenseAudience, id: string, reason: string) {
  const response = await api.post<ApiEnvelope<ExpenseRow>>(`${base(audience)}/${id}/void`, {
    reason,
  });

  return unwrap(response);
}

/** Owner only. */
export async function addExpenseCategory(name: string) {
  const response = await api.post<ApiEnvelope<CustomExpenseCategory>>(
    "/hostel-admin/expenses/categories",
    { name },
  );

  return unwrap(response);
}

/** Owner only. Hiding keeps every row filed under it, and its totals. */
export async function updateExpenseCategory(id: string, input: { hidden?: boolean; name?: string }) {
  const response = await api.patch<ApiEnvelope<CustomExpenseCategory>>(
    `/hostel-admin/expenses/categories/${id}`,
    input,
  );

  return unwrap(response);
}

/** Owner only: let the kitchen add what it spends. */
export async function setCookExpenses(enabled: boolean) {
  const response = await api.put<ApiEnvelope<{ expensesEnabled: boolean }>>(
    "/hostel-admin/expenses/cook",
    { enabled },
  );

  return unwrap(response);
}

/* -------------------------------------------------------------------------- */
/* The screen's one read                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A refusal is an answer, not an error. A warden without `recordExpenses`, or a
 * cook whose owner has not switched it on, gets a sentence about that — never
 * an empty month, which would read as "nothing was spent".
 */
export type ExpenseLoad =
  | { home: ExpenseHome; kind: "ok" }
  | { code: string; kind: "denied"; message: string };

const DENIED_CODES = new Set(["CAPABILITY_DENIED", "EXPENSES_OFF_FOR_COOK", "FORBIDDEN"]);

/**
 * Keyed by audience and month. `null` is "this month" — what Home and the add
 * screen read — so a save invalidates exactly the entry both of them share.
 * On the payments topic because *Money In* moves when a payment settles.
 */
export function expenseQuery(audience: ExpenseAudience, period: string | null): Query<ExpenseLoad> {
  return defineQuery(
    `expenses:${audience}:${period ?? "current"}`,
    [REALTIME_TOPIC.PAYMENTS],
    async () => {
      try {
        return { home: await getExpenseHome(audience, period ?? undefined), kind: "ok" as const };
      } catch (error) {
        const code = readApiErrorCode(error);

        if (code && DENIED_CODES.has(code)) {
          return { code, kind: "denied" as const, message: readApiError(error) };
        }

        throw error;
      }
    },
  );
}
