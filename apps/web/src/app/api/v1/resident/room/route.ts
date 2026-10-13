import type { NextRequest } from "next/server";

import { requireResidentPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import {
  askRoomChange,
  cancelRoomChange,
  getMyRoomOptions,
  roomChangeAskSchema,
} from "@/modules/hostels/hostel-rooms.service";

export const runtime = "nodejs";

/** My room, the free beds I could ask for, and my open request. */
export async function GET(request: NextRequest) {
  try {
    return successResponse(await getMyRoomOptions(await requireResidentPrincipal(request)), "My room");
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Ask to move to a free bed. A warden confirms before anything changes. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);
    const input = roomChangeAskSchema.parse(await request.json());

    return successResponse(await askRoomChange(principal, input), "Request sent", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    return successResponse(await cancelRoomChange(await requireResidentPrincipal(request)), "Request cancelled");
  } catch (error) {
    return handleRouteError(error);
  }
}
