import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { createStockEntry, getStockHome, resolveStockActor } from "@/modules/stock/stock.service";
import { createStockEntrySchema, stockHomeQuerySchema } from "@/modules/stock/stock.validation";

export const runtime = "nodejs";

/**
 * Stock (docs/INVENTORY_PLAN.md). The owner passes unchanged; a warden only with
 * `manageStock`. Both see only the building they are working in, except the
 * owner's Overall (`scope=all`). One read for the screen.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageStock");
    const query = stockHomeQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));

    return successResponse(await getStockHome(await resolveStockActor(principal, query.scope === "all"), query.period), "Stock loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Bought, Send or Count. `201` new; `200` when `clientRequestId` matched one already saved. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageStock");
    const input = createStockEntrySchema.parse(await request.json());
    const result = await createStockEntry(await resolveStockActor(principal), input);

    return successResponse(result.entry, result.duplicate ? "Already saved" : "Saved", {
      status: result.duplicate ? 200 : 201,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
