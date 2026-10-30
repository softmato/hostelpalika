import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";
import { orderRooms, roomOrderSchema } from "@/modules/hostels/hostel-rooms.service";

export const runtime = "nodejs";

/** Saves where the owner dragged a floor's rooms. */
export async function PUT(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const input = roomOrderSchema.parse(await request.json());
    const hostelId = resolveAdminHostelId(principal, input.hostelId);

    return successResponse(await orderRooms(hostelId, input), "Saved");
  } catch (error) {
    return handleRouteError(error);
  }
}
