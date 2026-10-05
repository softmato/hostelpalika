import type { NextRequest } from "next/server";

import { assertApiRoles, requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { Role } from "@/lib/roles";
import { listKhataOrders } from "@/modules/finance/khata.service";
import { resolveCookHostelId } from "@/modules/food/cook.service";

export const runtime = "nodejs";

/** Khata asks for the kitchen. Staff read the same list. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    assertApiRoles(principal, [Role.COOK, Role.HOSTEL_ADMIN, Role.WARDEN]);
    const hostelId = await resolveCookHostelId(
      principal,
      request.nextUrl.searchParams.get("hostelId") ?? undefined,
    );

    return successResponse(await listKhataOrders(hostelId), "Khata asks");
  } catch (error) {
    return handleRouteError(error);
  }
}
