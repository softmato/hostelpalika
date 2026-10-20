import type { NextRequest } from "next/server";

import { requirePlatformPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listPlanPaymentClaims } from "@/modules/billing/subscription-claim.service";

export const runtime = "nodejs";

/**
 * The manual-payment review queue: hostels that say they have paid us.
 *
 * Its own endpoint rather than a filter on the ledger next door, because it is
 * a **worklist** and the ledger is a record. The ledger is paged, searched and
 * read for history; this is a short list of things a person has undertaken to
 * answer within a couple of days, and it has to be countable at a glance for a
 * badge to be able to say how many are waiting.
 */
export async function GET(request: NextRequest) {
  try {
    await requirePlatformPrincipal(request);

    return withEtag(request, successResponse(
      { claims: await listPlanPaymentClaims() },
      "Payment claims loaded",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}
