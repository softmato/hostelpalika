import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { resolveStockActor, setCookStockEnabled } from "@/modules/stock/stock.service";
import { cookStockToggleSchema } from "@/modules/stock/stock.validation";

export const runtime = "nodejs";

/** The owner turns the kitchen's *Kitchen stock* on or off. On by default. */
export async function PUT(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const input = cookStockToggleSchema.parse(await request.json());

    return successResponse(
      await setCookStockEnabled(await resolveStockActor(principal), input.enabled),
      input.enabled ? "The kitchen can enter stock used" : "The kitchen can no longer enter stock",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
