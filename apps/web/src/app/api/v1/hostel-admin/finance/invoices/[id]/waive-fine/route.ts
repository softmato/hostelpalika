import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { waiveLateFine } from "@/modules/finance/late-fine.service";

export const runtime = "nodejs";

/** Takes the late fine off one bill for good. Whoever may set the fine may waive it. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const principal = await requireHostelCapability(request, "manageFeeSchedule");
    const { id } = await context.params;

    return successResponse(await waiveLateFine(id, principal.hostelIds, principal), "Fine waived");
  } catch (error) {
    return handleRouteError(error);
  }
}
