import type { NextRequest } from "next/server";

import { requireTeamPrincipal } from "@/lib/api-auth";
import { handleRouteError, progressResponse, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { assertTeamRegistrationIsNew } from "@/modules/hostels/hostel.service";
import {
  listUnpublishedPrepayments,
  openTeamPrepayment,
  teamPrepaymentSchema,
} from "@/modules/team/team-prepayment.service";

export const runtime = "nodejs";

/**
 * *Pay online* on the team form's Plan & payment step: opens Softmato checkout
 * on the agent's device for the owner to scan, before the hostel is published.
 * Streams the hand-off's progress and ends with `{ checkoutUrl }`.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireTeamPrincipal(request);
    const input = teamPrepaymentSchema.parse(await request.json());

    /*
     * No money for a hostel that could never be published: the hard stops a
     * publish applies (same building, an email already in use) run first. The
     * soft "this owner has another hostel" question is left for the publish,
     * where the agent can answer it — it does not strand a payment.
     */
    await assertTeamRegistrationIsNew({
      applicant: { email: input.email || undefined, phone: input.phone },
      confirmSecondHostel: true,
      location: { area: input.area },
      name: input.hostelName,
    });

    return progressResponse(
      request,
      (step) => openTeamPrepayment(input, principal, step),
      "Checkout opened",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

/** The agent's paid hostels that are not published yet — the desk list. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireTeamPrincipal(request);

    return withEtag(request, successResponse({ prepayments: await listUnpublishedPrepayments(principal) }, "Paid, not published"));
  } catch (error) {
    return handleRouteError(error);
  }
}
