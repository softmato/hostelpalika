import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { createStockPayment, resolveStockActor } from "@/modules/stock/stock.service";
import { createStockPaymentSchema } from "@/modules/stock/stock.validation";

export const runtime = "nodejs";

/** Pay a supplier. `201` new; `200` when `clientRequestId` matched one already saved. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageStock");
    const input = createStockPaymentSchema.parse(await request.json());
    const result = await createStockPayment(await resolveStockActor(principal), input);

    return successResponse(result.payment, result.duplicate ? "Already saved" : "Paid", {
      status: result.duplicate ? 200 : 201,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
