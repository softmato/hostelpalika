import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { cancelBookingByPlatform } from "@/modules/bookings/booking-answer.service";
import { getPlatformBooking } from "@/modules/bookings/booking-queries.service";

type RouteContext = { params: Promise<{ id: string }> };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One booking with its split and its transfers. */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await requireSuperadminPrincipal(request);

    const { id } = await context.params;

    return withEtag(request, successResponse({ booking: await getPlatformBooking(id) }, "Booking"));
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Cancels a paid open booking for the platform, in full. `reason` required. */
export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const { id } = await context.params;
    const booking = await cancelBookingByPlatform(id, await request.json().catch(() => ({})), principal);

    return successResponse({ booking }, "Booking cancelled. The refund is due.");
  } catch (error) {
    return handleRouteError(error);
  }
}
