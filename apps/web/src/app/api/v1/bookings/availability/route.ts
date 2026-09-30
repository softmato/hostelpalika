import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import {
  hostelAvailability,
  loadBookableHostel,
} from "@/modules/bookings/booking-availability";
import { findDemoHostel } from "@/modules/hostels/demo-hostels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every room type's Book state on one hostel, in one call — the hostel page has
 * a button per room card. Public. The checkout asks again for the one room, and
 * creating the booking asks a third time; this answer is only ever a hint.
 */
export async function GET(request: NextRequest) {
  try {
    const ref = request.nextUrl.searchParams.get("hostel") ?? "";

    // Sample listings draw the disabled "Not taking bookings" state on web and app.
    if (findDemoHostel(ref)) {
      return successResponse({ availability: { hostelReason: "BOOKINGS_PAUSED", rooms: [] } }, "Booking availability");
    }

    const hostel = ref ? await loadBookableHostel(ref) : null;

    if (!hostel || hostel.isDeleted) {
      return successResponse({ availability: { hostelReason: "HOSTEL_NOT_LIVE", rooms: [] } }, "Booking availability");
    }

    const availability = await hostelAvailability(hostel);

    return successResponse(
      {
        availability: {
          hostelReason: availability.hostelReason,
          rooms: availability.rooms.map((room) => ({
            bookable: room.bookable,
            fee: room.fee,
            photos: room.photos,
            reason: room.reason,
            roomType: room.roomType,
          })),
        },
      },
      "Booking availability",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
