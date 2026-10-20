import type { NextRequest } from "next/server";

import { requireHostelStaffPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { hostelCode } from "@/lib/hostel-code";
import { getBillingHistory } from "@/modules/billing/billing-history.service";
import { getSubscriptionState } from "@/modules/billing/subscription.service";

export const runtime = "nodejs";

/**
 * The hostel's own billing history — every invoice raised and every payment
 * received, with a link to each document.
 *
 * Scoped to the principal's first hostel rather than taking one from the query
 * string, exactly as the subscription endpoint next door is: accepting an id
 * would be an endpoint that hands one hostel's financial history to another
 * hostel's staff.
 *
 * Answers an empty history rather than 404 when there is no subscription. A
 * hostel that predates plan billing is not an error; it has nothing to show.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const hostelId = principal.hostelIds?.[0];

    if (!hostelId) {
      return withEtag(request, successResponse(
        { history: { docsUrl: null, invoices: [], payments: [] }, state: null },
        "No hostel in scope",
      ));
    }

    const [history, state] = await Promise.all([
      getBillingHistory(hostelId),
      getSubscriptionState(hostelId),
    ]);

    // The ID the pricing page's "Get plan" checkout asks for.
    return withEtag(request, successResponse({ history, hostelCode: hostelCode(hostelId), state }, "Billing loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
