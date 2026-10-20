import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { findCardBooking } from "@/modules/bookings/booking-checkin.service";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `?card=HH-XXXX-XXXX` — the booking a scanned ID card holds at this hostel, for
 * the add-resident screen's banner. Whoever may register residents may ask.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "registerResidents");
    const params = request.nextUrl.searchParams;
    const hostelId = resolveAdminHostelId(principal, params.get("hostelId") ?? undefined);
    const booking = await findCardBooking(hostelId, params.get("card") ?? "");

    return withEtag(request, successResponse({ booking }, booking ? "This card holds a booking" : "No booking on this card"));
  } catch (error) {
    return handleRouteError(error);
  }
}
