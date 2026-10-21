import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { listHeldHostels, reclaimHostel } from "@/modules/hostels/hostel-leave.service";
import { hostelReclaimSchema } from "@/modules/hostels/hostel-leave.validation";

export const runtime = "nodejs";

/**
 * A hostel this account took off the platform and can still claim back
 * (docs/HOSTEL_LEAVE_PLATFORM.md). Any signed-in account: after leaving, the
 * owner is a public account again.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);

    return successResponse(await listHeldHostels(principal.userId), "Held hostels loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const input = hostelReclaimSchema.parse(await request.json());

    return successResponse(await reclaimHostel(principal, input.requestId), "Your hostel is back");
  } catch (error) {
    return handleRouteError(error);
  }
}
