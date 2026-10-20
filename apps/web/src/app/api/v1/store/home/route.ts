import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getStoreHome } from "@/modules/store/catalog.service";

export const runtime = "nodejs";

/**
 * The shop screen in one request - config, categories, featured and newest.
 *
 * HOSTEL_ADMIN only, not `requireHostelStaffPrincipal`. Buying supplies commits
 * the hostel's money, and a warden's permission set is about running the
 * building rather than spending its budget; the same reasoning keeps a
 * PLATFORM_MODERATOR off the sponsors screen.
 */
export async function GET(request: NextRequest) {
  try {
    await requireHostelAdminPrincipal(request);

    return withEtag(request, successResponse(await getStoreHome(), "Store loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
