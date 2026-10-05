import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { resolveStockActor, updateStockItem } from "@/modules/stock/stock.service";
import { updateStockItemSchema } from "@/modules/stock/stock.validation";

export const runtime = "nodejs";

/** Rename, re-kind, set the low mark or switch off an item. Owner only (checked in the service). */
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireHostelCapability(request, "manageStock");
    const { id } = await context.params;
    const input = updateStockItemSchema.parse(await request.json());

    return successResponse(await updateStockItem(await resolveStockActor(principal), id, input), "Item saved");
  } catch (error) {
    return handleRouteError(error);
  }
}
