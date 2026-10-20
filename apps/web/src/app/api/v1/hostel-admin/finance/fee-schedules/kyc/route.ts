import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { saveKycRates } from "@/modules/finance/fee-schedule.service";
import { feeScheduleKycSchema } from "@/modules/finance/fee-schedule.validation";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

/** Rents + fees typed on Hostel KYC — see `saveKycRates` for what changes when. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageFeeSchedule");
    const input = feeScheduleKycSchema.parse(await request.json());
    const hostelId = resolveAdminHostelId(principal, input.hostelId);

    return successResponse(await saveKycRates(hostelId, input, principal), "Rents saved");
  } catch (error) {
    return handleRouteError(error);
  }
}
