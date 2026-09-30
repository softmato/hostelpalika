import type { NextRequest } from "next/server";

import { requireHostelStaffPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { getHostelInviteOverview } from "@/modules/hostel-referrals/hostel-referral.service";
import { resolveAdminHostelId } from "@/modules/food/cook-scope";

export const runtime = "nodejs";

/**
 * Invite hostels: this hostel's code and link, and the hostels that used it.
 * Owner and wardens alike — the code belongs to the hostel, so either one
 * sharing it earns the same reward for the hostel.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const hostelId = resolveAdminHostelId(
      principal,
      request.nextUrl.searchParams.get("hostelId") ?? undefined,
    );

    return successResponse(await getHostelInviteOverview(hostelId.toString()), "Hostel referrals");
  } catch (error) {
    return handleRouteError(error);
  }
}
