import type { NextRequest } from "next/server";

import { assertApiRoles, requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { Role } from "@/lib/roles";
import { resolveExpenseActor, voidExpense } from "@/modules/finance/expenses/expense.service";
import { voidExpenseSchema } from "@/modules/finance/expenses/expense.validation";

export const runtime = "nodejs";

/** The cook cancels one of their own expenses, with a reason. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireApiPrincipal(request);
    assertApiRoles(principal, [Role.COOK]);

    const { id } = await context.params;
    const input = voidExpenseSchema.parse(await request.json());
    const actor = await resolveExpenseActor(principal);

    return successResponse(await voidExpense(actor, id, input.reason), "Expense cancelled");
  } catch (error) {
    return handleRouteError(error);
  }
}
