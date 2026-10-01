import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import {
  resolveExpenseActor,
  setCookExpensesEnabled,
} from "@/modules/finance/expenses/expense.service";
import { cookExpensesSchema } from "@/modules/finance/expenses/expense.validation";

export const runtime = "nodejs";

/** The owner turns the cook's *Add expense* on or off. Off by default. */
export async function PUT(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const input = cookExpensesSchema.parse(await request.json());
    const actor = await resolveExpenseActor(principal, input.hostelId);

    return successResponse(
      await setCookExpensesEnabled(actor, input.enabled),
      input.enabled ? "The cook can add expenses" : "The cook can no longer add expenses",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
