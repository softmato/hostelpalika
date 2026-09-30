import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import { previewHostelReferralCode } from "@/modules/hostel-referrals/hostel-referral.service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ code: string }> };

/** The registration form's "Check code": who it is from and what it gives. */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const rateLimited = rateLimitPublicForm(request, { namespace: "hostel-referral-code" });

    if (rateLimited) {
      return rateLimited;
    }

    const { code } = await context.params;

    return successResponse(await previewHostelReferralCode(code), "Referral code");
  } catch (error) {
    return handleRouteError(error);
  }
}
