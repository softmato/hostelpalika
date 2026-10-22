import type { NextRequest } from "next/server";

import { assertApiRoles, requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { cachedRead } from "@/lib/redis-cache";
import { Role } from "@/lib/roles";
import { getCookToday } from "@/modules/food/cook.service";

export const runtime = "nodejs";

/**
 * The kitchen's brief for today: menu, head count, and what has already been
 * announced.
 *
 * Same audience as `POST /cook/food-ready` — a COOK, plus the hostel staff who
 * may announce on their behalf. It is **not** behind `requireHostelCapability`:
 * that gate resolves to HOSTEL_ADMIN or WARDEN only, which is exactly why the
 * cook's own reads could not live under `hostel-admin/food/*` and had to be
 * built here (MOBILE_APP_PHASES.md §1, server gap #3).
 */
const ALLOWED_ROLES = [Role.COOK, Role.HOSTEL_ADMIN, Role.WARDEN];

export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    assertApiRoles(principal, ALLOWED_ROLES);

    const hostelId = request.nextUrl.searchParams.get("hostelId") ?? undefined;
    const result = await cachedRead({ hostelIds: hostelId ? [hostelId] : principal.hostelIds, userId: principal.userId }, "cook-today", () => getCookToday(principal, hostelId));

    return withEtag(request, successResponse(result, "Today's kitchen brief loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
