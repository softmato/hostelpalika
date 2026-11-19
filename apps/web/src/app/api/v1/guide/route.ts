import type { NextRequest } from "next/server";

import { guideReaderForRole } from "@hostel/shared/guide/guide";

import { loadApiPrincipal } from "@/lib/api-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { guideFor } from "@/modules/guide/guide.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The user guide as this reader may see it: signed out, only the public parts;
 * signed in, their role's parts (the owner and the platform team read it all).
 * Never cached in between — the answer depends on who asks, and the pictures
 * carry short-lived signatures.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await loadApiPrincipal(request);
    // An app token that no longer verifies is not "signed out": answer 401 so the
    // app refreshes and asks again, rather than quietly getting the public part.
    if (!principal && /^Bearer\s+\S/i.test(request.headers.get("authorization") ?? "")) {
      return errorResponse("Your session has expired.", "UNAUTHENTICATED", 401);
    }
    const result = await guideFor(guideReaderForRole(principal?.role));

    if (!result) {
      return errorResponse("The guide could not be loaded. Try again in a minute.", "GUIDE_UNAVAILABLE", 503);
    }
    const response = successResponse(result, "Guide loaded");
    response.headers.set("cache-control", "private, no-store");
    return response;
  } catch (error) {
    return handleRouteError(error);
  }
}
