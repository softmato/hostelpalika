import type { NextRequest } from "next/server";

import { requirePlatformPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { feedbackStatusSchema, setFeedbackStatus } from "@/modules/feedback/feedback.service";

export const runtime = "nodejs";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requirePlatformPrincipal(request);
    const { status } = feedbackStatusSchema.parse(await request.json());

    return successResponse(await setFeedbackStatus((await params).id, status, principal.userId), "Updated");
  } catch (error) {
    return handleRouteError(error);
  }
}
