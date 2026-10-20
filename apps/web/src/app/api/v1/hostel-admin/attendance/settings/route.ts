import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  getAttendanceSettings,
  updateAttendanceSettings,
} from "@/modules/attendance/attendance.service";
import { attendanceSettingsSchema } from "@/modules/attendance/attendance.validation";

export const runtime = "nodejs";

/** Geofence and retention are hostel-level configuration — admin only. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const result = await getAttendanceSettings(
      principal,
      request.nextUrl.searchParams.get("hostelId") ?? undefined,
    );

    return withEtag(request, successResponse(result, "Attendance settings loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const input = attendanceSettingsSchema.parse(await request.json());
    const result = await updateAttendanceSettings(input, principal);

    return successResponse(result, "Attendance settings updated");
  } catch (error) {
    return handleRouteError(error);
  }
}
