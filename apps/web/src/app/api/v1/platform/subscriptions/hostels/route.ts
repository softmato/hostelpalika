import type { NextRequest } from "next/server";

import { requirePlatformPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listHostelSubscriptions } from "@/modules/billing/platform-subscriptions.service";

export const runtime = "nodejs";

/** Every hostel's plan as it stands, for the Hostels → Subscriptions tab. Read-only. */
export async function GET(request: NextRequest) {
  try {
    await requirePlatformPrincipal(request);

    return withEtag(request, successResponse(await listHostelSubscriptions(), "Hostel plans loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
