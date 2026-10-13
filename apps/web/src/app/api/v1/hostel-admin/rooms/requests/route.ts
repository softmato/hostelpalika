import type { NextRequest } from "next/server";

import { requireHostelStaffPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";
import { listRoomChangeRequests } from "@/modules/hostels/hostel-rooms.service";

export const runtime = "nodejs";

/** Residents asking for another room, oldest first. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const hostelId = resolveAdminHostelId(principal, request.nextUrl.searchParams.get("hostelId") ?? undefined);

    return successResponse({ requests: await listRoomChangeRequests(hostelId) }, "Room requests");
  } catch (error) {
    return handleRouteError(error);
  }
}
