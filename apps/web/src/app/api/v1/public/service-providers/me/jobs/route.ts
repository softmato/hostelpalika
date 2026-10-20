import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { requireApiPrincipal } from "@/lib/api-auth";
import { listOwnServiceProviderJobs } from "@/modules/service-providers/service-provider.service";

export const runtime = "nodejs";

/**
 * The jobs assigned to the signed-in provider by hostel admins.
 *
 * Scoped entirely to the caller's own approved provider record, so being signed
 * in is the only gate — an account that is not an approved provider gets an
 * empty list, which is the truthful answer rather than a 403.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const result = await listOwnServiceProviderJobs(principal.userId);

    return withEtag(request, successResponse(result, "Jobs loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
