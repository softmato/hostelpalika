import type { NextRequest } from "next/server";

import { loadApiPrincipal, requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { commentOnPost, listPostComments } from "@/modules/community/community.service";
import { communityCommentCreateSchema } from "@/modules/community/community.validation";
import { paginationQuerySchema } from "@/lib/pagination";
import { z } from "zod";

export const runtime = "nodejs";

const querySchema = z.object(paginationQuerySchema);

type RouteContext = {
  params: Promise<{ postId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { postId } = await context.params;
    const principal = await loadApiPrincipal(request);
    const query = querySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await listPostComments(postId, principal, query);

    return withEtag(request, successResponse(result, "Comments loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { postId } = await context.params;
    const principal = await requireApiPrincipal(request);
    const input = communityCommentCreateSchema.parse(await request.json());
    const result = await commentOnPost(postId, input, principal);

    return successResponse(result, "Comment added", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
