import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { getBranchesSummary } from "@/modules/hostels/hostel-branch.service";

export const runtime = "nodejs";

/** Every hostel the owner runs, side by side — the dashboard's Branches card. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);

    return successResponse(await getBranchesSummary(principal), "Branches summary loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}
