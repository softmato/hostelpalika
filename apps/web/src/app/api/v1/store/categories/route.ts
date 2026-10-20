import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listStoreCategories } from "@/modules/store/catalog.service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requireHostelAdminPrincipal(request);

    return withEtag(request, successResponse(await listStoreCategories(), "Categories loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
