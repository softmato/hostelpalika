import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { submitHostelKyc } from "@/modules/hostels/hostel-kyc.service";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

/** Sends a quick sign-up's KYC to our team (docs/QUICK_SIGNUP_KYC_TRIAL.md). */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const hostelId = resolveAdminHostelId(
      principal,
      typeof body.hostelId === "string" ? body.hostelId : undefined,
    );

    return successResponse(
      { kyc: await submitHostelKyc(String(hostelId), principal.userId) },
      "KYC submitted",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
