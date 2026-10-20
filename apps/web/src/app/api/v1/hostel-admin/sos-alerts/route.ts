import type { NextRequest } from "next/server";

import { requireHostelStaffPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listAdminSOSAlerts } from "@/modules/safety/safety.service";
import { sosListQuerySchema } from "@/modules/safety/safety.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const query = sosListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await listAdminSOSAlerts(query, principal);

    return withEtag(request, successResponse(result, "SOS alerts loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
