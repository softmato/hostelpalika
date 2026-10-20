import type { NextRequest } from "next/server";

import { requirePlatformPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listPlatformComplaints } from "@/modules/reports/platform-directory.service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requirePlatformPrincipal(request);
    const result = await listPlatformComplaints();

    return withEtag(request, successResponse(result, "Complaints loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
