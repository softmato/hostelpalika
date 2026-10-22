import type { NextRequest } from "next/server";

import { requireResidentPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { cachedRead } from "@/lib/redis-cache";
import { getResidentDashboard } from "@/modules/residents/resident-dashboard.service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);
    const result = await cachedRead(principal, "resident-dashboard", () => getResidentDashboard(principal));

    return withEtag(request, successResponse(result, "Resident dashboard loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
