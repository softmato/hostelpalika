import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listHostelAttendance } from "@/modules/attendance/attendance.service";
import { attendanceListQuerySchema } from "@/modules/attendance/attendance.validation";

export const runtime = "nodejs";

/**
 * Attendance is night status arrived at automatically, so it is gated by the
 * same capability rather than a new one — a warden trusted with one is trusted
 * with the other.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "viewNightStatus");
    const query = attendanceListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await listHostelAttendance(query, principal);

    return withEtag(request, successResponse(result, "Attendance loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
