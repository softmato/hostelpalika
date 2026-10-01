import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import {
  createExpenseCategory,
  resolveExpenseActor,
} from "@/modules/finance/expenses/expense.service";
import { createExpenseCategorySchema } from "@/modules/finance/expenses/expense.validation";

export const runtime = "nodejs";

/** The owner adds a category of their own. Wardens and the cook only pick. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const input = createExpenseCategorySchema.parse(await request.json());
    const actor = await resolveExpenseActor(principal, input.hostelId);

    return successResponse(await createExpenseCategory(actor, input.name), "Category added", {
      status: 201,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
