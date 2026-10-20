import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { requirePlatformPrincipal, requireSuperadminPrincipal } from "@/lib/api-auth";
import { getPlatformHostel } from "@/modules/hostels/hostel.service";
import { purgeArchivedHostel } from "@/modules/hostels/hostel-purge.service";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await requirePlatformPrincipal(request);

    const { id } = await context.params;
    const result = await getPlatformHostel(id);

    return withEtag(request, successResponse(result, "Hostel application loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Erase an archived hostel now, instead of waiting out its 60-day grace period.
 *
 * Superadmin only, and refused unless the hostel is **already archived** — so
 * this is always the second deliberate act on something that is already off the
 * site. `purgeArchivedHostel` holds that check; it is not the route's to skip.
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const { id } = await context.params;
    const result = await purgeArchivedHostel(id, principal);

    return successResponse(
      result,
      `"${result.name}" erased permanently — ${result.documentsDeleted} records and ${result.objectsDeleted} files.`,
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
