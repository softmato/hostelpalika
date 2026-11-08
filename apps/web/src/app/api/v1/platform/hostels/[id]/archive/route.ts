import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { archivePlatformHostel } from "@/modules/hostels/hostel.service";
import { hostelArchiveSchema } from "@/lib/hostels/hostel.validation";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";

/**
 * Archive a hostel: off the public site and out of its own portal immediately,
 * recoverable for 60 days, then erased by the `hostel-purge` cron.
 *
 * Superadmin only, unlike the review actions beside it. A platform moderator
 * moderates listings — approving, rejecting, unpublishing. Ending a tenant and
 * starting the clock on its data is not moderation.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const { id } = await context.params;
    const input = hostelArchiveSchema.parse(await request.json());
    const result = await archivePlatformHostel(id, input, principal);

    return successResponse(
      result,
      result.sessionsRevoked > 0
        ? `Hostel archived, and ${result.sessionsRevoked} session${result.sessionsRevoked === 1 ? "" : "s"} signed out`
        : "Hostel archived",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
