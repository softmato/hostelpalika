import type { NextRequest } from "next/server";

import { loadApiPrincipal, requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  deleteOwnPost,
  getCommunityPost,
} from "@/modules/community/community.service";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ postId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { postId } = await context.params;
    const principal = await loadApiPrincipal(request);
    const result = await getCommunityPost(postId, principal);

    return withEtag(request, successResponse(result, "Post loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { postId } = await context.params;
    const principal = await requireApiPrincipal(request);
    const result = await deleteOwnPost(postId, principal);

    return successResponse(result, "Post deleted");
  } catch (error) {
    return handleRouteError(error);
  }
}
