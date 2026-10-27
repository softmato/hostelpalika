import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { backUpNow, getBackupOverview } from "@/modules/backup/backup.service";

export const runtime = "nodejs";
// A manual backup builds, encrypts and uploads the whole hostel in this request.
export const maxDuration = 300;

/** Backup screen (docs/FIELD_REVIEW_2026_10_27.md I6) — owner only. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const hostelId = request.nextUrl.searchParams.get("hostelId") ?? undefined;

    return successResponse(await getBackupOverview(principal, hostelId), "Backup loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Back up now. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const hostelId = request.nextUrl.searchParams.get("hostelId") ?? undefined;

    return successResponse(await backUpNow(principal, hostelId), "Backup finished");
  } catch (error) {
    return handleRouteError(error);
  }
}
