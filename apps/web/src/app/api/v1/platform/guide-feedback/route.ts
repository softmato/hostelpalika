import type { NextRequest } from "next/server";

import { requirePlatformPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listGuideFeedback } from "@/modules/feedback/guide-feedback.service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requirePlatformPrincipal(request);
    return withEtag(request, successResponse(await listGuideFeedback()));
  } catch (error) {
    return handleRouteError(error);
  }
}
