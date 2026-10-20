import type { NextRequest } from "next/server";

import { assertApiRoles, requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { Role } from "@/lib/roles";
import { listCookResidents } from "@/modules/food/cook.service";

export const runtime = "nodejs";

/**
 * Who is eating: name and room type, and nothing else.
 *
 * No phone, no email, no deposit, no move-in date, no account linkage. The cook
 * credential is shared kitchen-wide and effectively static, so this is the one
 * list in the product that a leaked shared password would expose — reduced to
 * what a noticeboard already shows, it is worth nothing to whoever finds it.
 */
const ALLOWED_ROLES = [Role.COOK, Role.HOSTEL_ADMIN, Role.WARDEN];

export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    assertApiRoles(principal, ALLOWED_ROLES);

    const hostelId = request.nextUrl.searchParams.get("hostelId") ?? undefined;
    const result = await listCookResidents(principal, hostelId);

    return withEtag(request, successResponse(result, "Residents loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
