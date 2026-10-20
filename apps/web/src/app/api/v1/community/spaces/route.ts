import type { NextRequest } from "next/server";

import { loadApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listCommunitySpaces } from "@/modules/community/community.service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await loadApiPrincipal(request);
    const result = await listCommunitySpaces(principal);

    return withEtag(request, successResponse(result, "Community spaces loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
