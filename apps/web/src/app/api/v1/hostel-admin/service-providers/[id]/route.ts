import type { NextRequest } from "next/server";

import { requireHostelStaffPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getApprovedServiceProviderForHostel } from "@/modules/service-providers/service-provider.service";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await requireHostelStaffPrincipal(request);
    const { id } = await context.params;
    const result = await getApprovedServiceProviderForHostel(id);

    return withEtag(request, successResponse(result, "Service provider loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
