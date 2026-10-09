import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { approveStockCount, resolveStockActor } from "@/modules/stock/stock.service";

export const runtime = "nodejs";

/** Approve a warden's Count. Turning one down is Cancel with a reason. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireHostelCapability(request, "manageStock");
    const { id } = await context.params;

    return successResponse(await approveStockCount(await resolveStockActor(principal), id), "Count approved");
  } catch (error) {
    return handleRouteError(error);
  }
}
