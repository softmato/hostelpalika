import type { NextRequest } from "next/server";

import { requirePlatformPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listFeedback } from "@/modules/feedback/feedback.service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requirePlatformPrincipal(request);
    const params = request.nextUrl.searchParams;
    const status = params.get("status") ?? undefined;
    const role = params.get("role")?.trim() || undefined;

    return withEtag(
      request,
      successResponse(
        await listFeedback(
          status && ["NEW", "SEEN", "DONE"].includes(status) ? status : undefined,
          role && /^[A-Z_]{2,40}$/.test(role) ? role : undefined,
        ),
      ),
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
