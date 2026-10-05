import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { decideKhataAccount, khataAccountDecisionSchema } from "@/modules/finance/khata.service";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

/** Open, refuse or close one resident's khata. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ residentId: string }> },
) {
  try {
    const principal = await requireHostelCapability(request, "recordCash");
    const { residentId } = await context.params;
    const input = khataAccountDecisionSchema.parse(await request.json());
    const hostelId = resolveAdminHostelId(principal, input.hostelId);

    return successResponse(
      await decideKhataAccount(hostelId, residentId, input.action, principal),
      "Khata updated",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
