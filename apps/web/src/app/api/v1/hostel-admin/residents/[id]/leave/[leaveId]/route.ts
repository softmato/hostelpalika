import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { cancelLeave } from "@/modules/finance/resident-leave.service";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string; leaveId: string }> };

/** Takes an entry back off; its money goes back on the bill. */
export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelCapability(request, "recordCash");
    const { id, leaveId } = await context.params;
    const hostelId = resolveAdminHostelId(principal, request.nextUrl.searchParams.get("hostelId") ?? undefined);

    return successResponse(await cancelLeave(hostelId, id, leaveId, principal), "Removed");
  } catch (error) {
    return handleRouteError(error);
  }
}
