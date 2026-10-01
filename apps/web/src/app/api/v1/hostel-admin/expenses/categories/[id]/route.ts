import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import {
  resolveExpenseActor,
  updateExpenseCategory,
} from "@/modules/finance/expenses/expense.service";
import { updateExpenseCategorySchema } from "@/modules/finance/expenses/expense.validation";

export const runtime = "nodejs";

/** Rename or hide one of the hostel's own categories. Its rows keep their totals. */
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const { id } = await context.params;
    const input = updateExpenseCategorySchema.parse(await request.json());
    const actor = await resolveExpenseActor(principal, request.nextUrl.searchParams.get("hostelId") ?? undefined);

    return successResponse(await updateExpenseCategory(actor, id, input), "Category saved");
  } catch (error) {
    return handleRouteError(error);
  }
}
