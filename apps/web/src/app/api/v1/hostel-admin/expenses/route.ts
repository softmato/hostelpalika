import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import {
  createExpense,
  getExpenseHome,
  resolveExpenseActor,
} from "@/modules/finance/expenses/expense.service";
import {
  createExpenseSchema,
  expenseHomeQuerySchema,
} from "@/modules/finance/expenses/expense.validation";

export const runtime = "nodejs";

/**
 * Money Out (docs/EXPENSES_PLAN.md).
 *
 * The owner passes unchanged; a warden passes only with `recordExpenses`, and
 * the service then shows them their own rows and nothing else. One read for the
 * whole screen: the month's rows, the owner's totals, the categories and the
 * salary picker are one question.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "recordExpenses");
    const query = expenseHomeQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const actor = await resolveExpenseActor(principal, query.hostelId);

    return successResponse(await getExpenseHome(actor, query.period), "Expenses loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}

/** `201` for a new row; `200` when `clientRequestId` matched one already saved. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "recordExpenses");
    const input = createExpenseSchema.parse(await request.json());
    const actor = await resolveExpenseActor(principal, input.hostelId);
    const result = await createExpense(actor, input);

    return successResponse(result.expense, result.duplicate ? "Already saved" : "Expense added", {
      status: result.duplicate ? 200 : 201,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
