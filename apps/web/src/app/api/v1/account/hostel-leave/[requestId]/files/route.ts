import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { listHeldFiles } from "@/modules/hostels/hostel-leave.service";

export const runtime = "nodejs";

/**
 * A held hostel's original files, for its owner while the hold runs — the
 * agreement's point 9 (docs/HOSTEL_LEAVE_PLATFORM.md).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ requestId: string }> }) {
  try {
    const principal = await requireApiPrincipal(request);
    const { requestId } = await params;

    return successResponse(await listHeldFiles(principal.userId, requestId), "Files loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}
