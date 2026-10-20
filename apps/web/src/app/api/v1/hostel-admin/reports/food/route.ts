import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getFoodAnalytics } from "@/modules/reports/operations-analytics.service";

export const runtime = "nodejs";

/** Meal timing patterns and cook-device performance (PHASES.md §5.1). */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageFood");
    const params = request.nextUrl.searchParams;
    const result = await getFoodAnalytics(principal, {
      days: params.get("days") ? Number(params.get("days")) : undefined,
      hostelId: params.get("hostelId") ?? undefined,
    });

    return withEtag(request, successResponse(result, "Food analytics loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
