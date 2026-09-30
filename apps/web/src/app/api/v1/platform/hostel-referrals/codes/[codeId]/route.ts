import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { updatePartnerCode } from "@/modules/hostel-referrals/hostel-referral.service";
import { partnerCodeUpdateSchema } from "@/modules/hostel-referrals/hostel-referral.validation";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ codeId: string }> };

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    await requireSuperadminPrincipal(request);
    const { codeId } = await context.params;
    const input = partnerCodeUpdateSchema.parse(await request.json());

    return successResponse(await updatePartnerCode(codeId, input), "Partner code updated");
  } catch (error) {
    return handleRouteError(error);
  }
}
