import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getCartCount } from "@/modules/store/cart.service";

export const runtime = "nodejs";

/** Just the badge. See `getCartCount` for why it is not the full cart read. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const requested = request.nextUrl.searchParams.get("hostelId") ?? undefined;

    return withEtag(request, successResponse(await getCartCount(principal, requested), "Cart count loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
