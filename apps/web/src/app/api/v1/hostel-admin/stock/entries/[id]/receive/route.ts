import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { receiveStock, resolveStockActor } from "@/modules/stock/stock.service";
import { receiveStockSchema } from "@/modules/stock/stock.validation";

export const runtime = "nodejs";

/** Got it — the receiving building confirms a Send, with what actually came. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireHostelCapability(request, "manageStock");
    const { id } = await context.params;
    const input = receiveStockSchema.parse(await request.json().catch(() => ({})));

    return successResponse(await receiveStock(await resolveStockActor(principal), id, input), "Got it");
  } catch (error) {
    return handleRouteError(error);
  }
}
