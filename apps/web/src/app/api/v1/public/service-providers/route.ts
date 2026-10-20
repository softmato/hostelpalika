import type { NextRequest } from "next/server";

import {
  PUBLIC_CACHE,
  handleRouteError,
  successResponse,
} from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listPublicServiceProviders } from "@/modules/service-providers/service-provider.service";
import { publicServiceProviderListQuerySchema } from "@/modules/service-providers/service-provider.validation";

export const runtime = "nodejs";

/**
 * Public provider directory — no login required (PHASES.md §5.1). The response
 * carries no phone numbers; contact details stay on the hostel-admin endpoint.
 */
export async function GET(request: NextRequest) {
  try {
    const query = publicServiceProviderListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    const result = await listPublicServiceProviders(query);

    return withEtag(request, successResponse(result, "Service providers loaded", PUBLIC_CACHE));
  } catch (error) {
    return handleRouteError(error);
  }
}
