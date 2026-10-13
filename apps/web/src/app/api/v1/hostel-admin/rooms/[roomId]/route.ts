import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";
import { deleteRoom, updateRoom, updateRoomSchema } from "@/modules/hostels/hostel-rooms.service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ roomId: string }> };

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelCapability(request, "manageRooms");
    const { roomId } = await context.params;
    const input = updateRoomSchema.parse(await request.json());
    const hostelId = resolveAdminHostelId(principal, input.hostelId);

    return successResponse(await updateRoom(hostelId, roomId, input, principal), "Room saved");
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelCapability(request, "manageRooms");
    const { roomId } = await context.params;
    const hostelId = resolveAdminHostelId(principal, request.nextUrl.searchParams.get("hostelId") ?? undefined);

    return successResponse(await deleteRoom(hostelId, roomId, principal), "Room removed");
  } catch (error) {
    return handleRouteError(error);
  }
}
