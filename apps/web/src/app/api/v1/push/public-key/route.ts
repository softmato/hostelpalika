import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  isWebPushConfigured,
  webPushPublicKey,
} from "@/modules/notifications/web-push.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The VAPID public key a browser needs before it can subscribe.
 *
 * Public by nature — it ends up embedded in every subscription and is readable
 * from the page — but still behind auth, because there is no reason for a
 * signed-out visitor to ask and no reason to hand anonymous callers a stable
 * fingerprint of this deployment.
 *
 * `503` rather than an empty key when VAPID is unset, so the client can say
 * "browser notifications are not configured here" instead of subscribing
 * against nothing and going silently undelivered.
 */
export async function GET(request: NextRequest) {
  try {
    await requireApiPrincipal(request);

    if (!isWebPushConfigured()) {
      return errorResponse(
        "Browser notifications are not configured on this deployment.",
        "WEB_PUSH_NOT_CONFIGURED",
        503,
      );
    }

    return withEtag(request, successResponse({ publicKey: webPushPublicKey() }, "Push key loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
