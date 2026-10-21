import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { approveHostelLeaveRequest } from "@/modules/hostels/hostel-leave.service";
import { hostelLeaveApproveSchema } from "@/modules/hostels/hostel-leave.validation";

export const runtime = "nodejs";
// Building a hostel's whole history into CSVs and mailing it can take a while.
export const maxDuration = 60;

/** Emails the ticked data to the owner, then takes the hostel off the platform for its hold. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const { id } = await params;
    const input = hostelLeaveApproveSchema.parse(await request.json());

    return successResponse(
      await approveHostelLeaveRequest(id, input, principal),
      "Approved — the data was emailed and the hostel is off the platform",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
