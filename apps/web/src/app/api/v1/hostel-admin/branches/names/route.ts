import type { NextRequest } from "next/server";

import { requireHostelStaffPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { getBranchNames } from "@/modules/hostels/hostel-branch.service";

export const runtime = "nodejs";

/** The hostel group by name — the warden's read-only branch switcher in the app. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelStaffPrincipal(request);

    return successResponse(await getBranchNames(principal), "Branch names loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}
