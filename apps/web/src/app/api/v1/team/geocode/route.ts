import type { NextRequest } from "next/server";

import { requireTeamPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { lookupLocation } from "@/modules/hostels/hostel-geocode.service";
import { hostelAdminGeocodeQuerySchema } from "@/modules/hostels/hostel.validation";

export const runtime = "nodejs";

/**
 * The same location lookup the hostel admin's profile picker uses, for the
 * registration desk.
 *
 * An agent is placing a pin on a hostel that does not exist yet, so there is no
 * hostel to check a capability against — the guard is their team membership.
 * Sharing the lookup rather than the route is what stops the agent's pin and the
 * owner's pin resolving through two different code paths.
 */
export async function GET(request: NextRequest) {
  try {
    await requireTeamPrincipal(request);
    const query = hostelAdminGeocodeQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );

    const result = await lookupLocation(query);

    return withEtag(request, successResponse(result, query.q ? "Location search complete" : "Address lookup complete"));
  } catch (error) {
    return handleRouteError(error);
  }
}
