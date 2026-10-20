import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listHostelBookings } from "@/modules/bookings/booking-queries.service";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `?tab=requests|confirmed|history`, with the badge counts, what the hostel is owed, and any pause. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const params = request.nextUrl.searchParams;
    const hostelId = resolveAdminHostelId(principal, params.get("hostelId") ?? undefined);

    return withEtag(request, successResponse(await listHostelBookings(hostelId, params.get("tab")), "Bookings"));
  } catch (error) {
    return handleRouteError(error);
  }
}
