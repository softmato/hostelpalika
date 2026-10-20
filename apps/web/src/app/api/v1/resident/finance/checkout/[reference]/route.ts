import type { NextRequest } from "next/server";

import { requireResidentPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getCheckoutStatus } from "@/modules/finance/gateway/intent.service";

export const runtime = "nodejs";

/**
 * Where the resident lands after a checkout, and what their screen polls
 * (target §11.6, plan item 6.2).
 *
 * **This URL settles nothing by being visited.** It is guessable and carries no
 * authority; a payment settles here only because the service asks the provider
 * directly and the provider agrees — the same authority a callback goes through.
 * The reference is additionally scoped to the calling resident, so it is not an
 * oracle for anyone else's attempts either.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ reference: string }> },
) {
  try {
    const principal = await requireResidentPrincipal(request);
    const { reference } = await context.params;

    return withEtag(request, successResponse(
      await getCheckoutStatus(decodeURIComponent(reference), principal),
      "Checkout status",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}
