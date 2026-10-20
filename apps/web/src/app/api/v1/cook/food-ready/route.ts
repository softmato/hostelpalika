import type { NextRequest } from "next/server";

import { assertApiRoles, requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { Role } from "@/lib/roles";
import { announceFoodReady, listFoodReadyLogs } from "@/modules/food/cook.service";
import { foodReadySchema } from "@/modules/food/cook.validation";

export const runtime = "nodejs";

/** COOK announces a meal; hostel staff can do the same and read the history. */
const ALLOWED_ROLES = [Role.COOK, Role.HOSTEL_ADMIN, Role.WARDEN];

export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    assertApiRoles(principal, ALLOWED_ROLES);

    const hostelId = request.nextUrl.searchParams.get("hostelId") ?? undefined;
    const result = await listFoodReadyLogs(principal, hostelId);

    return withEtag(request, successResponse(result, "Food ready log loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    assertApiRoles(principal, ALLOWED_ROLES);

    const input = foodReadySchema.parse(await request.json());
    const result = await announceFoodReady(input, principal);

    return successResponse(result, "Residents notified", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
