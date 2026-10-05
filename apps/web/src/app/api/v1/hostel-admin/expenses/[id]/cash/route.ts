import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { resolveExpenseActor, respondToStaffCash } from "@/modules/finance/expenses/expense.service";
import { respondStaffCashSchema } from "@/modules/finance/expenses/expense.validation";

export const runtime = "nodejs";

/** The warden confirms (or denies) cash the owner says they handed over. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireHostelCapability(request, "recordExpenses");
    const { id } = await context.params;
    const input = respondStaffCashSchema.parse(await request.json());
    const actor = await resolveExpenseActor(principal, request.nextUrl.searchParams.get("hostelId") ?? undefined);

    return successResponse(
      await respondToStaffCash(actor, id, input),
      input.accept ? "Cash received" : "Marked not received",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
