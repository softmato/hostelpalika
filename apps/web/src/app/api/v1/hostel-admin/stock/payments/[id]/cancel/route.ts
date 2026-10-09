import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { cancelStockPayment, resolveStockActor } from "@/modules/stock/stock.service";
import { cancelStockEntrySchema } from "@/modules/stock/stock.validation";

export const runtime = "nodejs";

/** Cancel a supplier payment with a reason. The owner: any. A warden: their own. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireHostelCapability(request, "manageStock");
    const { id } = await context.params;
    const input = cancelStockEntrySchema.parse(await request.json());

    return successResponse(await cancelStockPayment(await resolveStockActor(principal), id, input.reason), "Cancelled");
  } catch (error) {
    return handleRouteError(error);
  }
}
