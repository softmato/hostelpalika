import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { countWebPushSubscriptions } from "@/modules/notifications/web-push-subscription.service";
import { isWebPushConfigured } from "@/modules/notifications/web-push.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the toggle should read on page load.
 *
 * The browser's own `pushManager.getSubscription()` is not the answer on its
 * own. It can hold a subscription this server has already pruned (a 410 from
 * the push service) or revoked (a sign-out on this machine), and in that state
 * a toggle driven by the browser alone reads "on" and delivers nothing — the
 * exact failure that is impossible to report, because everything looks fine.
 * The server's row is the source of truth; the client reconciles to it.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const { subscriptions } = await countWebPushSubscriptions(principal);

    return withEtag(request, successResponse(
      {
        configured: isWebPushConfigured(),
        enabled: subscriptions > 0,
        subscriptions,
      },
      "Browser notification status loaded",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}
