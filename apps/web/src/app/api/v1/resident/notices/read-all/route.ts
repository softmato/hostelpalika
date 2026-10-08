import type { NextRequest } from "next/server";

import { requireResidentPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { markAllNoticesAsRead } from "@/modules/notices/notice.service";

export const runtime = "nodejs";

/** Opening the notice board marks every notice on it read for this resident. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);
    const result = await markAllNoticesAsRead(principal);

    return successResponse(result, "Notices marked as read");
  } catch (error) {
    return handleRouteError(error);
  }
}
