import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { resolveOwnedHostel } from "@/modules/billing/subscription-access";
import { startFreeMonths } from "@/modules/billing/subscription-payment.service";
import { getSubscriptionState, selectPlan } from "@/modules/billing/subscription.service";
import { registrationPlanChoiceSchema } from "@/modules/hostels/hostel-registration.validation";

type RouteContext = { params: Promise<{ hostelId: string }> };

export const runtime = "nodejs";

/**
 * Records the owner's plan choice.
 *
 * Deliberately **not** gated on verification. Choosing while the documents are
 * still being read is the point of the state — it means the moment verification
 * lands, paying is one click rather than a fresh decision. The verification
 * gate lives on the invoice route next door, where money actually starts.
 *
 * A hostel already verified goes live on the choice, on the plan's free months
 * — unless the building has had them, and then it pays as before.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireApiPrincipal(request);
    const { hostelId } = await context.params;

    const hostel = await resolveOwnedHostel(hostelId, principal.userId);

    const input = registrationPlanChoiceSchema.parse(await request.json());
    let state = await selectPlan(hostelId, input, principal.userId);

    if (hostel.verificationStatus === "VERIFIED" && (await startFreeMonths(hostelId, principal.userId))) {
      state = await getSubscriptionState(hostelId);
    }

    return successResponse({ state }, "Plan selected");
  } catch (error) {
    return handleRouteError(error);
  }
}
