import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { updateOneOffFees } from "@/modules/finance/fee-schedule.service";
import { feeScheduleOneOffSchema } from "@/modules/finance/fee-schedule.validation";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

/** Admission, form fee, deposit and referral discount: changed right away, no month. */
export async function PATCH(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageFeeSchedule");
    const input = feeScheduleOneOffSchema.parse(await request.json());
    const hostelId = resolveAdminHostelId(principal, input.hostelId);

    return successResponse(await updateOneOffFees(hostelId, input, principal), "Joining fees updated");
  } catch (error) {
    return handleRouteError(error);
  }
}
