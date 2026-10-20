import type { NextRequest } from "next/server";

import { requireTeamPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { registerTeamHostelApplication } from "@/modules/hostels/hostel.service";
import { teamHostelRegistrationSchema } from "@/modules/hostels/hostel-registration.validation";
import { listAgentRegistrations } from "@/modules/team/team.service";
import { UserModel } from "@hostel/db/models/User";

export const runtime = "nodejs";

/** The hostels this agent has filed. Scoped to them by their own principal. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireTeamPrincipal(request);
    const result = await listAgentRegistrations(principal.userId);

    return withEtag(request, successResponse(result, "Registrations loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Files a hostel and publishes it immediately.
 *
 * The agent's identity comes from the session, never the body: attribution is
 * the whole point of the team roster, and an agent who could name a colleague
 * as the filer could hand off both the credit and the cash accountability.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireTeamPrincipal(request);
    const input = teamHostelRegistrationSchema.parse(await request.json());

    const agent = await UserModel.findById(principal.userId)
      .select("name")
      .lean<{ name?: string } | null>();

    const result = await registerTeamHostelApplication(input, {
      name: agent?.name,
      role: principal.role,
      userId: principal.userId,
    });

    return successResponse(result, "Hostel registered and published", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
