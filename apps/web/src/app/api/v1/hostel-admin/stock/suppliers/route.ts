import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { createStockSupplier, resolveStockActor } from "@/modules/stock/stock.service";
import { createStockSupplierSchema } from "@/modules/stock/stock.validation";

export const runtime = "nodejs";

/** Add a supplier. The list itself, with what is owed, comes with the stock read. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageStock");
    const input = createStockSupplierSchema.parse(await request.json());

    return successResponse(await createStockSupplier(await resolveStockActor(principal), input), "Supplier added", {
      status: 201,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
