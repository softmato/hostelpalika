import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { requireSuperadminPrincipal } from "@/lib/api-auth";
import {
  liftPlatformHostelSuspension,
  startHostelSuspension,
} from "@/modules/hostels/hostel-suspension.service";
import { hostelSuspendSchema } from "@/lib/hostels/hostel.validation";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";

/**
 * Starts pre-suspension for an unpaid plan: re-sends (or raises) the unpaid
 * invoice to the owner and starts the three-day clock.
 *
 * Superadmin only. A suspension is a billing decision, and moderating content
 * carries no authority over money — the same line `requireTeamPrincipal` draws.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const { id } = await context.params;
    const input = hostelSuspendSchema.parse(await request.json());
    const result = await startHostelSuspension(id, input, principal);

    return successResponse(
      result,
      result.notification.sent
        ? "Pre-suspension started"
        : "Pre-suspension started, but the owner could not be emailed",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Lifts it by hand. Paying in full lifts it without anyone calling this. */
export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const { id } = await context.params;
    const result = await liftPlatformHostelSuspension(id, principal);

    return successResponse(result, "Suspension lifted");
  } catch (error) {
    return handleRouteError(error);
  }
}
