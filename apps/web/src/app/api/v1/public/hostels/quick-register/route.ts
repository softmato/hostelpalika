import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import {
  quickHostelRegistrationSchema,
  quickRegisterHostel,
} from "@/modules/hostels/hostel-quick-registration.service";

export const runtime = "nodejs";

/**
 * The quick sign-up: owner name, phone, hostel name → the hostel portal on
 * the signed-in account, on the trial (docs/QUICK_SIGNUP_KYC_TRIAL.md). The
 * client refreshes its session afterwards to pick up the HOSTEL_ADMIN role.
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimited = rateLimitPublicForm(request, { namespace: "quick-hostel-registration" });

    if (rateLimited) {
      return rateLimited;
    }

    const principal = await requireApiPrincipal(request);
    const input = quickHostelRegistrationSchema.parse(await request.json());
    const result = await quickRegisterHostel(input, principal.userId);

    return successResponse(result, "Your hostel portal is open", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
