import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { requireApiPrincipal } from "@/lib/api-auth";
import { listOwnerHostelApplications } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const result = await listOwnerHostelApplications(principal.userId);

    return withEtag(request, successResponse(result, "Applications loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
