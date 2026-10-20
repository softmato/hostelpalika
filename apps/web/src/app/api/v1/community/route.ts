import type { NextRequest } from "next/server";

import { loadApiPrincipal, requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  createCommunityPost,
  listCommunityFeed,
} from "@/modules/community/community.service";
import {
  communityFeedQuerySchema,
  communityPostCreateSchema,
} from "@/modules/community/community.validation";

export const runtime = "nodejs";

/**
 * Reading the community needs no account — a signed-out visitor gets the public
 * space and every hostel post whose author chose PUBLIC. Posting always needs
 * one.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await loadApiPrincipal(request);
    const query = communityFeedQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await listCommunityFeed(query, principal);

    return withEtag(request, successResponse(result, "Community feed loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const input = communityPostCreateSchema.parse(await request.json());
    const result = await createCommunityPost(input, principal);

    return successResponse(result, "Post published", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
