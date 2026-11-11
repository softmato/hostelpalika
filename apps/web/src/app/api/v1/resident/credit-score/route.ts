import type { NextRequest } from "next/server";

import { requireResidentPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getMyCreditScore } from "@/modules/finance/credit-score.service";

export const runtime = "nodejs";

/** The resident's credit score, claim counts, history and month code. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);

    return withEtag(request, successResponse(await getMyCreditScore(principal), "Credit score"));
  } catch (error) {
    return handleRouteError(error);
  }
}
