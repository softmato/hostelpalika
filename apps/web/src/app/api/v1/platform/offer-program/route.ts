import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getOfferProgramOverview } from "@/modules/offer-program/offer-program.service";

export const runtime = "nodejs";

/**
 * One quarter of the Resident Offer Program. Superadmin only: awards are
 * HostelPalika's money, the same rule as sponsors and the store.
 */
export async function GET(request: NextRequest) {
  try {
    await requireSuperadminPrincipal(request);

    return withEtag(request, successResponse(
      await getOfferProgramOverview(request.nextUrl.searchParams.get("quarter")),
      "Offer Program",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}
