import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";
import { moveResidentToRoom } from "@/modules/hostels/hostel-rooms.service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

const schema = z.object({
  hostelId: z.string().optional(),
  roomId: z.string().regex(/^[a-f\d]{24}$/i, "Pick a room."),
});

/** Staff put a resident in a room, or move them, directly. */
export async function PUT(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelCapability(request, "registerResidents");
    const { id } = await context.params;
    const input = schema.parse(await request.json());
    const hostelId = resolveAdminHostelId(principal, input.hostelId);
    const room = await moveResidentToRoom(hostelId, id, input.roomId, principal);

    return successResponse(
      { room: { floor: room.floor, id: room._id.toString(), number: room.number, roomType: room.roomType } },
      "Room set",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
