import type { NextRequest } from "next/server";

import { assertApiRoles, requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { Role } from "@/lib/roles";
import { createStockEntry, getCookStock, resolveStockActor } from "@/modules/stock/stock.service";
import { cookStockEntrySchema } from "@/modules/stock/stock.validation";

export const runtime = "nodejs";

/**
 * The kitchen's stock (docs/INVENTORY_PLAN.md): what is in its building's store
 * and what was taken out today. A COOK only — and only while the owner leaves
 * `HostelSettings.cookCanUseStock` on. No prices.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    assertApiRoles(principal, [Role.COOK]);

    return successResponse(await getCookStock(await resolveStockActor(principal)), "Kitchen stock loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}

/** The kitchen used (or threw away) something. `201` new; `200` when the retry matched one already saved. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    assertApiRoles(principal, [Role.COOK]);

    const input = cookStockEntrySchema.parse(await request.json());
    const actor = await resolveStockActor(principal);
    const result = await createStockEntry(actor, {
      ...input,
      hostelId: actor.activeHostelId.toString(),
      paidBy: "CASH",
      useFor: input.kind === "USE" ? "KITCHEN" : undefined,
      wasteReason: input.kind === "WASTE" ? (input.wasteReason ?? "SPOILED") : undefined,
    });

    return successResponse(result.entry, result.duplicate ? "Already saved" : "Saved", {
      status: result.duplicate ? 200 : 201,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
