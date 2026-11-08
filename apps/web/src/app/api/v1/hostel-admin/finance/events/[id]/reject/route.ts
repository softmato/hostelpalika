import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { claimRejectSchema } from "@/lib/finance/claim.validation";
import { rejectClaim } from "@/modules/finance/review.service";

export const runtime = "nodejs";

/**
 * Reject a resident's payment claim (target §11.4, plan item 2.8).
 *
 * The reason is required and is shown to the resident — a rejection they cannot
 * act on sends them straight to the hostel office to ask why.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const principal = await requireHostelCapability(request, "approvePayments");
    const { id } = await context.params;
    const { rejectionReason } = claimRejectSchema.parse(await request.json());

    return successResponse(
      await rejectClaim(id, rejectionReason, principal),
      "Payment proof rejected",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
