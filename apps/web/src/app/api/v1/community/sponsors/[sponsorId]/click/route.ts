import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import { recordSponsorClick } from "@/modules/sponsors/sponsor.service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sponsorId: string }> };

/**
 * Click-through counter for a sponsor card. Unauthenticated on purpose — a
 * signed-out visitor clicking an ad is exactly the traffic a sponsor is paying
 * for, and requiring an account would undercount it to nearly nothing.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { sponsorId } = await context.params;
    // Over a visitor's hourly budget the click is answered but not counted, so
    // a script cannot inflate a sponsor's numbers.
    const overBudget = rateLimitPublicForm(request, {
      limit: 20,
      namespace: "sponsor-click",
      windowMs: 60 * 60 * 1000,
    });
    const result = overBudget ? { recorded: true } : await recordSponsorClick(sponsorId);

    return successResponse(result, "Click recorded");
  } catch (error) {
    return handleRouteError(error);
  }
}
