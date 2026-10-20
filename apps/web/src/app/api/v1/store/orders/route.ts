import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listOrders, placeOrder } from "@/modules/store/order.service";
import {
  storeOrderCreateSchema,
  storeOrderListQuerySchema,
} from "@/modules/store/store.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const query = storeOrderListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const requested = request.nextUrl.searchParams.get("hostelId") ?? undefined;

    return withEtag(request, successResponse(await listOrders(query, principal, requested), "Orders loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const input = storeOrderCreateSchema.parse(await request.json());
    const requested = request.nextUrl.searchParams.get("hostelId") ?? undefined;

    return successResponse(await placeOrder(input, principal, requested), "Order placed", {
      status: 201,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
