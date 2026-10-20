import type { NextRequest } from "next/server";

import { requireResidentPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getResidentOfferProgram } from "@/modules/offer-program/offer-program.service";

export const runtime = "nodejs";

/** This quarter's certified total, the perk catalogue, and the resident's offers. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);

    return withEtag(request, successResponse(await getResidentOfferProgram(principal), "Offer Program"));
  } catch (error) {
    return handleRouteError(error);
  }
}
