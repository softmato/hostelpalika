import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { listHostelLeaveRequests } from "@/modules/hostels/hostel-leave.service";
import { hostelLeaveListSchema } from "@/modules/hostels/hostel-leave.validation";

export const runtime = "nodejs";

/** Hostels asking to leave. SUPERADMIN only — see `route-access.ts`. */
export async function GET(request: NextRequest) {
  try {
    await requireSuperadminPrincipal(request);

    const query = hostelLeaveListSchema.parse(Object.fromEntries(request.nextUrl.searchParams));

    return successResponse(await listHostelLeaveRequests(query.status), "Leave requests loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}
