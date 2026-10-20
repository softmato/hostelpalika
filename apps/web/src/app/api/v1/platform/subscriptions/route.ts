import type { NextRequest } from "next/server";

import { requirePlatformPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getPlatformSubscriptionLedger } from "@/modules/billing/platform-subscriptions.service";

export const runtime = "nodejs";

/**
 * Plan billing, platform-wide: what we invoiced, what arrived, what is owed.
 *
 * Read-only and deliberately so. Nothing on this screen may raise, void or
 * settle an invoice — those all run through `subscription.service` behind their
 * own guards, and a ledger that could also write would be a second path to
 * taking money with none of the rules attached.
 */
export async function GET(request: NextRequest) {
  try {
    await requirePlatformPrincipal(request);

    const limit = Number(
      new URL(request.url).searchParams.get("limit") ?? "200",
    );

    const ledger = await getPlatformSubscriptionLedger({
      limit: Number.isFinite(limit) ? limit : 200,
    });

    return withEtag(request, successResponse(ledger, "Subscription ledger loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
