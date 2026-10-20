import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { clearCart, getCart } from "@/modules/store/cart.service";

export const runtime = "nodejs";

/**
 * `hostelId` is optional and only needed by an owner with more than one hostel -
 * see `resolveStoreHostelId`. Every route in this folder takes it the same way.
 */
function hostelId(request: NextRequest) {
  return request.nextUrl.searchParams.get("hostelId") ?? undefined;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);

    return withEtag(request, successResponse(await getCart(principal, hostelId(request)), "Cart loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);

    return successResponse(await clearCart(principal, hostelId(request)), "Cart emptied");
  } catch (error) {
    return handleRouteError(error);
  }
}
