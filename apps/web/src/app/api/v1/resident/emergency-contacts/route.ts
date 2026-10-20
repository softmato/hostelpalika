import type { NextRequest } from "next/server";

import { requireResidentPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listResidentEmergencyContacts } from "@/modules/safety/safety.service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);
    const result = await listResidentEmergencyContacts(principal);

    return withEtag(request, successResponse(result, "Emergency contacts loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
