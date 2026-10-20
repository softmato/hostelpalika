import type { NextRequest } from "next/server";

import { requireHostelStaffPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getAttendanceAnalytics } from "@/modules/reports/operations-analytics.service";

export const runtime = "nodejs";

/**
 * Attendance patterns and frequently-absent residents (PHASES.md §5.1).
 * Built from zone rows only — coordinates were discarded when each ping landed.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const params = request.nextUrl.searchParams;
    const result = await getAttendanceAnalytics(principal, {
      days: params.get("days") ? Number(params.get("days")) : undefined,
      hostelId: params.get("hostelId") ?? undefined,
    });

    return withEtag(request, successResponse(result, "Attendance analytics loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
