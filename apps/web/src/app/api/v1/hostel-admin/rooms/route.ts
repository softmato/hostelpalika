import type { NextRequest } from "next/server";

import { requireHostelCapability, requireHostelStaffPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";
import { addRooms, addRoomsSchema, getRoomLayout } from "@/modules/hostels/hostel-rooms.service";

export const runtime = "nodejs";

/** Floors, numbered rooms, who is in each, and who has no room yet. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const hostelId = resolveAdminHostelId(principal, request.nextUrl.searchParams.get("hostelId") ?? undefined);

    return successResponse(await getRoomLayout(hostelId), "Rooms");
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Add a floor's rooms in one go. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageRooms");
    const input = addRoomsSchema.parse(await request.json());
    const hostelId = resolveAdminHostelId(principal, input.hostelId);

    return successResponse(await addRooms(hostelId, input, principal), "Rooms added", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
