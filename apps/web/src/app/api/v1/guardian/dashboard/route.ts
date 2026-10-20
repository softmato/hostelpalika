import type { NextRequest } from "next/server";

import { requireGuardianPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getGuardianDashboard } from "@/modules/guardian/guardian.service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireGuardianPrincipal(request);
    const result = await getGuardianDashboard(principal);

    return withEtag(request, successResponse(result, "Guardian dashboard loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
