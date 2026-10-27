import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { getUsageAnalytics } from "@/modules/usage/usage.service";
import { usageAnalyticsQuerySchema } from "@/modules/usage/usage.validation";

export const runtime = "nodejs";

/** Superadmin → Analytics: the usage watcher's roll-ups, or one person's (`?userId=`). */
export async function GET(request: NextRequest) {
  try {
    await requireSuperadminPrincipal(request);

    const query = usageAnalyticsQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));

    return successResponse(await getUsageAnalytics(query), "Usage analytics loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}
