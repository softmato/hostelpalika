import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { getStockSupplier, resolveStockActor, updateStockSupplier } from "@/modules/stock/stock.service";
import { updateStockSupplierSchema } from "@/modules/stock/stock.validation";

export const runtime = "nodejs";

/** One supplier's ledger: bills against payments, with the balance after each. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireHostelCapability(request, "manageStock");
    const { id } = await context.params;

    return successResponse(await getStockSupplier(await resolveStockActor(principal), id), "Supplier loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Rename, change the phone, switch off. What was owed before: owner only. */
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireHostelCapability(request, "manageStock");
    const { id } = await context.params;
    const input = updateStockSupplierSchema.parse(await request.json());

    return successResponse(await updateStockSupplier(await resolveStockActor(principal), id, input), "Supplier saved");
  } catch (error) {
    return handleRouteError(error);
  }
}
