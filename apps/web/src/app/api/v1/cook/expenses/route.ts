import type { NextRequest } from "next/server";

import { assertApiRoles, requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { Role } from "@/lib/roles";
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
 * The cook's own expenses — only when the owner turned it on
 * (`HostelSettings.cookCanRecordExpenses`). Same service as the hostel-admin
 * route; the cook sees their own rows and never the hostel's totals.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    assertApiRoles(principal, [Role.COOK]);

    const query = expenseHomeQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const actor = await resolveExpenseActor(principal, query.hostelId);

    return successResponse(await getExpenseHome(actor, query.period), "Expenses loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    assertApiRoles(principal, [Role.COOK]);

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
