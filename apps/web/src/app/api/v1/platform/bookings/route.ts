import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  listPausedHostels,
  listPlatformBookings,
} from "@/modules/bookings/booking-queries.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `?tab=waiting|holds|all|paused` (+ `status`, `hostelId` on all), with every queue's count. */
export async function GET(request: NextRequest) {
  try {
    await requireSuperadminPrincipal(request);

    const params = request.nextUrl.searchParams;
    const list = await listPlatformBookings({
      hostelId: params.get("hostelId"),
      status: params.get("status"),
      tab: params.get("tab"),
    });
    const pausedHostels = params.get("tab") === "paused" ? await listPausedHostels() : undefined;

    return withEtag(request, successResponse({ ...list, pausedHostels }, "Bookings"));
  } catch (error) {
    return handleRouteError(error);
  }
}
