import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import { recordUsage } from "@/modules/usage/usage.service";
import { usageBatchSchema } from "@/modules/usage/usage.validation";

export const runtime = "nodejs";

/**
 * The usage watcher's inbox (H3): the app and the web portals post batches of
 * opens, screen times and feature uses here. Signed-in people only — the role
 * and hostel come from the session, never from the body.
 */
export async function POST(request: NextRequest) {
  try {
    // Clients batch (one post per ~30s or on going to the background), so a
    // device past this is looping, not using the app.
    const rateLimited = rateLimitPublicForm(request, { limit: 30, namespace: "usage-events" });

    if (rateLimited) return rateLimited;

    const principal = await requireApiPrincipal(request);
    const batch = usageBatchSchema.parse(await request.json());
    const result = await recordUsage(principal, batch.client, batch.events);

    return successResponse(result, "Usage recorded");
  } catch (error) {
    return handleRouteError(error);
  }
}
