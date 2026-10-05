import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { createStockItem, resolveStockActor } from "@/modules/stock/stock.service";
import { createStockItemSchema } from "@/modules/stock/stock.validation";

export const runtime = "nodejs";

/** Add an item to the group's list. Anyone who handles stock. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageStock");
    const input = createStockItemSchema.parse(await request.json());

    return successResponse(await createStockItem(await resolveStockActor(principal), input), "Item added", {
      status: 201,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
