import type { NextRequest } from "next/server";

import { requireHostelStaffPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listApprovedServiceProvidersForHostel } from "@/modules/service-providers/service-provider.service";
import { hostelAdminServiceProviderListQuerySchema } from "@/modules/service-providers/service-provider.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requireHostelStaffPrincipal(request);
    const query = hostelAdminServiceProviderListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await listApprovedServiceProvidersForHostel(query);

    return withEtag(request, successResponse(result, "Approved service providers loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
