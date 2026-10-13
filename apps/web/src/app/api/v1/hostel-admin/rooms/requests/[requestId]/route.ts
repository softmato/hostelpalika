import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";
import { answerRoomChange, roomChangeAnswerSchema } from "@/modules/hostels/hostel-rooms.service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ requestId: string }> };

/** Confirm (they move now) or decline a room change. */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelCapability(request, "registerResidents");
    const { requestId } = await context.params;
    const input = roomChangeAnswerSchema.parse(await request.json());
    const hostelId = resolveAdminHostelId(principal, input.hostelId);

    return successResponse({ requests: await answerRoomChange(hostelId, requestId, input, principal) }, "Answered");
  } catch (error) {
    return handleRouteError(error);
  }
}
