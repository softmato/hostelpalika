import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import {
  getPlatformReferralOverview,
  saveHostelReferralSettings,
} from "@/modules/hostel-referrals/hostel-referral.service";

export const runtime = "nodejs";

/** Referral settings: program rewards, partner codes and every referral. */
export async function GET(request: NextRequest) {
  try {
    await requireSuperadminPrincipal(request);

    return successResponse(await getPlatformReferralOverview(), "Hostel referrals");
  } catch (error) {
    return handleRouteError(error);
  }
}

/** The hostel-to-hostel rewards. Partial edits merge onto what is stored. */
export async function PUT(request: NextRequest) {
  try {
    const principal = await requireSuperadminPrincipal(request);

    return successResponse(
      { settings: await saveHostelReferralSettings(await request.json(), principal.userId) },
      "Referral settings saved",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
