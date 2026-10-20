import type { NextRequest } from "next/server";

import { requireResidentPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  deleteResidentLocationHistory,
  getResidentAttendance,
} from "@/modules/attendance/attendance.service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);
    const result = await getResidentAttendance(principal);

    return withEtag(request, successResponse(result, "Attendance loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Resident-initiated erasure of their own location history. */
export async function DELETE(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);
    const result = await deleteResidentLocationHistory(principal);

    return successResponse(result, "Location history deleted");
  } catch (error) {
    return handleRouteError(error);
  }
}
