import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { resolveExpenseActor, voidExpense } from "@/modules/finance/expenses/expense.service";
import { voidExpenseSchema } from "@/modules/finance/expenses/expense.validation";

export const runtime = "nodejs";

/** Cancel an expense with a reason. The owner: any row. A warden: their own. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireHostelCapability(request, "recordExpenses");
    const { id } = await context.params;
    const input = voidExpenseSchema.parse(await request.json());
    const actor = await resolveExpenseActor(principal, request.nextUrl.searchParams.get("hostelId") ?? undefined);

    return successResponse(await voidExpense(actor, id, input.reason), "Expense cancelled");
  } catch (error) {
    return handleRouteError(error);
  }
}
