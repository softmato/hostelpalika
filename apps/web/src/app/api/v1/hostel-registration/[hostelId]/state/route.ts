import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { isSoftmatoConfigured } from "@/modules/billing/softmato/config";
import { resolveOwnedHostel } from "@/modules/billing/subscription-access";
import { getSubscriptionState } from "@/modules/billing/subscription.service";

type RouteContext = { params: Promise<{ hostelId: string }> };

export const runtime = "nodejs";

/**
 * Everything the progress page renders, in one read: where the application is,
 * which plan was chosen, what is owed, and whether *Pay now* is live.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireApiPrincipal(request);
    const { hostelId } = await context.params;

    await resolveOwnedHostel(hostelId, principal.userId);

    const state = await getSubscriptionState(hostelId);

    // `onlinePayment` is false until Softmato is configured; the page then
    // offers the manual QR lane instead of a checkout that cannot open.
    return withEtag(request, successResponse(
      { onlinePayment: isSoftmatoConfigured(), state },
      "Registration state loaded",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}
