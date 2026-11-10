import type { NextRequest } from "next/server";

import { loadApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import { createGuideFeedback, guideFeedbackSchema } from "@/modules/feedback/guide-feedback.service";

export const runtime = "nodejs";

/** "Is this page useful?" on the public guide. Signed-in is optional. */
export async function POST(request: NextRequest) {
  try {
    const limited = rateLimitPublicForm(request, { limit: 10, namespace: "guide-feedback", windowMs: 60_000 });
    if (limited) return limited;

    const input = guideFeedbackSchema.parse(await request.json());
    // A reader whose token fails is still a reader.
    const principal = await loadApiPrincipal(request).catch(() => null);

    return successResponse(await createGuideFeedback(principal, input), "Thanks for telling us.");
  } catch (error) {
    return handleRouteError(error);
  }
}
