import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { realtimeChannelsFor } from "@/lib/realtime/access";
import { isRealtimeConfigured } from "@/lib/realtime/server";

export const runtime = "nodejs";

/**
 * Everything the browser needs to open its socket: the public app key, the
 * cluster, and the exact channels this principal may subscribe to.
 *
 * Handing the channel list back from the server (rather than deriving it in the
 * client from a decoded token) keeps one source of truth for the policy, and
 * means a portal never attempts a subscription it will be refused.
 *
 * `enabled: false` is the normal answer on a deployment with no Pusher
 * credentials — the client then simply stays on polling.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);

    if (!isRealtimeConfigured()) {
      return withEtag(request, successResponse(
        { channels: [], cluster: "", enabled: false, key: "" },
        "Realtime is not configured",
      ));
    }

    return withEtag(request, successResponse(
      {
        channels: realtimeChannelsFor(principal),
        cluster: process.env.PUSHER_CLUSTER ?? "",
        enabled: true,
        key: process.env.PUSHER_KEY ?? "",
      },
      "Realtime configuration loaded",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}
