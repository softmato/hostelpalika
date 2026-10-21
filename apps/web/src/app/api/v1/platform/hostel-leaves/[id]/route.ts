import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { getHostelLeaveRequest } from "@/modules/hostels/hostel-leave.service";

export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSuperadminPrincipal(request);

    const { id } = await params;

    return successResponse(await getHostelLeaveRequest(id), "Leave request loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}
