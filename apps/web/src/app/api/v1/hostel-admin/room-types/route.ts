import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { requireHostelCapability } from "@/lib/api-auth";
import { findScopedHostel } from "@/modules/hostels/hostel.service";
import { listAvailableRoomTypes } from "@/modules/hostels/hostel-capacity.service";
import { hostelScopedListQuerySchema } from "@/modules/hostels/hostel.validation";

export const runtime = "nodejs";

/**
 * Room types that still have a free bed, for the resident intake form. Reads
 * the same roomConfigurations counts that admitting a resident decrements.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "registerResidents");
    const query = hostelScopedListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const hostel = await findScopedHostel(principal, query.hostelId);
    const roomTypes = await listAvailableRoomTypes(hostel._id);

    return withEtag(request, successResponse({ roomTypes }, "Room types loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
