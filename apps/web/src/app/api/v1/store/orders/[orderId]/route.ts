import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getOrder } from "@/modules/store/order.service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ orderId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const { orderId } = await context.params;

    return withEtag(request, successResponse(await getOrder(orderId, principal), "Order loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
