import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getStoreAdminSummary } from "@/modules/store/store-admin.service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requireSuperadminPrincipal(request);

    return withEtag(request, successResponse(await getStoreAdminSummary(), "Store summary loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
