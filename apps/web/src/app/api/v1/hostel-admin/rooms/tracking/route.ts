import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";
import { roomTrackingSchema, setRoomTracking } from "@/modules/hostels/hostel-rooms.service";

export const runtime = "nodejs";

/** Floor and room tracking on or off. The owner decides. */
export async function PUT(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const input = roomTrackingSchema.parse(await request.json());
    const hostelId = resolveAdminHostelId(principal, input.hostelId);

    return successResponse(await setRoomTracking(hostelId, input.enabled, principal), "Saved");
  } catch (error) {
    return handleRouteError(error);
  }
}
