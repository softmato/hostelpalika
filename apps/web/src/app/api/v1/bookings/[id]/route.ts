import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getMyBooking } from "@/modules/bookings/booking.service";

type RouteContext = { params: Promise<{ id: string }> };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One of the person's own bookings: status, deadlines, what cancelling now returns, how to pay. */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireApiPrincipal(request);
    const { id } = await context.params;

    return withEtag(request, successResponse({ booking: await getMyBooking(id, principal) }, "Booking"));
  } catch (error) {
    return handleRouteError(error);
  }
}
