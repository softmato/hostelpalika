import type { NextRequest } from "next/server";

import { requirePlatformPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listCommunityModeration } from "@/modules/community/community.service";
import { communityModerationQuerySchema } from "@/modules/community/community.validation";

export const runtime = "nodejs";

/**
 * The platform-wide moderation queue. Same service, wider scope: a hostel admin
 * only ever reaches their own hostel's posts, so public-space posts would have
 * nobody to review them without this.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePlatformPrincipal(request);
    const query = communityModerationQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await listCommunityModeration(query, principal);

    return withEtag(request, successResponse(result, "Community posts loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
