import type { NextRequest } from "next/server";

import { requireResidentPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getPayInstructions } from "@/modules/finance/pay-instructions.service";

export const runtime = "nodejs";

/**
 * How to pay this invoice (target §11.1, plan item 3.3).
 *
 * Tier-aware: the same shape at Tier 0 and Tier 1, with `tier` saying which one
 * the screen leads with. Scoped to the calling resident's own invoice inside the
 * service, so there is no hostel parameter to get wrong here.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const principal = await requireResidentPrincipal(request);
    const { id } = await context.params;

    return withEtag(request, successResponse(
      await getPayInstructions(id, principal),
      "Payment instructions",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}
