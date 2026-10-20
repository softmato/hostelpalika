import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { requireApiPrincipal } from "@/lib/api-auth";
import { getOwnServiceProviderApplication } from "@/modules/service-providers/service-provider.service";

export const runtime = "nodejs";

/**
 * The signed-in account's own provider application, if it has one. Any role may
 * call it — it is scoped to the caller's own `userId`, so there is nothing to
 * gate beyond being signed in. Returns `{ provider: null }` when the account has
 * never applied, which is the normal case and not an error.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const result = await getOwnServiceProviderApplication(principal.userId);

    return withEtag(request, successResponse(result, "Service provider application loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
