import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import { createBooking, listMyBookings } from "@/modules/bookings/booking.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The signed-in person's own bookings, newest first. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);

    return withEtag(request, successResponse({ bookings: await listMyBookings(principal) }, "Your bookings"));
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Books a room. The app authenticates with a Bearer token and the website with
 * its cookie, so the header is what records where the policy was accepted.
 */
export async function POST(request: NextRequest) {
  try {
    const limited = rateLimitPublicForm(request, {
      limit: 10,
      namespace: "booking-create",
      windowMs: 15 * 60 * 1000,
    });

    if (limited) {
      return limited;
    }

    const principal = await requireApiPrincipal(request);
    const source = request.headers.get("authorization") ? "MOBILE" : "WEB";
    const booking = await createBooking(await request.json(), principal, source);

    return successResponse({ booking }, "Booking created. Pay the booking fee to send it to the hostel.", {
      status: 201,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
