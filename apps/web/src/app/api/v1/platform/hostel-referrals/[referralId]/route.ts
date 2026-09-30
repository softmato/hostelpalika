import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { markCommissionPaid } from "@/modules/hostel-referrals/hostel-referral.service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ referralId: string }> };

/** Marks a partner's commission on this referral as paid out. */
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const { referralId } = await context.params;

    return successResponse(await markCommissionPaid(referralId, principal), "Commission marked paid");
  } catch (error) {
    return handleRouteError(error);
  }
}
