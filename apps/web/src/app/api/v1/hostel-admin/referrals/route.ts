import type { NextRequest } from "next/server";

import { requireHostelStaffPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listHostelAdminReferrals } from "@/modules/referrals/referral.service";
import { hostelAdminReferralListQuerySchema } from "@/modules/referrals/referral.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const query = hostelAdminReferralListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await listHostelAdminReferrals(query, principal);

    return withEtag(request, successResponse(result, "Referrals loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
