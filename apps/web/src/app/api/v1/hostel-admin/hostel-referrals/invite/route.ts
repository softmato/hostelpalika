import type { NextRequest } from "next/server";

import { requireHostelStaffPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { sendHostelInvite } from "@/modules/hostel-referrals/hostel-referral.service";
import { hostelReferralInviteSchema } from "@/modules/hostel-referrals/hostel-referral.validation";
import { resolveAdminHostelId } from "@/modules/food/cook-scope";

export const runtime = "nodejs";

/** Emails the hostel's referral link to another hostel's owner. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const input = hostelReferralInviteSchema.parse(await request.json());
    const hostelId = resolveAdminHostelId(principal, input.hostelId);

    return successResponse(await sendHostelInvite(hostelId.toString(), input, principal), "Invite sent");
  } catch (error) {
    return handleRouteError(error);
  }
}
