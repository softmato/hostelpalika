import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getCheckout } from "@/modules/store/order.service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const requested = request.nextUrl.searchParams.get("hostelId") ?? undefined;

    return withEtag(request, successResponse(await getCheckout(principal, requested), "Checkout loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
