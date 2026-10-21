import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { rejectHostelLeaveRequest } from "@/modules/hostels/hostel-leave.service";
import { hostelLeaveRejectSchema } from "@/modules/hostels/hostel-leave.validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const { id } = await params;
    const input = hostelLeaveRejectSchema.parse(await request.json());

    return successResponse(
      { request: await rejectHostelLeaveRequest(id, input, principal) },
      "Request not approved — the owner was told",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
