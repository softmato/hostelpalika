import type { NextRequest } from "next/server";

import { requirePlatformPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listPlatformServiceProviders } from "@/modules/service-providers/service-provider.service";
import { platformServiceProviderListQuerySchema } from "@/modules/service-providers/service-provider.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requirePlatformPrincipal(request);
    const query = platformServiceProviderListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await listPlatformServiceProviders(query);

    return withEtag(request, successResponse(result, "Service providers loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
