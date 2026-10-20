import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getStoreShelves } from "@/modules/store/catalog.service";

export const runtime = "nodejs";

/**
 * Every department with the first few products on its shelf, in one request.
 *
 * The Departments screen would otherwise be a `GET /store/products` per
 * category — sixteen round trips for one screen. `?search=` narrows the shelves
 * and drops the ones left empty.
 *
 * HOSTEL_ADMIN only, for the reason `store/home` gives: buying supplies commits
 * the hostel's money, and a warden's permissions are about running the building
 * rather than spending its budget.
 */
export async function GET(request: NextRequest) {
  try {
    await requireHostelAdminPrincipal(request);

    const search = request.nextUrl.searchParams.get("search") ?? undefined;

    return withEtag(request, successResponse(await getStoreShelves({ search }), "Departments loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
