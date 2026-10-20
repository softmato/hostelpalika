import type { NextRequest } from "next/server";

import { requirePlatformPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getPlatformServiceProvider } from "@/modules/service-providers/service-provider.service";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";

/**
 * The full application behind one provider — every submitted field plus the
 * uploaded documents. The review panel needs this because the list endpoint
 * carries no documents, and approving without seeing the citizenship or licence
 * scan is the decision this screen exists to prevent.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await requirePlatformPrincipal(request);
    const { id } = await context.params;
    const result = await getPlatformServiceProvider(id);

    return withEtag(request, successResponse(result, "Service provider loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
