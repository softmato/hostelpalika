import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { createPartnerCode } from "@/modules/hostel-referrals/hostel-referral.service";
import { partnerCodeCreateSchema } from "@/modules/hostel-referrals/hostel-referral.validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const input = partnerCodeCreateSchema.parse(await request.json());

    return successResponse(await createPartnerCode(input, principal), "Partner code created", {
      status: 201,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
