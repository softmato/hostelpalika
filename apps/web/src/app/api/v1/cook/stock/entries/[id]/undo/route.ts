import type { NextRequest } from "next/server";

import { assertApiRoles, requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { Role } from "@/lib/roles";
import { cancelStockEntry, resolveStockActor } from "@/modules/stock/stock.service";

export const runtime = "nodejs";

/** The kitchen takes back its own entry, the same day only (checked in the service). Kept as cancelled. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireApiPrincipal(request);
    assertApiRoles(principal, [Role.COOK]);

    const { id } = await context.params;

    return successResponse(await cancelStockEntry(await resolveStockActor(principal), id, "Undone by the kitchen"), "Undone");
  } catch (error) {
    return handleRouteError(error);
  }
}
