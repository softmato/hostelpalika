import type { NextRequest } from "next/server";

import { requireHostelStaffPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getSubscriptionState } from "@/modules/billing/subscription.service";

export const runtime = "nodejs";

/**
 * The hostel's own plan state, for the due banner.
 *
 * Scoped to the principal's first hostel rather than taking one from the query
 * string: the banner has no hostel to ask about beyond the workspace the reader
 * is already in, and accepting an id would be an endpoint that hands one
 * hostel's balance to another hostel's staff.
 *
 * Answers `null` rather than 404 when there is no subscription — a hostel that
 * predates plan billing is not an error, it simply has nothing to show, and the
 * banner renders nothing.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const hostelId = principal.hostelIds?.[0];

    if (!hostelId) {
      return withEtag(request, successResponse({ state: null }, "No hostel in scope"));
    }

    return withEtag(request, successResponse(
      { state: await getSubscriptionState(hostelId) },
      "Subscription loaded",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}
