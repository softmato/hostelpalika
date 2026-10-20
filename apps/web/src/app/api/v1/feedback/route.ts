import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import { createFeedback, feedbackCreateSchema, feedbackQuotaReached } from "@/modules/feedback/feedback.service";

export const runtime = "nodejs";

/** Help & support → Send feedback, from any signed-in portal. */
export async function POST(request: NextRequest) {
  try {
    // Burst gate per device first (cheap), then the per-account budget in the database.
    const limited = rateLimitPublicForm(request, { limit: 3, namespace: "feedback", windowMs: 60_000 });
    if (limited) return limited;

    const principal = await requireApiPrincipal(request);

    if (await feedbackQuotaReached(principal.userId)) {
      return errorResponse("You have sent several messages recently. Please try again in a while.", "RATE_LIMITED", 429);
    }

    const input = feedbackCreateSchema.parse(await request.json());

    return successResponse(await createFeedback(principal, input), "Thanks — we have it.");
  } catch (error) {
    return handleRouteError(error);
  }
}
