import type { NextRequest } from "next/server";

import { loadApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { getBookingQuote } from "@/modules/bookings/booking.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What booking this room costs and whether it can be booked. Signed out is fine: the button shows either way. */
export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const quote = await getBookingQuote(
      params.get("hostel") ?? "",
      params.get("roomType") ?? "",
      await loadApiPrincipal(request),
      { moveIn: params.get("moveIn"), moveOut: params.get("moveOut") },
    );

    return successResponse({ quote }, "Booking quote");
  } catch (error) {
    return handleRouteError(error);
  }
}
