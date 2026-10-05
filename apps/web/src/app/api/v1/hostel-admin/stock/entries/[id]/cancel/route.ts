import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { cancelStockEntry, resolveStockActor } from "@/modules/stock/stock.service";
import { cancelStockEntrySchema } from "@/modules/stock/stock.validation";

export const runtime = "nodejs";

/** Cancel with a reason. The owner: any entry. A warden: their own, and a Send only before Got it. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireHostelCapability(request, "manageStock");
    const { id } = await context.params;
    const input = cancelStockEntrySchema.parse(await request.json());

    return successResponse(
      await cancelStockEntry(await resolveStockActor(principal), id, input.reason),
      "Cancelled",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
