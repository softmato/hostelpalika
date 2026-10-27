import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";
import { listLeavingToday } from "@/modules/move-checklist/leaving-notice.service";

export const runtime = "nodejs";

/** Residents whose leaving day is today or past and who are still here — Home's "Leaving today". */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "registerResidents");
    const hostelId = resolveAdminHostelId(principal, request.nextUrl.searchParams.get("hostelId") ?? undefined);

    return successResponse({ residents: await listLeavingToday(hostelId) }, "Leaving today");
  } catch (error) {
    return handleRouteError(error);
  }
}
