import type { NextRequest } from "next/server";

import { requireHostelStaffPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { getMaintenanceSettings } from "@/modules/maintenance/maintenance.service";

export const runtime = "nodejs";

/**
 * Read-only for the hostel.
 *
 * A warden raising a request has to be told what the call-out will cost before
 * they commit the hostel to it — that is the whole reason the figure exists. The
 * figures themselves are the platform's, set in operations config by the
 * superadmin: a hostel that could edit them could approve any job by first
 * lowering its charge.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const result = await getMaintenanceSettings(
      principal,
      request.nextUrl.searchParams.get("hostelId") ?? undefined,
    );

    return successResponse(result, "Maintenance settings loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}
