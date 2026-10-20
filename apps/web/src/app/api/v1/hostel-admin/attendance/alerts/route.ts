import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listAttendanceAlerts } from "@/modules/attendance/attendance.service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "viewNightStatus");
    const result = await listAttendanceAlerts(
      principal,
      request.nextUrl.searchParams.get("hostelId") ?? undefined,
    );

    return withEtag(request, successResponse(result, "Attendance alerts loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
