import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { getStaffWallet, resolveExpenseActor } from "@/modules/finance/expenses/expense.service";
import { staffWalletQuerySchema } from "@/modules/finance/expenses/expense.validation";

export const runtime = "nodejs";

/**
 * One warden's cash box: given, spent, left, and every row behind it. The owner
 * passes `userId`; a warden always gets their own, whatever they pass.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "recordExpenses");
    const query = staffWalletQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const actor = await resolveExpenseActor(principal, query.hostelId);

    return successResponse(await getStaffWallet(actor, query.userId), "Cash box loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}
