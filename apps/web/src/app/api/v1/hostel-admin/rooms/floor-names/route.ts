import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";
import { floorNameSchema, setFloorName } from "@/modules/hostels/hostel-rooms.service";

export const runtime = "nodejs";

/** Name a floor ("Lobby", "Girls block"); an empty name puts the ordinal back. */
export async function PUT(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const input = floorNameSchema.parse(await request.json());
    const hostelId = resolveAdminHostelId(principal, input.hostelId);

    return successResponse(await setFloorName(hostelId, input.floor, input.name, principal), "Saved");
  } catch (error) {
    return handleRouteError(error);
  }
}
