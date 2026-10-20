import type { NextRequest } from "next/server";

import { requireHostelStaffPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  createCommunityAnnouncement,
  listCommunityModeration,
} from "@/modules/community/community.service";
import {
  communityAnnouncementSchema,
  communityModerationQuerySchema,
} from "@/modules/community/community.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const query = communityModerationQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await listCommunityModeration(query, principal);

    return withEtag(request, successResponse(result, "Community posts loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Official hostel announcement, pinned to the top of that hostel's space. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const input = communityAnnouncementSchema.parse(await request.json());
    const result = await createCommunityAnnouncement(input, principal);

    return successResponse(result, "Announcement posted", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
